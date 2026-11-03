import os
import json
from helpers.cors import get_cors_headers
import logging
import boto3
from uuid import uuid4

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ["REGION"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
SCHEDULER_TARGET_ARN = os.environ["SCHEDULER_TARGET_ARN"]

MAX_TOTAL_DATA_SOURCES = 5
RESERVED_NON_WEB_DATA_SOURCES = 1
MAX_WEB_DATA_SOURCES = MAX_TOTAL_DATA_SOURCES - RESERVED_NON_WEB_DATA_SOURCES
WEBSITE_BATCH_SIZE = 5
LOW_REMAINING_PAGES_THRESHOLD = 5000

# Bedrock rejects a web crawler update with more than 100 seed URLs, or with seed URLs whose
# combined length is 3,000 characters or more ("must be less than 3000 characters").
# https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_UrlConfiguration.html
MAX_SEED_URLS = 100
MAX_SEED_URL_CHARS = 2999

# Since September 30, 2026, new Web Crawler connectors cannot be created on customer-managed
# knowledge bases; existing ones keep working. Websites that do not fit the existing crawler
# are marked failed instead of waiting for a crawler that can never be created.
# https://docs.aws.amazon.com/bedrock/latest/userguide/webcrawl-data-source-connector.html
NEW_WEB_CRAWLERS_SUPPORTED = False
WEB_CRAWLER_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/webcrawl-data-source-connector.html"

SYNCING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}
FAILED_STATUSES = {"FAILED"}
SUCCESS_STATUSES = {"COMPLETE"}

# AWS Clients
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)

def _response(event, status_code: int, body: dict):
    """Build a standard API Gateway JSON response with CORS headers"""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


def _list_all_data_sources(knowledge_base_id: str) -> list[dict]:
    """
    Fetch every Bedrock data source attached to the knowledge base.
    Pagination is handled so the caller always receives the full list.
    """
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_data_sources(**kwargs)
        items.extend(resp.get("dataSourceSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _get_data_source(knowledge_base_id: str, data_source_id: str) -> dict:
    """Fetch the full Bedrock configuration for a specific data source"""
    resp = bedrock_agent.get_data_source(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
    )
    return resp["dataSource"]


def _list_all_ingestion_jobs(knowledge_base_id: str, data_source_id: str) -> list[dict]:
    """
    Fetch all ingestion job summaries for a Bedrock data source.
    Pagination is handled so capacity decisions can be based on the full job history.
    """
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "dataSourceId": data_source_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_ingestion_jobs(**kwargs)
        items.extend(resp.get("ingestionJobSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _sort_jobs_latest_first(jobs: list[dict]) -> list[dict]:
    """Sort ingestion jobs by most recent update/start/create timestamp first"""
    return sorted(
        jobs,
        key=lambda j: j.get("updatedAt") or j.get("startedAt") or j.get("createdAt"),
        reverse=True,
    )


def _get_latest_ingestion_job(knowledge_base_id: str, data_source_id: str) -> dict | None:
    """Return the most recent ingestion job for a Bedrock data source, if one exists"""
    jobs = _list_all_ingestion_jobs(knowledge_base_id, data_source_id)
    if not jobs:
        return None
    return _sort_jobs_latest_first(jobs)[0]


def _is_web_data_source(data_source: dict) -> bool:
    """Return True when the Bedrock data source is configured as a web crawler"""
    return data_source.get("dataSourceConfiguration", {}).get("type") == "WEB"


def _get_seed_urls(data_source: dict) -> list[str]:
    """Extract the current list of seed URLs from a Bedrock web crawler data source"""
    seed_url_objs = (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("sourceConfiguration", {})
        .get("urlConfiguration", {})
        .get("seedUrls", [])
    )
    return [x.get("url") for x in seed_url_objs if x.get("url")]


def _get_max_pages(data_source: dict) -> int:
    """Read the crawler maxPages limit from the Bedrock web crawler configuration"""
    return (
        data_source.get("dataSourceConfiguration", {})
        .get("webConfiguration", {})
        .get("crawlerConfiguration", {})
        .get("crawlerLimits", {})
        .get("maxPages", 25000)
    )


def _latest_failure_reasons(latest_job: dict | None) -> list[str]:
    """Extract the failure reasons from the latest Bedrock ingestion job, if present"""
    if not latest_job:
        return []
    return latest_job.get("failureReasons", []) or []


def _looks_like_capacity_failure(failure_reasons: list[str]) -> bool:
    """
    Detect whether a Bedrock job failure looks like a page-capacity/max-pages failure.
    This is used to treat a crawler as full and avoid selecting it again.
    """
    combined = " ".join(failure_reasons).lower()
    keywords = [
        "maxpages",
        "max pages",
        "25,000",
        "25000",
        "page limit",
        "crawl limit",
        "exceeded",
        "too many pages",
        "max capacity",
        "capacity reached",
    ]
    return any(k in combined for k in keywords)


def _get_documents_scanned(latest_job: dict | None) -> int:
    """Extract the number of documents/pages scanned from the latest Bedrock job"""
    if not latest_job:
        return 0
    stats = latest_job.get("statistics", {}) or {}
    return stats.get("numberOfDocumentsScanned", 0) or 0


def _classify_data_source(data_source: dict, latest_job: dict | None) -> dict:
    """
    Classify a web crawler as available, syncing, or full.

    A crawler is treated as full when:
    - its latest job failed with a capacity-like error, or
    - its scanned page count has reached maxPages

    Otherwise it remains available unless a sync is currently in progress.
    """
    data_source_id = data_source["dataSourceId"]
    seed_urls = _get_seed_urls(data_source)
    max_pages = _get_max_pages(data_source)
    scanned = _get_documents_scanned(latest_job)
    status = latest_job.get("status") if latest_job else None
    failure_reasons = _latest_failure_reasons(latest_job)

    remaining_pages = max(max_pages - scanned, 0)

    if status in SYNCING_STATUSES:
        state = "syncing"
    elif status in FAILED_STATUSES and _looks_like_capacity_failure(failure_reasons):
        state = "full"
    elif scanned >= max_pages:
        state = "full"
    else:
        state = "available"

    return {
        "data_source_id": data_source_id,
        "name": data_source.get("name"),
        "state": state,
        "seed_urls": seed_urls,
        "max_pages": max_pages,
        "documents_scanned": scanned,
        "remaining_pages": remaining_pages,
        "latest_ingestion_job": latest_job,
        "failure_reasons": failure_reasons,
        "data_source": data_source,
    }


def _select_best_available(classified: list[dict]) -> dict | None:
    """
    Choose the best available web crawler for the next batch.
    Preference is given to the crawler with the most remaining pages.
    """
    candidates = [x for x in classified if x["state"] == "available"]
    if not candidates:
        return None

    return sorted(candidates, key=lambda x: x["remaining_pages"], reverse=True)[0]


def _latest_run_rows_by_status(connection, *, status: str, data_source_type: str) -> list[dict]:
    """
    Return the latest ingestion run per website data source filtered by status.

    For the website phase this is used to collect the currently queued website
    sources that are waiting to be assigned to a crawler batch.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            SELECT
                lr.id,
                lr.data_source_id,
                lr.status,
                lr.metadata,
                ds.name,
                ds.type,
                ds.include_patterns,
                ds.exclude_patterns,
                ds.metadata
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE lr.rn = 1
              AND lr.status = %s::ingestion_status
              AND ds.type = %s::data_source_type
            ORDER BY ds.created_at ASC, ds.id ASC
            """,
            (status, data_source_type),
        )

        rows = cursor.fetchall()
        results = []
        for row in rows:
            results.append(
                {
                    "ingestion_run_id": str(row[0]),
                    "data_source_id": str(row[1]),
                    "status": row[2],
                    "ingestion_metadata": row[3] or {},
                    "name": row[4],
                    "type": row[5],
                    "include_patterns": row[6] or [],
                    "exclude_patterns": row[7] or [],
                    "data_source_metadata": row[8] or {},
                }
            )
        return results


def _group_key_for_website_run(run: dict) -> str:
    """
    Build a grouping key for websites based on include/exclude patterns.

    Websites are only batched together when they share the same crawler-level
    filter configuration.
    """
    return json.dumps(
        {
            "include_patterns": run["include_patterns"] or [],
            "exclude_patterns": run["exclude_patterns"] or [],
        },
        sort_keys=True,
    )


def _plan_website_batch(
    queued_websites: list[dict],
    batch_size: int,
    existing_seed_urls: list[str],
) -> tuple[list[dict], list[dict]]:
    """
    Select the next website batch for a crawler that already has existing_seed_urls.

    The batch starts from the oldest queued website that fits and only includes more
    websites that share its include/exclude patterns. A website fits when adding it keeps
    the crawler within MAX_SEED_URLS and MAX_SEED_URL_CHARS.

    Returns the batch and the queued websites that cannot fit. Capacity only shrinks as
    batches are added, so a website that does not fit now never will on this crawler.
    """
    existing = set(existing_seed_urls)
    remaining_count = MAX_SEED_URLS - len(existing)
    remaining_chars = MAX_SEED_URL_CHARS - sum(len(url) for url in existing)

    batch = []
    unfit = []
    group_key = None
    for run in queued_websites:
        url = run["name"]
        cost_count, cost_chars = (0, 0) if url in existing else (1, len(url))
        if cost_count > remaining_count or cost_chars > remaining_chars:
            unfit.append(run)
            continue

        if len(batch) >= batch_size:
            continue
        key = _group_key_for_website_run(run)
        if group_key is None:
            group_key = key
        if key != group_key:
            continue

        batch.append(run)
        existing.add(url)
        remaining_count -= cost_count
        remaining_chars -= cost_chars

    return batch, unfit


def _crawler_full_message(seed_urls: list[str]) -> str:
    """The error shown on a website that cannot be added to the web crawler"""
    return (
        "Not added: the web crawler is full. Bedrock allows at most "
        f"{MAX_SEED_URLS} seed URLs per web crawler with a combined length under "
        f"{MAX_SEED_URL_CHARS + 1:,} characters, and it has {len(seed_urls)} URLs totalling "
        f"{sum(len(url) for url in seed_urls):,} characters. New web crawlers can no longer "
        f"be created ({WEB_CRAWLER_DOCS_URL}). Remove websites from the crawler, use a "
        "shorter parent URL that covers several pages, or upload the page as a Markdown file."
    )


def _mark_runs_failed(connection, *, ingestion_run_ids: list[str], error_message: str):
    """Mark queued website runs failed so they stop waiting for crawler capacity"""
    if not ingestion_run_ids:
        return 0
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET
                status = 'failed'::ingestion_status,
                error_message = %s,
                completed_at = NOW()
            WHERE id = ANY(%s::uuid[])
              AND status = 'queued'::ingestion_status
            """,
            (error_message, ingestion_run_ids),
        )
        return cursor.rowcount


def _build_updated_web_config(data_source: dict, new_urls: list[str], include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    """
    Build an updated Bedrock web crawler configuration for an existing crawler.

    This appends new seed URLs and applies the effective include/exclude filters.
    """
    config = data_source["dataSourceConfiguration"]
    web_config = config["webConfiguration"]
    crawler_config = web_config["crawlerConfiguration"]
    source_config = web_config["sourceConfiguration"]

    existing_seed_urls = source_config.get("urlConfiguration", {}).get("seedUrls", [])
    existing_urls = [x["url"] for x in existing_seed_urls if "url" in x]

    for new_url in new_urls:
        if new_url not in existing_urls:
            existing_seed_urls.append({"url": new_url})

    updated_crawler_config = dict(crawler_config)

    effective_includes = list(dict.fromkeys(
        (crawler_config.get("inclusionFilters") or []) + (include_patterns or [])
    )) or None
    effective_excludes = list(dict.fromkeys(
        (crawler_config.get("exclusionFilters") or []) + (exclude_patterns or [])
    )) or None

    if effective_includes:
        updated_crawler_config["inclusionFilters"] = effective_includes
    else:
        updated_crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        updated_crawler_config["exclusionFilters"] = effective_excludes
    else:
        updated_crawler_config.pop("exclusionFilters", None)

    user_agent_header = updated_crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        updated_crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    updated_source_config = {
        **source_config,
        "urlConfiguration": {
            "seedUrls": existing_seed_urls
        }
    }

    return {
        "type": "WEB",
        "webConfiguration": {
            "crawlerConfiguration": updated_crawler_config,
            "sourceConfiguration": updated_source_config,
        },
    }


def _update_existing_web_data_source(data_source: dict, knowledge_base_id: str, new_urls: list[str], include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    """
    Update an existing Bedrock web crawler with new URLs and effective filters.
    This is used when an available crawler still has room for more websites.
    """
    updated_data_source_config = _build_updated_web_config(
        data_source=data_source,
        new_urls=new_urls,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    kwargs = {
        "knowledgeBaseId": knowledge_base_id,
        "dataSourceId": data_source["dataSourceId"],
        "name": data_source["name"],
        "dataSourceConfiguration": updated_data_source_config,
        "vectorIngestionConfiguration": data_source["vectorIngestionConfiguration"],
    }

    if data_source.get("description"):
        kwargs["description"] = data_source["description"]

    if data_source.get("dataDeletionPolicy"):
        kwargs["dataDeletionPolicy"] = data_source["dataDeletionPolicy"]

    if data_source.get("serverSideEncryptionConfiguration"):
        kwargs["serverSideEncryptionConfiguration"] = data_source["serverSideEncryptionConfiguration"]

    logger.info(
        "Updating data source %s with crawlerConfiguration=%s",
        data_source["dataSourceId"],
        json.dumps(updated_data_source_config["webConfiguration"]["crawlerConfiguration"])
    )

    resp = bedrock_agent.update_data_source(**kwargs)
    return resp["dataSource"]


def _build_new_web_data_source_payload(template_data_source: dict, new_urls: list[str], include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    """
    Build the payload for a brand new Bedrock web crawler data source.

    The new crawler inherits the template crawler configuration and applies
    the website batch's effective seed URLs and filters.
    """
    template_config = template_data_source["dataSourceConfiguration"]
    template_web = template_config["webConfiguration"]
    template_crawler = template_web["crawlerConfiguration"]

    crawler_config = dict(template_crawler)

    effective_includes = include_patterns if include_patterns else template_crawler.get("inclusionFilters")
    effective_excludes = exclude_patterns if exclude_patterns else template_crawler.get("exclusionFilters")

    if effective_includes:
        crawler_config["inclusionFilters"] = effective_includes
    else:
        crawler_config.pop("inclusionFilters", None)

    if effective_excludes:
        crawler_config["exclusionFilters"] = effective_excludes
    else:
        crawler_config.pop("exclusionFilters", None)

    user_agent_header = crawler_config.get("userAgentHeader")
    if user_agent_header and len(user_agent_header) < 61:
        crawler_config["userAgentHeader"] = (
            "Mozilla/5.0 (compatible; SpecExKnowledgeBaseCrawler/1.0; +https://example.com/bot)"
        )

    return {
        "name": f"web-crawler-{uuid4().hex[:8]}",
        "dataSourceConfiguration": {
            "type": "WEB",
            "webConfiguration": {
                "crawlerConfiguration": crawler_config,
                "sourceConfiguration": {
                    "urlConfiguration": {
                        "seedUrls": [{"url": url} for url in new_urls]
                    }
                },
            },
        },
        "vectorIngestionConfiguration": template_data_source["vectorIngestionConfiguration"],
    }


def _create_new_web_data_source(template_data_source: dict, knowledge_base_id: str, new_urls: list[str], include_patterns: list[str], exclude_patterns: list[str]) -> dict:
    """
    Create a brand new Bedrock web crawler data source from an existing template.
    This is used when no existing crawler can safely accept the next website batch.
    """
    payload = _build_new_web_data_source_payload(
        template_data_source=template_data_source,
        new_urls=new_urls,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
    )

    resp = bedrock_agent.create_data_source(
        knowledgeBaseId=knowledge_base_id,
        name=payload["name"],
        dataSourceConfiguration=payload["dataSourceConfiguration"],
        vectorIngestionConfiguration=payload["vectorIngestionConfiguration"],
        description=f"Auto-created web crawler for {', '.join(new_urls[:2])}",
    )
    return resp["dataSource"]


def _start_ingestion(knowledge_base_id: str, data_source_id: str) -> dict:
    """
    Start a Bedrock ingestion job for the selected web crawler data source.
    This kicks off crawling and ingestion for the chosen website batch.
    """
    resp = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
        description="Triggered by queued website batch sync",
    )
    return resp["ingestionJob"]


def _create_ingestion_polling_schedule(
    *,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    bedrock_ingestion_job_id: str,
    db_ingestion_run_ids: list[str],
    sync_session_id: str,
) -> str:
    """
    Create the 10-minute scheduler that polls the website ingestion job.

    The scheduler payload carries the sync session ID and the database run IDs
    so update_status can later update all affected website runs together.
    """
    schedule_name = f"kb-web-{sync_session_id}-{uuid4().hex[:8]}"

    payload = {
        "task": "poll_ingestion_run",
        "phase": "website",
        "knowledge_base_id": knowledge_base_id,
        "bedrock_data_source_id": bedrock_data_source_id,
        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
        "db_ingestion_run_ids": db_ingestion_run_ids,
        "sync_session_id": sync_session_id,
        "schedule_name": schedule_name,
    }

    scheduler_client.create_schedule(
        Name=schedule_name,
        GroupName="default",
        # A web crawl takes at least ~5 minutes, so polling more often than 10 minutes rarely
        # finds it done sooner, and 10 minutes stays well above the Lambda's 300 s timeout.
        ScheduleExpression="rate(10 minutes)",
        FlexibleTimeWindow={"Mode": "OFF"},
        State="ENABLED",
        Target={
            "Arn": SCHEDULER_TARGET_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        Description=f"Poll website ingestion job {bedrock_ingestion_job_id} for sync session {sync_session_id}",
    )

    return schedule_name


def _mark_runs_running(
    connection,
    *,
    ingestion_run_ids: list[str],
    bedrock_ingestion_job_id: str,
    sync_session_id: str,
    schedule_name: str,
):
    """
    Mark the selected website ingestion runs as running.

    The metadata is updated with the current sync session, Bedrock ingestion
    job ID, scheduler name, and phase so later polling can resume correctly.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET
                status = 'running'::ingestion_status,
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = ANY(%s::uuid[])
            """,
            (
                json.dumps(
                    {
                        "phase": "website",
                        "sync_session_id": sync_session_id,
                        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                        "schedule_name": schedule_name,
                    }
                ),
                ingestion_run_ids,
            ),
        )


def process_website_batch(event, connection, kb_id, sync_session_id: str, triggered_by_scheduler: bool = False):
    """
    Start the website phase for the current sync session.

    This method:
    - fetches all Bedrock web crawlers in the knowledge base
    - classifies them by availability and remaining page capacity
    - picks the best available crawler, if one exists
    - decides batch size:
      - 1 when the crawler is near the low remaining-pages threshold
      - otherwise up to 5
    - selects the next queued website batch with compatible filters that fits the
      crawler's seed URL limits, and marks queued websites that cannot fit as failed
    - updates an existing crawler or creates a new one
    - starts the Bedrock ingestion job
    - creates the 10-minute polling scheduler
    - marks the selected database runs as running

    It returns a structured result describing whether the phase started and
    which run IDs and URLs were attached to it.
    """
    all_data_sources = _list_all_data_sources(kb_id)

    web_crawlers = []
    for summary in all_data_sources:
        data_source = _get_data_source(kb_id, summary["dataSourceId"])
        if _is_web_data_source(data_source):
            web_crawlers.append(data_source)

    if not web_crawlers:
        return {
            "started": False,
            "phase": "website",
            "error": "No existing web crawler template found.",
        }

    classified = []
    for data_source in web_crawlers:
        latest_job = _get_latest_ingestion_job(kb_id, data_source["dataSourceId"])
        classified.append(_classify_data_source(data_source, latest_job))

    selected = _select_best_available(classified)

    if selected:
        if selected["remaining_pages"] <= LOW_REMAINING_PAGES_THRESHOLD:
            batch_size = 1
        else:
            batch_size = WEBSITE_BATCH_SIZE
    else:
        batch_size = WEBSITE_BATCH_SIZE

    queued_websites = _latest_run_rows_by_status(
        connection,
        status="queued",
        data_source_type="website",
    )
    if not queued_websites:
        return {
            "started": False,
            "phase": "website",
            "message": "No queued website runs found.",
        }

    can_create_crawler = NEW_WEB_CRAWLERS_SUPPORTED and len(web_crawlers) < MAX_WEB_DATA_SOURCES

    if selected:
        seed_urls = selected["seed_urls"]
    elif can_create_crawler:
        seed_urls = []
    elif any(x["state"] == "syncing" for x in classified):
        # The crawler is busy with another job; the running sync picks these up afterwards
        return {
            "started": False,
            "phase": "website",
            "message": "The web crawler is busy; queued websites will be added after its current job.",
        }
    else:
        # Every crawler has reached its page limit and no new one can be created
        error_message = (
            "Not added: the web crawler has reached its page limit and new web crawlers "
            f"can no longer be created ({WEB_CRAWLER_DOCS_URL})."
        )
        failed_count = _mark_runs_failed(
            connection,
            ingestion_run_ids=[x["ingestion_run_id"] for x in queued_websites],
            error_message=error_message,
        )
        connection.commit()
        return {
            "started": False,
            "phase": "website",
            "failed_count": failed_count,
            "message": f"{failed_count} queued websites could not be added: {error_message}",
        }

    batch, unfit = _plan_website_batch(queued_websites, batch_size, seed_urls)

    failed_count = 0
    if unfit and not (selected and can_create_crawler):
        failed_count = _mark_runs_failed(
            connection,
            ingestion_run_ids=[x["ingestion_run_id"] for x in unfit],
            error_message=_crawler_full_message(seed_urls),
        )
        connection.commit()
        logger.warning("Marked %d queued websites failed: web crawler is full", failed_count)

    if not batch:
        if failed_count:
            return {
                "started": False,
                "phase": "website",
                "failed_count": failed_count,
                "message": f"{failed_count} queued websites could not be added because the web crawler is full.",
            }
        return {
            "started": False,
            "phase": "website",
            "message": "No queued website fits the web crawler.",
        }

    urls = [x["name"] for x in batch]
    include_patterns = batch[0]["include_patterns"] or []
    exclude_patterns = batch[0]["exclude_patterns"] or []
    ingestion_run_ids = [x["ingestion_run_id"] for x in batch]

    if selected:
        try:
            target_data_source = _update_existing_web_data_source(
                data_source=selected["data_source"],
                knowledge_base_id=kb_id,
                new_urls=urls,
                include_patterns=include_patterns,
                exclude_patterns=exclude_patterns,
            )
        except bedrock_agent.exceptions.ValidationException as e:
            # Bedrock rejected the new configuration (for example a limit this code does not
            # check). Fail the batch with Bedrock's reason so it does not stay queued forever.
            error_message = f"Not added: Bedrock rejected the web crawler update. {e}"
            failed_count += _mark_runs_failed(
                connection,
                ingestion_run_ids=ingestion_run_ids,
                error_message=error_message,
            )
            connection.commit()
            logger.error("Web crawler update rejected for %s: %s", urls, e)
            return {
                "started": False,
                "phase": "website",
                "failed_count": failed_count,
                "message": f"{failed_count} queued websites could not be added: {error_message}",
            }
        action = "updated_existing_web_data_source"
    else:
        if len(web_crawlers) >= MAX_WEB_DATA_SOURCES:
            return {
                "started": False,
                "phase": "website",
                "error": "No available web crawler capacity for queued websites.",
            }

        template_data_source = web_crawlers[0]
        target_data_source = _create_new_web_data_source(
            template_data_source=template_data_source,
            knowledge_base_id=kb_id,
            new_urls=urls,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
        )
        action = "created_new_web_data_source"

    ingestion_job = _start_ingestion(kb_id, target_data_source["dataSourceId"])

    schedule_name = _create_ingestion_polling_schedule(
        knowledge_base_id=kb_id,
        bedrock_data_source_id=target_data_source["dataSourceId"],
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        db_ingestion_run_ids=ingestion_run_ids,
        sync_session_id=sync_session_id,
    )

    _mark_runs_running(
        connection,
        ingestion_run_ids=ingestion_run_ids,
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        sync_session_id=sync_session_id,
        schedule_name=schedule_name,
    )
    connection.commit()

    return {
        "started": True,
        "phase": "website",
        "triggered_by_scheduler": triggered_by_scheduler,
        "sync_session_id": sync_session_id,
        "queued_count": len(batch),
        "batch_size_used": batch_size,
        "remaining_pages_before_sync": selected["remaining_pages"] if selected else None,
        "action": action,
        "bedrock_data_source_id": target_data_source["dataSourceId"],
        "bedrock_data_source_name": target_data_source["name"],
        "bedrock_ingestion_job_id": ingestion_job["ingestionJobId"],
        "schedule_name": schedule_name,
        "db_ingestion_run_ids": ingestion_run_ids,
        "urls": urls,
    }
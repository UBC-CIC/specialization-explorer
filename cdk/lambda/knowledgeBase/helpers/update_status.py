import os
import re
import json
import time
from helpers.cors import get_cors_headers
import logging
import boto3

from helpers.process_s3_batch import process_s3_batch
from helpers.process_website_batch import process_website_batch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
REGION = os.environ["REGION"]
METRICS_NAMESPACE = os.environ.get("METRICS_NAMESPACE", "SpecEx/KnowledgeBase")

S3_URI_PATTERN = re.compile(r"s3://[^\s,;\]\)\"']+")
WEB_URL_PATTERN = re.compile(r"https?://[^\s,;\]\)\"']+")

# AWS Clients
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)

RUNNING_STATUSES = {"STARTING", "IN_PROGRESS", "STOPPING"}

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

def _normalize_status(bedrock_status: str | None) -> str | None:
    """
    Convert a Bedrock ingestion status into the internal ingestion_runs status.

    Supported mappings:
    - COMPLETE -> completed
    - FAILED -> failed
    - STARTING / IN_PROGRESS / STOPPING -> running
    """
    if bedrock_status == "COMPLETE":
        return "completed"
    if bedrock_status == "FAILED":
        return "failed"
    if bedrock_status in RUNNING_STATUSES:
        return "running"
    return None

def _looks_like_capacity_failure(failure_reasons: list[str]) -> bool:
    """
    Detect whether a Bedrock failure looks like a capacity/max-pages failure.

    This is used to decide when a single failed website should be removed from
    a full crawler and retried on a different crawler.
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

def _update_ingestion_runs(connection, *, ingestion_run_ids: list[str], status: str, error_message: str | None):
    """
    Update one or more ingestion_runs rows to the supplied status.

    Terminal statuses (completed, failed) also set completed_at so the admin
    dashboard can show when the run finished.
    """
    with connection.cursor() as cursor:
        if status in {"completed", "failed"}:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s,
                    completed_at = NOW()
                WHERE id = ANY(%s::uuid[])
                """,
                (status, error_message, ingestion_run_ids),
            )
        else:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET
                    status = %s::ingestion_status,
                    error_message = %s
                WHERE id = ANY(%s::uuid[])
                """,
                (status, error_message, ingestion_run_ids),
            )

        return cursor.rowcount

def _emit_ingestion_metrics(*, phase: str, failed_documents: int, job_failed: bool):
    """
    Publishes FailedDocuments and FailedIngestionJobs through CloudWatch Embedded Metric Format.
    A Bedrock ingestion job can finish as COMPLETE while some documents failed, so documents
    are counted separately from failed jobs. Alarms in the API stack watch both metrics.
    https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    """
    print(json.dumps({
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": METRICS_NAMESPACE,
                "Dimensions": [[]],
                "Metrics": [
                    {"Name": "FailedDocuments", "Unit": "Count"},
                    {"Name": "FailedIngestionJobs", "Unit": "Count"},
                ],
            }],
        },
        "FailedDocuments": failed_documents,
        "FailedIngestionJobs": 1 if job_failed else 0,
        "phase": phase,
    }))


def _split_failure_reasons(failure_reasons: list[str]) -> list[str]:
    """
    Bedrock often returns one failure reason that is itself a JSON array of messages
    (e.g. '["Skipped document: ...", "The server encountered an internal error..."]').
    Split those so each message can be matched to a run on its own.
    """
    messages = []
    for reason in failure_reasons:
        try:
            parsed = json.loads(reason)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, list) and all(isinstance(x, str) for x in parsed):
            messages.extend(parsed)
        else:
            messages.append(reason)
    return messages


def _normalize_url(url: str) -> str:
    """Compare URLs without the sentence punctuation or trailing slash around them"""
    return url.rstrip(".").rstrip("/")


def _run_sources(connection, *, ingestion_run_ids: list[str]) -> dict[str, dict]:
    """
    What each ingestion run ingested: the S3 objects for file sources (split CSVs have
    parts), or the seed URL for website sources.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT ir.id, ds.type::text, ds.name, ds.metadata
            FROM ingestion_runs ir
            JOIN data_sources ds ON ds.id = ir.data_source_id
            WHERE ir.id = ANY(%s::uuid[])
            """,
            (ingestion_run_ids,),
        )
        rows = cursor.fetchall()

    sources = {}
    for run_id, source_type, name, metadata in rows:
        metadata = metadata or {}
        bucket = metadata.get("s3_bucket")
        keys = metadata.get("s3_part_keys") or [metadata.get("s3_key")]
        sources[str(run_id)] = {
            "s3_uris": {f"s3://{bucket}/{key}" for key in keys if bucket and key},
            "website": _normalize_url(name) if source_type == "website" and name else None,
        }
    return sources


def _website_run_for_url(url: str, seeds: dict[str, str]) -> str | None:
    """
    The website run whose crawl covers a URL. The crawler's default scope is the seed URL
    and the pages under its path, so the most specific seed that is a prefix wins.
    https://docs.aws.amazon.com/bedrock/latest/userguide/webcrawl-data-source-connector.html
    """
    best_run, best_len = None, -1
    for run_id, seed in seeds.items():
        if (url == seed or url.startswith(seed + "/")) and len(seed) > best_len:
            best_run, best_len = run_id, len(seed)
    return best_run


def _attribute_document_failures(
    connection, *, ingestion_run_ids: list[str], failure_reasons: list[str]
) -> tuple[dict[str, dict], list[str], int]:
    """
    Matches document-level failure reasons to ingestion runs by the S3 URIs or web URLs
    they name.

    Returns:
    - per run: its reasons, and whether the run itself failed. A file run fails when its
      file is named. A website run fails only when its seed page is named; a failed page
      under the seed leaves the run completed with errors.
    - the reasons that name no run in this batch. A website job re-crawls every seed on
      the crawler, so these include failures of seeds from earlier batches.
    - how many distinct documents the reasons named, matched to this batch or not
    """
    sources = _run_sources(connection, ingestion_run_ids=ingestion_run_ids)
    seeds = {run_id: s["website"] for run_id, s in sources.items() if s["website"]}

    attributed = {}
    unmatched = []
    named_documents = set()
    for reason in _split_failure_reasons(failure_reasons):
        matched_runs = {}

        named_uris = {uri.rstrip(".") for uri in S3_URI_PATTERN.findall(reason)}
        named_documents.update(named_uris)
        for run_id, source in sources.items():
            if source["s3_uris"] & named_uris:
                matched_runs[run_id] = True

        # The first web URL is the document ("Skipped document: <url>. ..."); later URLs
        # are links to AWS documentation inside the message
        web_urls = WEB_URL_PATTERN.findall(reason) if not named_uris else []
        if web_urls:
            url = _normalize_url(web_urls[0])
            named_documents.add(url)
            run_id = _website_run_for_url(url, seeds)
            if run_id:
                matched_runs[run_id] = url == seeds[run_id]

        if not matched_runs:
            unmatched.append(reason)
        for run_id, run_failed in matched_runs.items():
            entry = attributed.setdefault(run_id, {"reasons": [], "failed": False})
            entry["reasons"].append(reason)
            entry["failed"] = entry["failed"] or run_failed
    return attributed, unmatched, len(named_documents)


def _get_run_rows(connection, *, ingestion_run_ids: list[str]) -> list[dict]:
    """
    Fetch the ingestion_runs rows for the supplied IDs.

    This is used during retry handling so the failed website run can be linked
    back to its original data_source row.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, data_source_id, status, metadata
            FROM ingestion_runs
            WHERE id = ANY(%s::uuid[])
            ORDER BY created_at ASC, id ASC
            """,
            (ingestion_run_ids,),
        )
        rows = cursor.fetchall()

        results = []
        for row in rows:
            results.append(
                {
                    "id": str(row[0]),
                    "data_source_id": str(row[1]),
                    "status": row[2],
                    "metadata": row[3] or {},
                }
            )
        return results


def _get_data_source_row(connection, *, data_source_id: str) -> dict | None:
    """
    Fetch a data_sources row by ID.

    For website retries this is used to recover the website URL from the
    original staged website record.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, type, metadata
            FROM data_sources
            WHERE id = %s::uuid
            LIMIT 1
            """,
            (data_source_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None

        return {
            "id": str(row[0]),
            "name": row[1],
            "type": row[2],
            "metadata": row[3] or {},
        }


def _get_bedrock_data_source(knowledge_base_id: str, bedrock_data_source_id: str) -> dict:
    """Fetch the full Bedrock data source configuration for a crawler"""
    resp = bedrock_agent.get_data_source(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=bedrock_data_source_id,
    )
    return resp["dataSource"]


def _remove_seed_url_from_bedrock_web_data_source(
    *,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    website_url: str,
) -> dict:
    """
    Remove a website URL from a Bedrock web crawler's seed URL list.

    This is used when a single-website batch fails because the crawler is full.
    The website is removed from the full crawler before being retried elsewhere.
    """
    data_source = _get_bedrock_data_source(knowledge_base_id, bedrock_data_source_id)

    config = data_source["dataSourceConfiguration"]
    web_config = config["webConfiguration"]
    crawler_config = web_config["crawlerConfiguration"]
    source_config = web_config["sourceConfiguration"]

    existing_seed_urls = source_config.get("urlConfiguration", {}).get("seedUrls", [])
    filtered_seed_urls = [x for x in existing_seed_urls if x.get("url") != website_url]

    updated_source_config = {
        **source_config,
        "urlConfiguration": {
            "seedUrls": filtered_seed_urls
        }
    }

    updated_data_source_config = {
        "type": "WEB",
        "webConfiguration": {
            "crawlerConfiguration": dict(crawler_config),
            "sourceConfiguration": updated_source_config,
        },
    }

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
        "Removing failed website URL %s from Bedrock data source %s before retry",
        website_url,
        bedrock_data_source_id,
    )

    resp = bedrock_agent.update_data_source(**kwargs)
    return resp["dataSource"]

def _insert_retry_ingestion_run(
    connection,
    *,
    data_source_id: str,
    sync_session_id: str,
    retry_of_ingestion_run_id: str,
) -> str:
    """
    Create a new queued ingestion_run for a website retry.

    The original failed run is preserved for history, while the new run becomes
    the retriable queued record for the same website data source.
    """
    metadata = {
        "phase": "website",
        "sync_session_id": sync_session_id,
        "retry_of_ingestion_run_id": retry_of_ingestion_run_id,
        "action": "retry_after_capacity_failure",
    }

    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, 'queued'::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_id,
                json.dumps(metadata),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _delete_schedule(schedule_name: str):
    """Delete the polling scheduler once the current ingestion job is no longer running"""
    scheduler_client.delete_schedule(
        Name=schedule_name,
        GroupName="default",
    )

def update_status(event, connection):
    """
    Poll the status of a Bedrock ingestion job and advance the sync workflow.

    This method:
    - validates the scheduler payload
    - fetches the current Bedrock ingestion job status
    - updates the corresponding ingestion_runs rows
    - deletes the polling scheduler when the job reaches a terminal state
    - handles single-website capacity retries by:
      - removing the website from the full crawler
      - creating a new queued retry run
    - continues the sync workflow by calling:
      - process_website_batch(...) after S3 completion
      - process_website_batch(...) after website completion
      - process_website_batch(...) after a single-website capacity retry
    """
    logger.info("Scheduler polling event: %s", json.dumps(event))

    kb_id = event.get("knowledge_base_id")
    phase = event.get("phase")
    sync_session_id = event.get("sync_session_id")
    bedrock_data_source_id = event.get("bedrock_data_source_id")
    bedrock_ingestion_job_id = event.get("bedrock_ingestion_job_id")
    db_ingestion_run_ids = event.get("db_ingestion_run_ids")
    schedule_name = event.get("schedule_name")

    if not isinstance(db_ingestion_run_ids, list) or not db_ingestion_run_ids:
        single_id = event.get("db_ingestion_run_id")
        if single_id:
            db_ingestion_run_ids = [single_id]

    if (
        not kb_id
        or not phase
        or not sync_session_id
        or not bedrock_data_source_id
        or not bedrock_ingestion_job_id
        or not db_ingestion_run_ids
        or not schedule_name
    ):
        return _response(
            event,
            400,
            {
                "error": "Missing required scheduler payload fields",
                "received": {
                    "knowledge_base_id": kb_id,
                    "phase": phase,
                    "sync_session_id": sync_session_id,
                    "bedrock_data_source_id": bedrock_data_source_id,
                    "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                    "db_ingestion_run_ids": db_ingestion_run_ids,
                    "schedule_name": schedule_name,
                },
            },
        )

    resp = bedrock_agent.get_ingestion_job(
        knowledgeBaseId=kb_id,
        dataSourceId=bedrock_data_source_id,
        ingestionJobId=bedrock_ingestion_job_id,
    )
    ingestion_job = resp.get("ingestionJob", {})
    bedrock_status = ingestion_job.get("status")
    failure_reasons = ingestion_job.get("failureReasons", []) or []
    failed_document_count = (ingestion_job.get("statistics") or {}).get("numberOfDocumentsFailed", 0) or 0

    logger.info(
        "Polled ingestion job: kb_id=%s phase=%s sync_session_id=%s data_source_id=%s ingestion_job_id=%s status=%s",
        kb_id,
        phase,
        sync_session_id,
        bedrock_data_source_id,
        bedrock_ingestion_job_id,
        bedrock_status,
    )

    normalized_status = _normalize_status(bedrock_status)
    if not normalized_status:
        return _response(
            event,
            200,
            {
                "message": "Unsupported or unknown Bedrock ingestion status",
                "phase": phase,
                "sync_session_id": sync_session_id,
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    if normalized_status == "running":
        return _response(
            event,
            200,
            {
                "message": "Ingestion job still running",
                "phase": phase,
                "sync_session_id": sync_session_id,
                "bedrock_status": bedrock_status,
                "ingestion_job_id": bedrock_ingestion_job_id,
            },
        )

    error_message = "; ".join(failure_reasons) if failure_reasons else None

    if normalized_status == "failed" or failed_document_count:
        logger.warning(
            "Ingestion job %s finished as %s with %d failed documents: %s",
            bedrock_ingestion_job_id,
            bedrock_status,
            failed_document_count,
            error_message,
        )
    _emit_ingestion_metrics(
        phase=phase,
        failed_documents=failed_document_count,
        job_failed=normalized_status == "failed",
    )

    retry_created_run_ids = []
    next_step = None

    try:
        # A COMPLETE job can still have failed documents. Each reason goes only to the run whose
        # file or website it names, so one bad page does not mark the whole batch with errors.
        attributed_runs = {}
        if normalized_status == "completed" and (failed_document_count or failure_reasons):
            attributed_runs, unmatched_reasons, named_document_count = _attribute_document_failures(
                connection,
                ingestion_run_ids=db_ingestion_run_ids,
                failure_reasons=failure_reasons,
            )
            if named_document_count >= failed_document_count:
                # Every failed document is named, so what is left belongs to other sources on the
                # same crawler or is a job-level notice (Bedrock adds a generic "internal error"
                # even to clean crawls). Log it rather than attach it to this batch's runs.
                if unmatched_reasons:
                    logger.info(
                        "Ingestion job %s reasons not attached to this batch's runs: %s",
                        bedrock_ingestion_job_id,
                        "; ".join(unmatched_reasons),
                    )
                error_message = None
            else:
                # Some failed documents are not named at all, so every other run keeps the
                # unmatched reasons rather than hiding a failure.
                error_message = "; ".join(unmatched_reasons) if unmatched_reasons else None

        rows_updated = 0
        for run_id, entry in attributed_runs.items():
            rows_updated += _update_ingestion_runs(
                connection,
                ingestion_run_ids=[run_id],
                status="failed" if entry["failed"] else normalized_status,
                error_message="; ".join(entry["reasons"]),
            )

        remaining_run_ids = [x for x in db_ingestion_run_ids if x not in attributed_runs]
        if remaining_run_ids:
            rows_updated += _update_ingestion_runs(
                connection,
                ingestion_run_ids=remaining_run_ids,
                status=normalized_status,
                error_message=error_message,
            )

        # Retry logic:
        # if a single-website batch failed due to capacity, delete it from the full data source,
        # preserve the failed run, and create a brand new queued retry run for the same website
        if (
            phase == "website"
            and normalized_status == "failed"
            and len(db_ingestion_run_ids) == 1
            and _looks_like_capacity_failure(failure_reasons)
        ):
            run_rows = _get_run_rows(connection, ingestion_run_ids=db_ingestion_run_ids)
            if run_rows:
                failed_run = run_rows[0]
                failed_data_source = _get_data_source_row(
                    connection,
                    data_source_id=failed_run["data_source_id"],
                )

                if failed_data_source and failed_data_source["type"] == "website":
                    website_url = failed_data_source["name"]

                    _remove_seed_url_from_bedrock_web_data_source(
                        knowledge_base_id=kb_id,
                        bedrock_data_source_id=bedrock_data_source_id,
                        website_url=website_url,
                    )

                    retry_run_id = _insert_retry_ingestion_run(
                        connection,
                        data_source_id=failed_run["data_source_id"],
                        sync_session_id=sync_session_id,
                        retry_of_ingestion_run_id=failed_run["id"],
                    )
                    retry_created_run_ids.append(retry_run_id)

        connection.commit()
    except Exception:
        connection.rollback()
        raise

    try:
        _delete_schedule(schedule_name)
    except Exception as e:
        logger.error("Failed to delete schedule %s: %s", schedule_name, e, exc_info=True)

    try:
        if normalized_status == "completed":
            if phase == "s3":
                next_step = process_website_batch(
                    event=event,
                    connection=connection,
                    kb_id=kb_id,
                    sync_session_id=sync_session_id,
                    triggered_by_scheduler=True,
                )
            elif phase == "website":
                next_step = process_website_batch(
                    event=event,
                    connection=connection,
                    kb_id=kb_id,
                    sync_session_id=sync_session_id,
                    triggered_by_scheduler=True,
                )

        elif (
            phase == "website"
            and normalized_status == "failed"
            and len(db_ingestion_run_ids) == 1
            and _looks_like_capacity_failure(failure_reasons)
            and retry_created_run_ids
        ):
            next_step = process_website_batch(
                event=event,
                connection=connection,
                kb_id=kb_id,
                sync_session_id=sync_session_id,
                triggered_by_scheduler=True,
            )

    except Exception as e:
        logger.error(
            "Failed to continue sync session %s after phase %s: %s",
            sync_session_id,
            phase,
            e,
            exc_info=True,
        )
        next_step = {
            "started": False,
            "error": str(e),
        }

    return _response(
        event,
        200,
        {
            "message": "Updated ingestion runs and attempted schedule cleanup",
            "phase": phase,
            "sync_session_id": sync_session_id,
            "db_ingestion_run_ids": db_ingestion_run_ids,
            "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
            "status": normalized_status,
            "rows_updated": rows_updated,
            "retry_created_run_ids": retry_created_run_ids,
            "next_step": next_step,
        },
    )
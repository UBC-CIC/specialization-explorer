# Knowledge Base

This document explains how the Knowledge Base ingestion Lambda works in the Specialization Explorer project. It focuses on the state machine logic that moves uploaded files and websites from staged records into Bedrock Knowledge Base ingestion jobs.

The goal of this document is to help a new developer understand the full lifecycle of a data source: how it is uploaded or registered, how it is staged, how it becomes queued, how it is assigned to either the S3 or website ingestion path, how schedulers poll Bedrock, and how terminal states and retries are handled.

## Table of Contents

1. [Introduction](#introduction)
2. [Overview](#overview)
3. [Implementation Files](#implementation-files)
4. [Request Entry Points](#request-entry-points)
5. [Admin Dashboard Behavior](#admin-dashboard-behavior)
6. [Presigned Upload Flow](#presigned-upload-flow)
7. [Staging Data Sources](#staging-data-sources)
8. [Sync Sessions](#sync-sessions)
9. [State Machine Logic](#state-machine-logic)
10. [S3 Ingestion Phase](#s3-ingestion-phase)
11. [Website Ingestion Phase](#website-ingestion-phase)
12. [Polling and Workflow Continuation](#polling-and-workflow-continuation)
13. [Retry Behavior](#retry-behavior)
14. [Error Handling](#error-handling)
15. [Monitoring and Debugging](#monitoring-and-debugging)
16. [Configuration and Environment Variables](#configuration-and-environment-variables)
17. [Design Notes](#design-notes)
18. [References](#references)
19. [Glossary](#glossary)

## Introduction

### What is the Knowledge Base?

The Knowledge Base is the retrieval layer used by the application to ground LLM responses in project-managed content. Administrators can add content to the Knowledge Base by uploading files or registering websites. Amazon Bedrock Knowledge Bases handles ingestion, chunking, embedding, and retrieval, while this Lambda controls when and how data sources are staged and synced.

### What this Lambda does

The Lambda acts as the orchestration layer between the admin UI, Amazon S3, Amazon Bedrock Knowledge Bases, Amazon RDS, and EventBridge Scheduler.

It is responsible for:

* Generating presigned S3 upload URLs for file uploads
* Staging websites and file pairs in the database
* Creating `ingestion_runs` rows that represent the state of each staged source
* Promoting staged work from `pending` to `queued` when an admin clicks Sync
* Starting Bedrock ingestion jobs for S3-backed files and website crawlers
* Creating polling schedules so long-running Bedrock jobs can be checked later
* Updating database run statuses after Bedrock jobs complete or fail
* Continuing the workflow from S3 ingestion into website ingestion
* Retrying single website crawls when a crawler fails because it reached capacity

### When to use this document

Use this document if you need to:

* Understand the Knowledge Base ingestion workflow end to end
* Add support for a new source type
* Modify the status lifecycle for `ingestion_runs`
* Debug why a source is stuck in `pending`, `queued`, or `running`
* Change the S3 or website batching behavior
* Update scheduler payloads or polling behavior
* Understand how Bedrock data sources are selected, updated, or created

## Overview

The system is built around two database tables:

* `data_sources`: stores the source itself, such as a website URL, CSV file, Markdown file, or metadata JSON file
* `ingestion_runs`: stores the ingestion state for a data source

The important idea is that `data_sources` describes *what* should be ingested, while `ingestion_runs` describes *where it is in the ingestion lifecycle*.

The state machine is implemented through the `status` column on `ingestion_runs`.

| Status      | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `pending`   | The source has been staged but has not yet been selected for syncing.                                          |
| `queued`    | The admin clicked Sync and the source is ready to be picked up by an ingestion batch.                          |
| `running`   | A Bedrock ingestion job has started for this source or for a batch containing this source.                     |
| `completed` | Bedrock reported that the ingestion job completed successfully.                                                |
| `failed`    | Bedrock reported that the ingestion job failed, or the system marked the run as failed after a terminal error. |

At a high level, the normal flow is:

```text
Admin stages source
        ↓
data_sources row created
        ↓
ingestion_runs row created as pending
        ↓
Admin clicks Sync
        ↓
latest pending runs become queued
        ↓
S3 phase starts first, if any queued file sources exist
        ↓
S3 scheduler polls until Bedrock completes or fails
        ↓
website phase starts after S3 completes, or immediately if no S3 work exists
        ↓
website scheduler polls until Bedrock completes or fails
        ↓
next website batch starts until no queued websites remain
```

## Implementation Files

The Knowledge Base ingestion workflow is split across several helper modules.

| File                                                               | Responsibility                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `cdk/lambda/lambdaKnowledgeBase/main.py`                           | Main Lambda entry point. Routes API Gateway requests and scheduler events.                       |
| `cdk/lambda/lambdaKnowledgeBase/helpers/cors.py`                   | Builds CORS response headers from the configured allowed origins.                                |
| `cdk/lambda/lambdaKnowledgeBase/helpers/generate_presigned_url.py` | Creates short-lived S3 PUT URLs for admin uploads.                                               |
| `cdk/lambda/lambdaKnowledgeBase/helpers/stage_data_sources.py`     | Validates and stages websites, CSV/JSON pairs, and Markdown/JSON pairs.                          |
| `cdk/lambda/lambdaKnowledgeBase/helpers/start_ingestion_job.py`    | Starts a sync session by promoting pending runs to queued and starting the first eligible phase. |
| `cdk/lambda/lambdaKnowledgeBase/helpers/process_s3_batch.py`       | Starts the S3 ingestion phase for queued CSV, Markdown, and JSON sources.                        |
| `cdk/lambda/lambdaKnowledgeBase/helpers/process_website_batch.py`  | Starts website ingestion batches using Bedrock web crawler data sources.                         |
| `cdk/lambda/lambdaKnowledgeBase/helpers/update_status.py`          | Polls Bedrock ingestion jobs, updates run status, deletes schedules, and advances the workflow.  |

## Request Entry Points

The Lambda handles two types of events:

1. API Gateway requests from the admin UI
2. EventBridge Scheduler polling events created by the Lambda itself

### API Gateway routes

The Lambda handles the following admin routes:

| Method | Route                           | Handler                  | Purpose                                                               |
| ------ | ------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `GET`  | `/admin/generate-presigned-url` | `generate_presigned_url` | Create a presigned S3 PUT URL for an admin file upload.               |
| `POST` | `/admin/data_sources`           | `stage_data_sources`     | Stage a website, CSV/JSON pair, or Markdown/JSON pair.                |
| `POST` | `/admin/data_sources/sync`      | `start_ingestion_job`    | Promote pending sources to queued and start the next ingestion phase. |

### Scheduler events

Scheduler events are identified by this payload field:

```json
{
  "task": "poll_ingestion_run"
}
```

When the Lambda sees this task, it skips API Gateway routing and calls `update_status(event, connection)` directly.

Scheduler events are created after an ingestion job starts. They carry enough information for the Lambda to poll Bedrock later:

```json
{
  "task": "poll_ingestion_run",
  "phase": "s3",
  "knowledge_base_id": "...",
  "bedrock_data_source_id": "...",
  "bedrock_ingestion_job_id": "...",
  "db_ingestion_run_ids": ["..."],
  "sync_session_id": "...",
  "schedule_name": "..."
}
```

The `phase` is either `s3` or `website`.

## Admin Dashboard Behavior

The admin dashboard is the main UI that drives this workflow. It does not change the backend state machine, but it is important for understanding what an administrator sees and how dashboard actions map to Lambda routes.

### Dashboard read model

The dashboard loads data sources by calling:

```text
GET /admin/data_sources
```

The response is expected to return each `data_sources` row together with its latest ingestion run:

```json
{
  "items": [
    {
      "data_source": { ... },
      "latest_ingestion_run": { ... }
    }
  ]
}
```

This means the dashboard is a latest-status view, not a full ingestion history view. Historical retry attempts can still exist in `ingestion_runs`, but the table displays the latest run for each data source.

### Dashboard actions

| UI Action                   | Backend Route                                                                  | Result                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Add Web URL                 | `POST /admin/data_sources`                                                     | Stages a website as `pending`.                                                           |
| Add Data (CSV or Markdown)  | `GET /admin/generate-presigned-url`, S3 `PUT`, then `POST /admin/data_sources` | Uploads the primary file and metadata JSON, then stages both as `pending`.               |
| Sync                        | `POST /admin/data_sources/sync`                                                | Promotes latest `pending` runs to `queued` and starts the next eligible ingestion phase. |
| Refresh table after actions | `GET /admin/data_sources`                                                      | Reloads the data source table and latest run statuses.                                   |

### UI validation rules

The dashboard applies some validation before requests reach the Lambda:

| Input              | Dashboard Rule                                                |
| ------------------ | ------------------------------------------------------------- |
| Website URL        | Must start with `http://` or `https://`.                      |
| Include patterns   | Optional. Entered as one regex per line and sent as an array. |
| Exclude patterns   | Optional. Entered as one regex per line and sent as an array. |
| Primary file       | Must be CSV or Markdown.                                      |
| Metadata file      | Must be JSON.                                                 |
| File size          | Primary and metadata files must each be less than 50 MB.      |
| Metadata file name | Must exactly match `{primary_file_name}.metadata.json`.       |

The backend still performs its own validation. The UI validation exists to give administrators faster feedback before making API calls.

### Metadata JSON display

The dashboard hides metadata JSON rows from the main table. Instead, it displays each metadata JSON file as an expandable child row under its matching CSV or Markdown file.

This display behavior depends on the naming rule:

```text
{primary_file_name}.metadata.json
```

For example:

| Main Row        | Child Metadata Row            |
| --------------- | ----------------------------- |
| `courses.csv`   | `courses.csv.metadata.json`   |
| `admissions.md` | `admissions.md.metadata.json` |

This is why the naming rule is enforced by both the frontend and backend.

### Sync button behavior

The Sync button is enabled only when the dashboard sees at least one latest ingestion run with status:

* `pending`
* `queued`

If all latest runs are `running`, `completed`, or `failed`, the Sync button is disabled. This is a UI guardrail only; the backend still validates the sync request and returns an error if there are no pending runs to queue.

### Search and pagination

Search and pagination are frontend-only table features. The dashboard filters visible rows by data source name or type and paginates the table in groups of five rows. These features do not affect ingestion state or backend batch selection.

## Presigned Upload Flow

File ingestion starts before the database staging step. The admin UI first asks the Lambda for a presigned upload URL.

### Supported content types

The upload URL generator accepts these content types:

| Content Type               | Used For              |
| -------------------------- | --------------------- |
| `text/csv`                 | CSV source files      |
| `text/markdown`            | Markdown source files |
| `application/json`         | Metadata JSON files   |
| `text/json`                | Metadata JSON files   |
| `application/octet-stream` | Fallback content type |

### S3 key prefixes

The upload helper chooses an S3 prefix based on the file name and content type.

| Source      | Prefix             |
| ----------- | ------------------ |
| CSV         | `quarantine/csv`      |
| Markdown    | `quarantine/markdown` |
| JSON        | `quarantine/json`     |
| Other files | `quarantine/files`    |

The generated S3 key uses this format:

```text
{prefix}/{timestamp}_{file_name}
```

The presigned URL expires after 300 seconds. The admin UI uploads the file directly to S3 using HTTP `PUT`.

Important: generating the presigned URL does not create any database records, and objects under `quarantine/` are never read by Bedrock. The file must still be staged through `POST /admin/data_sources` (or the batch route) after upload. Staging checks that the key is a quarantine key in the knowledge base bucket, then copies the file to the same path under `uploads/` (for example `quarantine/csv/1712345678_data.csv` becomes `uploads/csv/1712345678_data.csv`) and records that key. The Bedrock data source is limited to the `uploads/` prefix, so only staged files enter the corpus. Uploads that are never staged are deleted from `quarantine/` after 7 days.

## Staging Data Sources

Staging is handled by `stage_data_sources(event, body, connection)`.

A staged source is not ingested immediately. Staging only records the source in the database and creates an initial `pending` ingestion run.

### Supported source types

The staging endpoint supports:

| Request `type` | Staged records                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `website`      | One `data_sources` row and one `pending` `ingestion_runs` row                                                  |
| `csv`          | One CSV `data_sources` row, one metadata JSON `data_sources` row, and two `pending` `ingestion_runs` rows      |
| `markdown`     | One Markdown `data_sources` row, one metadata JSON `data_sources` row, and two `pending` `ingestion_runs` rows |

CSV and Markdown sources require a companion metadata JSON file. The primary file and metadata file are staged as separate `data_sources` rows because both files must be visible to the shared S3 Knowledge Base data source.

### Website staging

For a website source, the request must include:

| Field              | Description                              |
| ------------------ | ---------------------------------------- |
| `type`             | Must be `website`                        |
| `created_by`       | Admin email address                      |
| `name`             | Website URL                              |
| `include_patterns` | Optional list of crawler include filters |
| `exclude_patterns` | Optional list of crawler exclude filters |

The function validates that:

* `created_by` is present
* the admin exists in the `users` table
* `name` is present
* `include_patterns`, if provided, is a list
* `exclude_patterns`, if provided, is a list
* the same website URL does not already exist in `data_sources`

If validation passes, it inserts:

1. A `data_sources` row with `type = 'website'`
2. An `ingestion_runs` row with `status = 'pending'`

The website is now staged but not yet queued for ingestion.

### CSV and Markdown staging

CSV and Markdown staging follow the same pattern. The only difference is the primary source type.

For CSV, the request must include:

| Field                | Description                            |
| -------------------- | -------------------------------------- |
| `type`               | Must be `csv`                          |
| `created_by`         | Admin email address                    |
| `csv_file_name`      | Uploaded CSV file name                 |
| `csv_s3_bucket`      | S3 bucket containing the CSV           |
| `csv_s3_key`         | S3 key for the CSV                     |
| `metadata_file_name` | Companion metadata JSON file name      |
| `metadata_s3_bucket` | S3 bucket containing the metadata JSON |
| `metadata_s3_key`    | S3 key for the metadata JSON           |

For Markdown, the primary fields are:

| Field                | Description                            |
| -------------------- | -------------------------------------- |
| `markdown_file_name` | Uploaded Markdown file name            |
| `markdown_s3_bucket` | S3 bucket containing the Markdown file |
| `markdown_s3_key`    | S3 key for the Markdown file           |

The metadata JSON file name must exactly match this format:

```text
{primary_file_name}.metadata.json
```

Examples:

| Primary File        | Required Metadata File            |
| ------------------- | --------------------------------- |
| `courses.csv`       | `courses.csv.metadata.json`       |
| `admissions.md`     | `admissions.md.metadata.json`     |
| `programs.markdown` | `programs.markdown.metadata.json` |

The function validates that:

* the admin exists
* all primary file details are present
* all metadata JSON details are present
* the primary file extension matches the source type
* the metadata file ends with `.json`
* the metadata file name matches the required naming convention
* both uploaded objects exist in S3 using `head_object`
* neither S3 object has already been staged

If validation passes, it inserts:

1. A `data_sources` row for the primary file
2. A `data_sources` row for the metadata JSON file
3. A `pending` `ingestion_runs` row for the primary file
4. A `pending` `ingestion_runs` row for the metadata JSON file

## Sync Sessions

A sync session starts when an admin calls:

```text
POST /admin/data_sources/sync
```

The request must include the admin email in `created_by`.

The sync handler creates a new `sync_session_id` using `uuid4().hex`. This ID is written into the metadata of all newly queued runs so the system can track work that belongs to the same admin sync action.

### Pending to queued promotion

The first state transition in a sync session is:

```text
pending → queued
```

This is done by `_promote_pending_to_queued(connection, sync_session_id=...)`.

The query only promotes the latest pending ingestion run for each data source. This prevents old historical runs from being re-queued accidentally.

After promotion, the run metadata contains:

```json
{
  "sync_session_id": "..."
}
```

If no pending runs are found, the endpoint returns `409` with:

```json
{
  "error": "No pending data sources found to queue."
}
```

### Phase selection

After pending runs are queued, the sync handler tries phases in this order:

1. S3 phase
2. Website phase

This means file-based sources are always processed before website sources within the same sync session.

The handler first calls:

```python
process_s3_batch(...)
```

If S3 work starts, the API returns immediately. Website work will be attempted later by the scheduler after the S3 ingestion job reaches a terminal state.

If no S3 work is eligible, the handler calls:

```python
process_website_batch(...)
```

If neither phase can start, the endpoint returns `409` with diagnostic details from both attempted phases.

## State Machine Logic

The `ingestion_runs.status` field is the core state machine.

### State transition table

| From      | To          | Trigger                                         | Code Path                                            |
| --------- | ----------- | ----------------------------------------------- | ---------------------------------------------------- |
| none      | `pending`   | Admin stages a source                           | `stage_data_sources`                                 |
| `pending` | `queued`    | Admin clicks Sync                               | `start_ingestion_job` → `_promote_pending_to_queued` |
| `queued`  | `running`   | Bedrock ingestion job starts                    | `process_s3_batch` or `process_website_batch`        |
| `running` | `completed` | Bedrock returns `COMPLETE`                      | `update_status`                                      |
| `running` | `failed`    | Bedrock returns `FAILED`                        | `update_status`                                      |
| `failed`  | `queued`    | Single website capacity retry creates a new run | `update_status` → `_insert_retry_ingestion_run`      |

The retry case does not mutate the failed row back to queued. Instead, it preserves the failed run for history and creates a brand new queued run for the same website `data_sources` row.

### Bedrock status mapping

`update_status` maps Bedrock ingestion statuses into internal statuses.

| Bedrock Status | Internal Status |
| -------------- | --------------- |
| `STARTING`     | `running`       |
| `IN_PROGRESS`  | `running`       |
| `STOPPING`     | `running`       |
| `COMPLETE`     | `completed`     |
| `FAILED`       | `failed`        |

Unsupported or unknown Bedrock statuses do not update the database. The polling invocation returns a 200 response explaining that the status is unsupported or unknown.

## S3 Ingestion Phase

The S3 phase is handled by `process_s3_batch`.

This phase processes file-backed sources:

* CSV files
* Markdown files
* Metadata JSON files

### Why there is one shared S3 data source

The Bedrock Knowledge Base uses a single shared S3 data source for file ingestion. All uploaded CSV, Markdown, and JSON files are placed in the same S3 bucket and ingested through that shared Bedrock data source.

Because of this design, `process_s3_batch` expects exactly one Bedrock data source with `dataSourceConfiguration.type == 'S3'`.

If there are zero or multiple S3 data sources, the S3 phase does not start and returns:

```json
{
  "started": false,
  "phase": "s3",
  "error": "Expected exactly one S3 data source in the knowledge base."
}
```

### Selecting queued S3 runs

The S3 phase queries the latest ingestion run for each data source and selects runs where:

* latest run status is `queued`
* data source type is one of `csv`, `markdown`, or `json`

The selected rows are ordered by the source creation time. All eligible queued file runs are attached to a single Bedrock S3 ingestion job.

### Starting the S3 job

Once queued file runs are found, the helper:

1. Locates the shared Bedrock S3 data source
2. Calls `bedrock_agent.start_ingestion_job(...)`
3. Creates a 5-minute EventBridge Scheduler schedule
4. Marks all selected `ingestion_runs` rows as `running`
5. Stores job metadata on the runs

The run metadata is updated with:

```json
{
  "phase": "s3",
  "sync_session_id": "...",
  "bedrock_ingestion_job_id": "...",
  "schedule_name": "..."
}
```

The schedule name uses this format:

```text
kb-s3-{sync_session_id}-{random_suffix}
```

The scheduler invokes the same Lambda every 5 minutes until the job reaches a terminal state.

## Website Ingestion Phase

The website phase is handled by `process_website_batch`.

This phase processes data sources with:

```text
type = 'website'
```

Unlike S3 ingestion, website ingestion requires assigning URLs to Bedrock web crawler data sources. A crawler can contain multiple seed URLs, but it also has practical capacity limits.

### Website crawler limits

The website phase uses these constants:

| Constant                        | Value  | Purpose                                                                     |
| ------------------------------- | ------ | --------------------------------------------------------------------------- |
| `MAX_TOTAL_DATA_SOURCES`        | `5`    | Maximum Bedrock data sources expected for the Knowledge Base.               |
| `RESERVED_NON_WEB_DATA_SOURCES` | `1`    | One data source slot is reserved for the shared S3 source.                  |
| `MAX_WEB_DATA_SOURCES`          | `4`    | Maximum number of web crawler data sources.                                 |
| `WEBSITE_BATCH_SIZE`            | `5`    | Default number of websites added to one crawler batch.                      |
| `LOW_REMAINING_PAGES_THRESHOLD` | `5000` | If a crawler has 5,000 or fewer remaining pages, only one website is added. |

### Classifying Bedrock web crawlers

Before starting a website batch, the helper lists all Bedrock data sources and filters for web crawlers where:

```text
dataSourceConfiguration.type == 'WEB'
```

For each web crawler, it fetches the latest Bedrock ingestion job and classifies the crawler as one of:

| State       | Meaning                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `available` | The crawler is not currently syncing and has remaining page capacity.                |
| `syncing`   | The latest Bedrock job is `STARTING`, `IN_PROGRESS`, or `STOPPING`.                  |
| `full`      | The crawler reached `maxPages`, or the latest failure looks like a capacity failure. |

The helper chooses the available crawler with the most remaining pages.

### Capacity detection

A crawler is considered full if either:

* the number of documents scanned is greater than or equal to the crawler `maxPages`, or
* the latest failure reason looks like a max-pages/capacity failure

The capacity failure check looks for terms such as:

* `maxpages`
* `max pages`
* `25,000`
* `25000`
* `page limit`
* `crawl limit`
* `exceeded`
* `too many pages`
* `max capacity`
* `capacity reached`

### Website batch selection

The website phase selects queued website runs using the latest run per data source. A website run is eligible when:

* its latest run status is `queued`
* its data source type is `website`

The batch starts with the oldest queued website. Additional websites are only added to the same batch if they have the same include/exclude pattern configuration.

This is important because include and exclude filters are crawler-level settings. Websites with different filter rules should not be mixed into the same crawler update.

The grouping key is based on:

```json
{
  "include_patterns": [...],
  "exclude_patterns": [...]
}
```

### Batch size rules

The selected batch size depends on crawler capacity:

| Condition                                             | Batch Size       |
| ----------------------------------------------------- | ---------------- |
| Selected crawler has more than 5,000 remaining pages  | Up to 5 websites |
| Selected crawler has 5,000 or fewer remaining pages   | 1 website        |
| No available crawler and a new crawler may be created | Up to 5 websites |

### Crawler seed URL limits

Bedrock rejects a web crawler update with more than 100 seed URLs (`MAX_SEED_URLS`), or with seed URLs whose combined length is 3,000 characters or more (`MAX_SEED_URL_CHARS` is 2,999). Before updating the crawler, `_plan_website_batch` checks each queued website against the room left on it:

* Websites that fit are batched as described above.
* Websites that do not fit are marked `failed` with a "web crawler is full" message, so they do not stay `queued` and block every later sync. Room only shrinks as batches are added, so a website that does not fit now never will on that crawler.
* If Bedrock still rejects the update with a `ValidationException` (for example a limit the code does not check), the batch is marked `failed` with Bedrock's reason.

Since September 30, 2026, Bedrock no longer allows new Web Crawler connectors on customer-managed knowledge bases ([Bedrock docs](https://docs.aws.amazon.com/bedrock/latest/userguide/webcrawl-data-source-connector.html)). `NEW_WEB_CRAWLERS_SUPPORTED` is therefore `False`: the existing crawler is the only one, and when it is busy the queued websites wait for its current job instead of a new crawler being created.

To make room, remove websites from the crawler, replace several pages with a shorter parent URL (the default scope crawls every page under a seed's path), or upload the pages as Markdown files.

### Updating an existing crawler

If an available crawler exists, the helper updates that Bedrock data source by appending new seed URLs.

It also applies the effective include/exclude filters for the batch:

* If the staged website batch has include patterns, those are applied
* Otherwise, the existing crawler include filters are preserved
* If the staged website batch has exclude patterns, those are applied
* Otherwise, the existing crawler exclude filters are preserved

After updating the crawler, the helper starts a Bedrock ingestion job for that crawler.

### Creating a new crawler

If no available crawler exists, the helper may create a new web crawler data source.

A new crawler can only be created if the current number of web crawlers is less than `MAX_WEB_DATA_SOURCES`.

The new crawler is built from an existing template crawler. It inherits the template's vector ingestion configuration and crawler settings, then replaces the seed URL list with the current website batch.

If the system already has the maximum number of web crawlers, the phase returns:

```json
{
  "started": false,
  "phase": "website",
  "error": "No available web crawler capacity for queued websites."
}
```

### Starting the website job

After selecting or creating a target crawler, the helper:

1. Starts a Bedrock ingestion job for the web crawler
2. Creates a 10-minute EventBridge Scheduler schedule
3. Marks the selected website runs as `running`
4. Stores job metadata on the runs

The run metadata is updated with:

```json
{
  "phase": "website",
  "sync_session_id": "...",
  "bedrock_ingestion_job_id": "...",
  "schedule_name": "..."
}
```

The schedule name uses this format:

```text
kb-web-{sync_session_id}-{random_suffix}
```

The scheduler invokes the same Lambda every 10 minutes until the job reaches a terminal state.

## Polling and Workflow Continuation

Polling is handled by `update_status`.

A polling invocation happens when EventBridge Scheduler invokes the Lambda with `task = 'poll_ingestion_run'`.

### Required scheduler payload fields

The scheduler payload must include:

| Field                      | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `task`                     | Must be `poll_ingestion_run`                            |
| `phase`                    | Either `s3` or `website`                                |
| `knowledge_base_id`        | Bedrock Knowledge Base ID                               |
| `bedrock_data_source_id`   | Bedrock data source ID being ingested                   |
| `bedrock_ingestion_job_id` | Bedrock ingestion job ID to poll                        |
| `db_ingestion_run_ids`     | Database ingestion run IDs affected by this Bedrock job |
| `sync_session_id`          | Sync session this job belongs to                        |
| `schedule_name`            | EventBridge schedule to delete when the job finishes    |

If `db_ingestion_run_ids` is missing, the code also supports the older single-run field `db_ingestion_run_id` and converts it into a list.

### Running jobs

If Bedrock returns a running status, the function does not update the database. It returns a response saying the ingestion job is still running.

The schedule remains active and will invoke the Lambda again later.

### Terminal jobs

If Bedrock returns `COMPLETE` or `FAILED`, the function:

1. Updates all matching `ingestion_runs` rows
2. Sets `completed_at = NOW()` for terminal states
3. Stores Bedrock failure reasons in `error_message` if present
4. Commits the database transaction
5. Deletes the polling schedule
6. Attempts to continue the workflow

A `COMPLETE` job can still contain documents that failed to ingest (`statistics.numberOfDocumentsFailed`). Bedrock reports reasons for the whole job, often as one JSON array of messages, so each message is matched to the run it names:

* A message naming a run's S3 object (`s3://bucket/key`) marks that run `failed`.
* A message naming a website's seed URL marks that website run `failed`, since nothing was ingested from it (for example, the seed redirected outside the crawl scope).
* A message naming a page under a website's seed path (the crawler's default scope) leaves that run `completed` with the reason, shown as **Completed with errors**.

Runs that no message names stay `completed` with no error. Every website job re-crawls all seeds on the crawler, so its messages can name seeds from earlier batches; those are not attached to the current batch. When the messages name at least as many documents as `numberOfDocumentsFailed`, the leftover messages (earlier batches' seeds, or the generic "internal error" Bedrock adds even to clean crawls) are only logged. When some failed documents are not named at all, the leftover messages stay on every unmatched run so the failure is not hidden.

Every terminal poll publishes `FailedDocuments` and `FailedIngestionJobs` to the `<StackPrefix>-Api/KnowledgeBase` CloudWatch namespace through Embedded Metric Format. The `KnowledgeBaseFailedDocumentsAlarm` and `KnowledgeBaseFailedIngestionJobsAlarm` alarms fire when either is at least 1 in a 5-minute period.

### Large files

The S3 data source uses semantic chunking, which rejects a document over 1,000,000 characters. The chunking strategy cannot be changed on an existing data source. At staging time:

* A CSV over 900,000 characters is split into `<name>.partNNN.csv` files. Each part has the header row and its own copy of the metadata file. Only the parts are copied under `uploads/`, and their keys are stored in `data_sources.metadata.s3_part_keys`. `s3_key` keeps the original key so duplicate checks still work.
* A CSV with a single row over the limit, or a Markdown file over the limit, is rejected with `400`.

Files staged before this check were not split. Re-upload any of them that fail with the size limit.

### Continuing after S3 completion

When an S3 job completes, `update_status` calls:

```python
process_website_batch(..., triggered_by_scheduler=True)
```

This is how the system moves from file ingestion into website ingestion within the same sync session.

S3 completion does not automatically mark website runs as completed. It only gives the website phase a chance to start if queued websites exist.

### Continuing after website completion

When a website job completes, `update_status` calls `process_website_batch` again.

This allows the system to process multiple website batches in sequence. Each completed website batch can start the next queued website batch until no queued website runs remain.

## Retry Behavior

The retry logic only applies to a specific case:

```text
phase = website
status = failed
batch size = 1
failure looks like a capacity failure
```

This case means the system tried to ingest a single website into a crawler that appeared to have room, but Bedrock reported that the crawler was actually full or over its page limit.

### Retry steps

When this happens, `update_status`:

1. Marks the original run as `failed`
2. Reads the failed run and its `data_sources` row
3. Gets the failed website URL from `data_sources.name`
4. Removes that URL from the full Bedrock web crawler's seed URL list
5. Creates a new `queued` `ingestion_runs` row for the same website data source
6. Preserves the failed run for history
7. Calls `process_website_batch` again so the website can be tried on another crawler

The retry run metadata includes:

```json
{
  "phase": "website",
  "sync_session_id": "...",
  "retry_of_ingestion_run_id": "...",
  "action": "retry_after_capacity_failure"
}
```

### Why retries create a new run

The failed run is not overwritten. This preserves a clear audit trail:

```text
original run: running → failed
retry run: queued → running → completed or failed
```

This makes the admin dashboard and debugging logs easier to reason about because every Bedrock attempt has its own database record.

## Error Handling

### API-level errors

The Lambda returns structured JSON errors for common request failures.

| Scenario                              | Response |
| ------------------------------------- | -------- |
| Missing `file_name` for presigned URL | `400`    |
| Unsupported upload content type       | `400`    |
| Invalid JSON request body             | `400`    |
| Missing `created_by`                  | `400`    |
| Admin email not found                 | `400`    |
| Duplicate website or file source      | `409`    |
| No pending sources to queue           | `409`    |
| No eligible batch can start           | `409`    |
| Database connection failure           | `500`    |
| Knowledge Base ID lookup failure      | `500`    |
| Unhandled exception                   | `500`    |

### S3 staging errors

For file sources, staging validates that both the primary file and companion metadata JSON file exist in S3. If either object is missing, staging returns:

```json
{
  "error": "One or both uploaded files do not exist in S3"
}
```

### Scheduler errors

If a scheduler payload is missing required fields, `update_status` returns `400` with the fields it received. This helps debug malformed schedules or older payload formats.

If schedule deletion fails after a terminal Bedrock status, the error is logged but the Lambda continues. This avoids blocking database status updates just because schedule cleanup failed.

## Monitoring and Debugging

### CloudWatch logs

The Lambda logs:

* Incoming events
* Database connection failures
* Secret lookup failures
* Presigned URL generation failures
* S3 object validation failures
* Bedrock ingestion job polling results
* Schedule deletion failures
* Workflow continuation failures
* Website capacity retry behavior
* Ingestion jobs that failed or finished with failed documents (also published as CloudWatch metrics)

### Important metadata fields

When debugging, inspect the `metadata` column on `ingestion_runs`.

Important fields include:

| Field                       | Meaning                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `sync_session_id`           | Groups runs created or processed by the same Sync click.          |
| `phase`                     | Indicates whether the run belongs to the `s3` or `website` phase. |
| `bedrock_ingestion_job_id`  | Bedrock job associated with the run.                              |
| `schedule_name`             | EventBridge schedule polling the job.                             |
| `retry_of_ingestion_run_id` | Original failed run that caused a retry.                          |
| `action`                    | Describes why the run was created or updated.                     |

### Common debugging questions

#### Why is a source stuck in `pending`?

The admin has staged it, but no sync has been started yet. The admin must click Sync, which calls `POST /admin/data_sources/sync`.

#### Why is a source stuck in `queued`?

The source has been selected for a sync session, but no eligible phase has picked it up yet. Check:

* whether an S3 job is still running before website work can start
* whether all web crawlers are syncing or full
* whether the website batch is blocked by crawler capacity
* whether there are no available web data source slots left

#### Why is a source stuck in `running`?

The Bedrock ingestion job has started, but the polling scheduler has not marked it terminal yet. Check:

* whether the EventBridge schedule exists
* whether the schedule target ARN points to this Lambda
* whether the scheduler role can invoke the Lambda
* whether Bedrock still reports `STARTING`, `IN_PROGRESS`, or `STOPPING`

#### Why did a website fail and then become queued again?

The original website run did not become queued again. A new retry run was created because the website failed as a single-item batch and the failure looked like a crawler capacity issue.

#### Why did website ingestion not start after S3 finished?

Check the result returned by `process_website_batch` in the `next_step` field of the polling response. Common reasons include:

* no queued website runs exist
* no web crawler template exists
* all crawlers are syncing or full
* maximum web crawler data source count has been reached

## Configuration and Environment Variables

The Lambda depends on several environment variables.

| Variable                     | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `SM_DB_CREDENTIALS`          | Secrets Manager secret containing database credentials.          |
| `KB_SECRET_NAME`             | Secrets Manager secret containing the Bedrock Knowledge Base ID. |
| `REGION`                     | AWS region used for clients.                                     |
| `RDS_PROXY_ENDPOINT`         | RDS Proxy endpoint for PostgreSQL connections.                   |
| `KNOWLEDGE_BASE_BUCKET_NAME` | S3 bucket used for uploaded Knowledge Base files.                |
| `ALLOWED_ORIGIN_PARAM`       | Optional SSM parameter containing allowed CORS origins.          |
| `SCHEDULER_ROLE_ARN`         | IAM role used by EventBridge Scheduler to invoke the Lambda.     |
| `SCHEDULER_TARGET_ARN`       | Lambda ARN invoked by EventBridge Scheduler.                     |

## Design Notes

### Why S3 runs before websites

S3 ingestion is attempted first because all queued file sources can be handled by a single shared S3 data source and a single Bedrock ingestion job. Website ingestion is more complex because it depends on crawler capacity, seed URL grouping, include/exclude filters, and sequential batches.

Running S3 first gives the system a simple deterministic first phase before moving into crawler allocation.

### Why websites are grouped by include/exclude patterns

Include and exclude patterns are crawler-level settings in Bedrock. If two websites require different filters, they should not be added to the same crawler update. Grouping websites by filter configuration prevents one website's filters from accidentally affecting another website.

### Why schedulers are used

Bedrock ingestion jobs are asynchronous and may run longer than a single Lambda invocation. EventBridge Scheduler lets the system poll periodically without keeping the Lambda running.

The scheduler intervals are:

| Phase   | Polling Interval |
| ------- | ---------------- |
| S3      | 5 minutes        |
| Website | 10 minutes       |

### Why the same Lambda handles API and polling events

Using one Lambda keeps the ingestion workflow centralized. API requests start work, and scheduler events continue work. The event shape determines which path the handler follows.

### Why failed retry runs are preserved

Retries create new `ingestion_runs` rows instead of mutating failed rows back to queued. This preserves the full history of Bedrock attempts and makes failures auditable.

## References

* Main Lambda router: `cdk/lambda/lambdaKnowledgeBase/main.py`
* CORS helper: `cdk/lambda/lambdaKnowledgeBase/helpers/cors.py`
* Presigned upload helper: `cdk/lambda/lambdaKnowledgeBase/helpers/generate_presigned_url.py`
* Staging helper: `cdk/lambda/lambdaKnowledgeBase/helpers/stage_data_sources.py`
* Sync session helper: `cdk/lambda/lambdaKnowledgeBase/helpers/start_ingestion_job.py`
* S3 batch helper: `cdk/lambda/lambdaKnowledgeBase/helpers/process_s3_batch.py`
* Website batch helper: `cdk/lambda/lambdaKnowledgeBase/helpers/process_website_batch.py`
* Polling and retry helper: `cdk/lambda/lambdaKnowledgeBase/helpers/update_status.py`

---

## Glossary

* **Knowledge Base:** Bedrock Knowledge Base used to ingest, embed, and retrieve project content for RAG.
* **Data source:** A row in `data_sources` representing a website URL, CSV file, Markdown file, or metadata JSON file.
* **Ingestion run:** A row in `ingestion_runs` representing the ingestion lifecycle state for one data source.
* **Sync session:** A group of queued ingestion runs created by one admin Sync action, identified by `sync_session_id`.
* **S3 phase:** The ingestion phase that processes queued CSV, Markdown, and JSON files through the shared Bedrock S3 data source.
* **Website phase:** The ingestion phase that processes queued website URLs through Bedrock web crawler data sources.
* **Bedrock data source:** A Bedrock Knowledge Base data source, either the shared S3 source or a web crawler source.
* **Bedrock ingestion job:** An asynchronous Bedrock job that ingests content from a Bedrock data source into the Knowledge Base.
* **EventBridge Scheduler:** AWS service used to periodically invoke the Lambda while Bedrock ingestion jobs are running.
* **Capacity failure:** A website crawler failure that appears to be caused by reaching `maxPages` or a similar crawl/page limit.
* **Retry run:** A new queued `ingestion_runs` row created after a single-website capacity failure.

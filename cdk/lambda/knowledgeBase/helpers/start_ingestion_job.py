import os
import json
import logging
from uuid import uuid4

from helpers.cors import get_cors_headers
from helpers.process_s3_batch import process_s3_batch
from helpers.process_website_batch import process_website_batch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]


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


def _promote_pending_to_queued(connection, *, sync_session_id: str) -> int:
    """
    Promote the latest pending ingestion run for each data source to queued.
    This is the first step of a sync session. It marks staged work as officially
    selected for ingestion and stamps the runs with the sync_session_id so the
    rest of the workflow can track them as part of the same sync.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.id,
                    ir.data_source_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            UPDATE ingestion_runs ir
            SET
                status = 'queued'::ingestion_status,
                metadata = COALESCE(ir.metadata, '{}'::jsonb) || %s::jsonb
            FROM latest_runs lr
            WHERE ir.id = lr.id
              AND lr.rn = 1
              AND ir.status = 'pending'::ingestion_status
            """,
            (json.dumps({"sync_session_id": sync_session_id}),),
        )
        return cursor.rowcount


def start_ingestion_job(event, body, connection, kb_id, acting_user):
    """
    Start a new sync session for staged data sources.

    This method:
    - validates the requesting admin
    - creates a new sync_session_id
    - promotes pending ingestion runs to queued (runs already queued by an
      earlier failed sync are retried even when nothing new is pending)
    - attempts to start the S3 batch first
    - if no S3 batch is eligible, attempts to start the website batch
    - returns the first phase that was successfully started

    The actual ingestion work is delegated to:
    - process_s3_batch(...)
    - process_website_batch(...)
    """
    created_by_user_id = acting_user["id"]

    sync_session_id = uuid4().hex

    try:
        queued_count = _promote_pending_to_queued(
            connection,
            sync_session_id=sync_session_id,
        )
        connection.commit()

        if queued_count == 0:
            # Nothing new to promote, but runs left queued by an earlier sync whose
            # batch failed to start (e.g. a Bedrock error) must still be retried.
            logger.info("No pending runs to promote; retrying already-queued runs")

        s3_started = process_s3_batch(
            event=event,
            connection=connection,
            kb_id=kb_id,
            sync_session_id=sync_session_id,
            triggered_by_scheduler=False,
        )
        if s3_started.get("started"):
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and S3 sync started.",
                    "action": "queued_and_started_s3_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "s3",
                    "details": s3_started,
                },
            )

        website_started = process_website_batch(
            event=event,
            connection=connection,
            kb_id=kb_id,
            sync_session_id=sync_session_id,
            triggered_by_scheduler=False,
        )
        if website_started.get("started"):
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and website sync started.",
                    "action": "queued_and_started_website_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "website",
                    "details": website_started,
                },
            )

        if website_started.get("failed_count"):
            # Websites that cannot fit the web crawler were marked failed with the reason
            error = website_started["message"]
        elif queued_count == 0:
            error = "No pending or queued data sources found to sync."
        else:
            error = "Pending data sources were queued, but no eligible batch could be started."

        return _response(
            event,
            409,
            {
                "error": error,
                "sync_session_id": sync_session_id,
                "queued_count": queued_count,
                "s3_result": s3_started,
                "website_result": website_started,
            },
        )

    except Exception as e:
        connection.rollback()
        logger.error("Failed to start ingestion job orchestration: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to start ingestion job orchestration"})
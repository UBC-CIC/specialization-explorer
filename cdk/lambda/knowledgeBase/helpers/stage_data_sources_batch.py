import json
import logging
from helpers.cors import get_cors_headers
from helpers.stage_data_sources import (
    _validate_file_pair,
    _assert_s3_object_exists,
    _approved_key_for,
    _promote_file_pair,
    _discard_promoted,
    InvalidUploadError,
    _existing_file_row_id,
    _insert_data_source_row,
    _insert_ingestion_run_row,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body),
    }


def stage_data_sources_batch(event, body, connection, acting_user):
    """
    Stage multiple CSV/Markdown + metadata JSON file pairs in a single request.
    Duplicates (matched by s3_bucket + s3_key) are silently skipped.

    Request body:
    {
      "items": [
        {
          "type": "csv" | "markdown",
          "primary_file_name": "alumni.csv",
          "primary_s3_bucket": "...",
          "primary_s3_key": "...",
          "metadata_file_name": "alumni.csv.metadata.json",
          "metadata_s3_bucket": "...",
          "metadata_s3_key": "..."
        },
        ...
      ]
    }
    """
    created_by_user_id = acting_user["id"]
    items = body.get("items")

    if not isinstance(items, list) or len(items) == 0:
        return _response(event, 400, {"error": "items must be a non-empty array"})

    if len(items) > 100:
        return _response(event, 400, {"error": "Too many items. Maximum is 100 per batch."})

    staged = []
    skipped = []
    errors = []
    promoted_keys = []

    try:
        for i, item in enumerate(items):
            source_type = item.get("type")
            primary_file_name = item.get("primary_file_name")
            primary_s3_bucket = item.get("primary_s3_bucket")
            primary_s3_key = item.get("primary_s3_key")
            metadata_file_name = item.get("metadata_file_name")
            metadata_s3_bucket = item.get("metadata_s3_bucket")
            metadata_s3_key = item.get("metadata_s3_key")

            if source_type not in {"csv", "markdown"}:
                errors.append({"index": i, "error": "type must be csv or markdown"})
                continue

            if not all([primary_file_name, primary_s3_bucket, primary_s3_key,
                        metadata_file_name, metadata_s3_bucket, metadata_s3_key]):
                errors.append({"index": i, "file": primary_file_name, "error": "Missing required fields"})
                continue

            pair_error = _validate_file_pair(source_type, primary_file_name, metadata_file_name)
            if pair_error:
                errors.append({"index": i, "file": primary_file_name, "error": pair_error})
                continue

            try:
                primary_approved_key = _approved_key_for(primary_s3_bucket, primary_s3_key)
                metadata_approved_key = _approved_key_for(metadata_s3_bucket, metadata_s3_key)
            except InvalidUploadError as e:
                errors.append({"index": i, "file": primary_file_name, "error": str(e)})
                continue

            # Check for duplicates — skip silently
            if _existing_file_row_id(connection, s3_bucket=primary_s3_bucket, s3_key=primary_approved_key):
                skipped.append({"index": i, "file": primary_file_name, "reason": "already_staged"})
                continue

            if _existing_file_row_id(connection, s3_bucket=metadata_s3_bucket, s3_key=metadata_approved_key):
                skipped.append({"index": i, "file": metadata_file_name, "reason": "already_staged"})
                continue

            # Verify files exist in S3
            try:
                primary_size = _assert_s3_object_exists(primary_s3_bucket, primary_s3_key)
                _assert_s3_object_exists(metadata_s3_bucket, metadata_s3_key)
            except Exception as e:
                logger.error("S3 object not found for item %d: %s", i, e)
                errors.append({"index": i, "file": primary_file_name, "error": "File not found in S3"})
                continue

            item_promoted_keys = []
            try:
                part_keys = _promote_file_pair(
                    source_type=source_type,
                    primary_key=primary_s3_key,
                    primary_approved_key=primary_approved_key,
                    primary_size=primary_size,
                    metadata_key=metadata_s3_key,
                    metadata_approved_key=metadata_approved_key,
                    promoted_keys=item_promoted_keys,
                )
            except InvalidUploadError as e:
                _discard_promoted(item_promoted_keys)
                errors.append({"index": i, "file": primary_file_name, "error": str(e)})
                continue
            finally:
                promoted_keys.extend(item_promoted_keys)
            primary_s3_key, metadata_s3_key = primary_approved_key, metadata_approved_key

            primary_label = source_type  # "csv" or "markdown"

            primary_metadata = {
                "source": "staged_s3_file",
                "action": "staged_for_future_sync",
                "s3_bucket": primary_s3_bucket,
                "s3_key": primary_s3_key,
                "companion_file_name": metadata_file_name,
                "companion_s3_bucket": metadata_s3_bucket,
                "companion_s3_key": metadata_s3_key,
            }
            json_metadata = {
                "source": "staged_s3_file",
                "action": "staged_for_future_sync",
                "s3_bucket": metadata_s3_bucket,
                "s3_key": metadata_s3_key,
                "companion_file_name": primary_file_name,
                "companion_s3_bucket": primary_s3_bucket,
                "companion_s3_key": primary_s3_key,
            }
            # s3_key stays the logical key used for duplicate checks; ingestion reads the parts
            if part_keys:
                primary_metadata["s3_part_keys"] = part_keys
                json_metadata["s3_part_keys"] = [f"{k}.metadata.json" for k in part_keys]

            primary_ds_id = _insert_data_source_row(
                connection,
                name=primary_file_name,
                data_source_type=source_type,
                created_by_user_id=created_by_user_id,
                metadata=primary_metadata,
            )

            json_ds_id = _insert_data_source_row(
                connection,
                name=metadata_file_name,
                data_source_type="json",
                created_by_user_id=created_by_user_id,
                metadata=json_metadata,
            )

            _insert_ingestion_run_row(
                connection,
                data_source_row_id=primary_ds_id,
                status="pending",
                metadata={"source": f"staged_{primary_label}_file", "action": "awaiting_sync",
                          "s3_bucket": primary_s3_bucket, "s3_key": primary_s3_key},
            )

            _insert_ingestion_run_row(
                connection,
                data_source_row_id=json_ds_id,
                status="pending",
                metadata={"source": "staged_json_file", "action": "awaiting_sync",
                          "s3_bucket": metadata_s3_bucket, "s3_key": metadata_s3_key},
            )

            staged.append({"index": i, "file": primary_file_name,
                           "data_source_ids": [primary_ds_id, json_ds_id]})

        connection.commit()

        return _response(event, 200, {
            "message": f"Batch staging complete. {len(staged)} staged, {len(skipped)} skipped, {len(errors)} failed.",
            "staged_count": len(staged),
            "skipped_count": len(skipped),
            "error_count": len(errors),
            "staged": staged,
            "skipped": skipped,
            "errors": errors,
        })

    except Exception as e:
        connection.rollback()
        _discard_promoted(promoted_keys)
        logger.error("Batch staging failed: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Batch staging failed"})

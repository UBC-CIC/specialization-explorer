import os
import io
import csv
import json
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor

import boto3

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
KB_BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET_NAME"]

# Presigned uploads land under QUARANTINE_PREFIX, which the Bedrock data source does not read.
# An object enters the retrieval corpus only by being promoted to APPROVED_PREFIX after staging
# has validated it (the data source is limited to this prefix).
QUARANTINE_PREFIX = "quarantine/"
APPROVED_PREFIX = "uploads/"

# Semantic chunking rejects a document whose text exceeds 1,000,000 characters, and the
# chunking strategy cannot be changed on an existing data source. Larger CSV files are split
# into row groups below this size, each with the header row and a copy of the metadata file.
# Larger Markdown files cannot be split safely, so they are rejected at staging.
# https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html
MAX_DOCUMENT_CHARACTERS = 900_000
CSV_PART_UPLOAD_WORKERS = 8

s3_client = boto3.client("s3", region_name=REGION)


class InvalidUploadError(ValueError):
    pass


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


def _is_markdown_file(file_name: str) -> bool:
    lower_name = file_name.lower()
    return lower_name.endswith(".md") or lower_name.endswith(".markdown")


def _validate_file_pair(source_type: str, file_name: str, metadata_file_name: str) -> str | None:
    if source_type == "csv":
        if not file_name.endswith(".csv"):
            return "csv_file_name must end with .csv"
    elif source_type == "markdown":
        if not _is_markdown_file(file_name):
            return "markdown_file_name must end with .md or .markdown"
    else:
        return "Unsupported file source type"

    if not metadata_file_name.endswith(".json"):
        return "metadata_file_name must end with .json"

    expected_metadata_name = f"{file_name}.metadata.json"
    if metadata_file_name != expected_metadata_name:
        return (
            "metadata_file_name must exactly match the primary file base name as "
            f"'{expected_metadata_name}'"
        )

    return None


def _assert_s3_object_exists(bucket: str, key: str) -> int:
    """Verify that an uploaded file already exists in S3 before staging it; returns its size in bytes"""
    return s3_client.head_object(Bucket=bucket, Key=key)["ContentLength"]


def _approved_key_for(bucket: str, key: str) -> str:
    """The corpus key an uploaded object is promoted to; only presigned-upload keys qualify"""
    if bucket != KB_BUCKET:
        raise InvalidUploadError("Files must be in the knowledge base bucket")
    if (
        not isinstance(key, str)
        or not key.startswith(QUARANTINE_PREFIX)
        or key == QUARANTINE_PREFIX
        or ".." in key.split("/")
    ):
        raise InvalidUploadError(f"Files must be uploaded with a presigned URL (key under {QUARANTINE_PREFIX})")
    return APPROVED_PREFIX + key[len(QUARANTINE_PREFIX):]


def _promote_upload(key: str, approved_key: str):
    s3_client.copy_object(
        Bucket=KB_BUCKET,
        Key=approved_key,
        CopySource={"Bucket": KB_BUCKET, "Key": key},
    )


def _csv_part_key(approved_key: str, part_number: int) -> str:
    """uploads/dir/data.csv -> uploads/dir/data.part001.csv"""
    base = approved_key[: -len(".csv")] if approved_key.lower().endswith(".csv") else approved_key
    return f"{base}.part{part_number:03d}.csv"


def _split_csv_rows(key: str) -> list[str]:
    """
    Reads a CSV upload and returns its rows grouped into parts of at most
    MAX_DOCUMENT_CHARACTERS, each starting with the header row. Rows are parsed with the csv
    module, so quoted fields that contain line breaks stay in one row.
    """
    with tempfile.TemporaryFile() as raw:
        s3_client.download_fileobj(KB_BUCKET, key, raw)
        raw.seek(0)
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")

        def serialize(row: list[str]) -> str:
            buffer = io.StringIO()
            csv.writer(buffer).writerow(row)
            return buffer.getvalue()

        try:
            reader = csv.reader(text)
            header_row = next(reader, None)
            if header_row is None:
                raise InvalidUploadError("CSV file is empty")
            header = serialize(header_row)

            parts = []
            current = [header]
            current_length = len(header)
            for row in reader:
                line = serialize(row)
                if len(header) + len(line) > MAX_DOCUMENT_CHARACTERS:
                    raise InvalidUploadError(
                        f"A CSV row exceeds the {MAX_DOCUMENT_CHARACTERS:,}-character document limit"
                    )
                if current_length + len(line) > MAX_DOCUMENT_CHARACTERS:
                    parts.append("".join(current))
                    current = [header]
                    current_length = len(header)
                current.append(line)
                current_length += len(line)
            parts.append("".join(current))
        except UnicodeDecodeError:
            raise InvalidUploadError("Large CSV files must be UTF-8 encoded")
        except csv.Error as e:
            raise InvalidUploadError(f"CSV file could not be parsed: {e}")
        finally:
            text.detach()

    return parts


def _promote_file_pair(
    *,
    source_type: str,
    primary_key: str,
    primary_approved_key: str,
    primary_size: int,
    metadata_key: str,
    metadata_approved_key: str,
    promoted_keys: list[str],
) -> list[str] | None:
    """
    Copies a validated file and its metadata file into the ingested prefix.

    A CSV over the document limit is written as several part files instead of one copy, each
    with its own metadata file, and the part keys are returned. Otherwise returns None.
    Every key written is added to promoted_keys so a failed request can remove it.
    """
    # Byte size is an upper bound on the character count, so smaller files never need a split
    if primary_size <= MAX_DOCUMENT_CHARACTERS:
        _promote_upload(primary_key, primary_approved_key)
        promoted_keys.append(primary_approved_key)
        _promote_upload(metadata_key, metadata_approved_key)
        promoted_keys.append(metadata_approved_key)
        return None

    if source_type != "csv":
        raise InvalidUploadError(
            f"Markdown files must be under {MAX_DOCUMENT_CHARACTERS:,} characters; split the file and upload the parts"
        )

    parts = _split_csv_rows(primary_key)
    part_keys = [_csv_part_key(primary_approved_key, i) for i in range(1, len(parts) + 1)]
    logger.info("Splitting CSV %s into %d parts", primary_approved_key, len(parts))

    # Record the keys first, so a part that fails midway is still removed on cleanup
    for part_key in part_keys:
        promoted_keys.extend([part_key, f"{part_key}.metadata.json"])

    def write_part(index: int):
        part_key = part_keys[index]
        s3_client.put_object(
            Bucket=KB_BUCKET,
            Key=part_key,
            Body=parts[index].encode("utf-8"),
            ContentType="text/csv",
        )
        _promote_upload(metadata_key, f"{part_key}.metadata.json")

    with ThreadPoolExecutor(max_workers=CSV_PART_UPLOAD_WORKERS) as executor:
        list(executor.map(write_part, range(len(parts))))

    return part_keys


def _discard_promoted(approved_keys):
    """Remove copies made for a request that did not complete, so nothing unstaged is ingested"""
    for approved_key in approved_keys:
        try:
            s3_client.delete_object(Bucket=KB_BUCKET, Key=approved_key)
        except Exception as e:
            logger.error("Failed to remove promoted object %s: %s", approved_key, e)


def _existing_website_row_id(connection, *, name: str) -> str | None:
    """Check whether a website data source with the same URL already exists"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE type = %s::data_source_type
              AND name = %s
            LIMIT 1
            """,
            ("website", name),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _existing_file_row_id(connection, *, s3_bucket: str, s3_key: str) -> str | None:
    """Check whether a staged file already exists by matching its S3 bucket and key"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _insert_data_source_row(
    connection,
    *,
    name: str,
    data_source_type: str,
    created_by_user_id: str,
    metadata: dict,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
) -> str:
    """
    Insert a new row into data_sources
    This stores the staged source itself, but does not start ingestion
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO data_sources (
                name,
                type,
                include_patterns,
                exclude_patterns,
                created_by,
                metadata
            )
            VALUES (%s, %s::data_source_type, %s, %s, %s::uuid, %s::jsonb)
            RETURNING id
            """,
            (
                name,
                data_source_type,
                include_patterns,
                exclude_patterns,
                created_by_user_id,
                json.dumps(metadata),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _insert_ingestion_run_row(
    connection,
    *,
    data_source_row_id: str,
    status: str,
    metadata: dict | None = None,
) -> str:
    """
    Insert an initial ingestion_runs row for a staged source
    New staged sources start in 'pending' so they can later be promoted to
    'queued' when the admin clicks Sync
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, %s::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_row_id,
                status,
                json.dumps(metadata or {}),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def stage_data_sources(event, body, connection, acting_user):
    """
    Stage either a website, CSV/JSON pair, or markdown/JSON pair for future syncing

    This method:
    - validates the request
    - inserts the appropriate data_sources row(s)
    - creates matching ingestion_runs row(s) with status 'pending'
    - does NOT start ingestion or create schedulers

    Supported request types:
    - type = "website"
    - type = "csv"
    - type = "markdown"
    """
    source_type = body.get("type")
    created_by = acting_user["email"]
    created_by_user_id = acting_user["id"]
    promoted_keys = []

    if source_type not in {"website", "csv", "markdown"}:
        return _response(event, 400, {"error": "type must be one of: website, csv, markdown"})

    try:
        if source_type == "website":
            name = body.get("name")
            include_patterns = body.get("include_patterns", [])
            exclude_patterns = body.get("exclude_patterns", [])

            if not name:
                return _response(event, 400, {"error": "Missing name of the website"})

            if not isinstance(include_patterns, list):
                return _response(event, 400, {"error": "include_patterns must be an array"})

            if not isinstance(exclude_patterns, list):
                return _response(event, 400, {"error": "exclude_patterns must be an array"})

            existing_id = _existing_website_row_id(connection, name=name)
            if existing_id:
                return _response(
                    event,
                    409,
                    {
                        "error": "Website already exists in data_sources",
                        "existing_data_source_id": existing_id,
                        "name": name,
                    },
                )

            data_source_metadata = {
                "source": "staged_website",
                "action": "staged_for_future_sync",
            }

            data_source_id = _insert_data_source_row(
                connection,
                name=name,
                data_source_type="website",
                created_by_user_id=created_by_user_id,
                metadata=data_source_metadata,
                include_patterns=include_patterns if include_patterns else None,
                exclude_patterns=exclude_patterns if exclude_patterns else None,
            )

            ingestion_run_id = _insert_ingestion_run_row(
                connection,
                data_source_row_id=data_source_id,
                status="pending",
                metadata={
                    "source": "staged_website",
                    "action": "awaiting_sync",
                },
            )

            connection.commit()

            return _response(
                event,
                200,
                {
                    "message": "Website staged successfully.",
                    "action": "staged_website",
                    "type": "website",
                    "created_by": created_by,
                    "staged_data_source_ids": [data_source_id],
                    "pending_ingestion_run_ids": [ingestion_run_id],
                },
            )

        if source_type == "csv":
            primary_file_name = body.get("csv_file_name")
            primary_s3_bucket = body.get("csv_s3_bucket")
            primary_s3_key = body.get("csv_s3_key")
            primary_data_source_type = "csv"
            primary_source_label = "csv"
        else:
            primary_file_name = body.get("markdown_file_name")
            primary_s3_bucket = body.get("markdown_s3_bucket")
            primary_s3_key = body.get("markdown_s3_key")
            primary_data_source_type = "markdown"
            primary_source_label = "markdown"

        metadata_file_name = body.get("metadata_file_name")
        metadata_s3_bucket = body.get("metadata_s3_bucket")
        metadata_s3_key = body.get("metadata_s3_key")

        if not primary_file_name or not primary_s3_bucket or not primary_s3_key:
            return _response(event, 400, {"error": f"Missing {primary_source_label} file details"})

        if not metadata_file_name or not metadata_s3_bucket or not metadata_s3_key:
            return _response(event, 400, {"error": "Missing metadata JSON file details"})

        pair_error = _validate_file_pair(source_type, primary_file_name, metadata_file_name)
        if pair_error:
            return _response(event, 400, {"error": pair_error})

        try:
            primary_approved_key = _approved_key_for(primary_s3_bucket, primary_s3_key)
            metadata_approved_key = _approved_key_for(metadata_s3_bucket, metadata_s3_key)
        except InvalidUploadError as e:
            return _response(event, 400, {"error": str(e)})

        try:
            primary_size = _assert_s3_object_exists(primary_s3_bucket, primary_s3_key)
            _assert_s3_object_exists(metadata_s3_bucket, metadata_s3_key)
        except Exception as e:
            logger.error("Uploaded file not found in S3: %s", e, exc_info=True)
            return _response(event, 400, {"error": "One or both uploaded files do not exist in S3"})

        existing_primary_id = _existing_file_row_id(
            connection, s3_bucket=primary_s3_bucket, s3_key=primary_approved_key
        )
        if existing_primary_id:
            return _response(
                event,
                409,
                {
                    "error": f"{primary_source_label.capitalize()} file already exists in data_sources",
                    "existing_data_source_id": existing_primary_id,
                    "file_name": primary_file_name,
                },
            )

        existing_json_id = _existing_file_row_id(
            connection, s3_bucket=metadata_s3_bucket, s3_key=metadata_approved_key
        )
        if existing_json_id:
            return _response(
                event,
                409,
                {
                    "error": "Metadata JSON file already exists in data_sources",
                    "existing_data_source_id": existing_json_id,
                    "metadata_file_name": metadata_file_name,
                },
            )

        try:
            part_keys = _promote_file_pair(
                source_type=source_type,
                primary_key=primary_s3_key,
                primary_approved_key=primary_approved_key,
                primary_size=primary_size,
                metadata_key=metadata_s3_key,
                metadata_approved_key=metadata_approved_key,
                promoted_keys=promoted_keys,
            )
        except InvalidUploadError as e:
            _discard_promoted(promoted_keys)
            return _response(event, 400, {"error": str(e)})
        primary_s3_key, metadata_s3_key = primary_approved_key, metadata_approved_key

        primary_data_source_metadata = {
            "source": "staged_s3_file",
            "action": "staged_for_future_sync",
            "s3_bucket": primary_s3_bucket,
            "s3_key": primary_s3_key,
            "companion_file_name": metadata_file_name,
            "companion_s3_bucket": metadata_s3_bucket,
            "companion_s3_key": metadata_s3_key,
        }

        json_data_source_metadata = {
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
            primary_data_source_metadata["s3_part_keys"] = part_keys
            json_data_source_metadata["s3_part_keys"] = [f"{k}.metadata.json" for k in part_keys]

        primary_data_source_id = _insert_data_source_row(
            connection,
            name=primary_file_name,
            data_source_type=primary_data_source_type,
            created_by_user_id=created_by_user_id,
            metadata=primary_data_source_metadata,
        )

        json_data_source_id = _insert_data_source_row(
            connection,
            name=metadata_file_name,
            data_source_type="json",
            created_by_user_id=created_by_user_id,
            metadata=json_data_source_metadata,
        )

        primary_ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=primary_data_source_id,
            status="pending",
            metadata={
                "source": f"staged_{primary_source_label}_file",
                "action": "awaiting_sync",
                "s3_bucket": primary_s3_bucket,
                "s3_key": primary_s3_key,
            },
        )

        json_ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=json_data_source_id,
            status="pending",
            metadata={
                "source": "staged_json_file",
                "action": "awaiting_sync",
                "s3_bucket": metadata_s3_bucket,
                "s3_key": metadata_s3_key,
            },
        )

        connection.commit()

        return _response(
            event,
            200,
            {
                "message": f"{primary_source_label.capitalize()} and metadata JSON staged successfully.",
                "action": f"staged_{primary_source_label}_and_metadata",
                "type": source_type,
                "created_by": created_by,
                "staged_data_source_ids": [primary_data_source_id, json_data_source_id],
                "pending_ingestion_run_ids": [primary_ingestion_run_id, json_ingestion_run_id],
            },
        )

    except Exception as e:
        connection.rollback()
        _discard_promoted(promoted_keys)
        logger.error("Failed to stage data sources: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to stage data sources"})
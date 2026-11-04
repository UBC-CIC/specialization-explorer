import os
import json
import time
import logging
import boto3
from botocore.config import Config
from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET_NAME"]
REGION = os.environ["REGION"]

MAX_FILES = 200  # cap per batch request

# Largest object a presigned upload may carry; enforced by S3 through the signed POST policy
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "text/csv",
    "text/markdown",
    "application/json",
    "text/json",
    "application/octet-stream",
}

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"},
        region_name=REGION,
        signature_version="s3v4",
    ),
)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body),
    }


def _sanitize_file_name(file_name: str) -> str:
    return os.path.basename(file_name).strip()


def _infer_upload_prefix(file_name: str, content_type: str) -> str:
    lower = file_name.lower()
    if lower.endswith(".csv") or content_type == "text/csv":
        return "quarantine/csv"
    if lower.endswith(".md") or lower.endswith(".markdown") or content_type == "text/markdown":
        return "quarantine/markdown"
    if lower.endswith(".json") or content_type in {"application/json", "text/json"}:
        return "quarantine/json"
    return "quarantine/files"


def generate_presigned_urls_batch(event, body):
    files = body.get("files")

    if not isinstance(files, list) or len(files) == 0:
        return _response(event, 400, {"error": "files must be a non-empty array"})

    if len(files) > MAX_FILES:
        return _response(event, 400, {"error": f"Too many files. Maximum is {MAX_FILES} per batch."})

    timestamp = int(time.time())
    results = []

    for i, entry in enumerate(files):
        file_name = entry.get("file_name", "")
        content_type = entry.get("content_type", "application/octet-stream")

        file_name = _sanitize_file_name(file_name)
        if not file_name:
            return _response(event, 400, {"error": f"files[{i}]: invalid or missing file_name"})

        if content_type not in ALLOWED_CONTENT_TYPES:
            return _response(
                event,
                400,
                {"error": f"files[{i}]: unsupported content_type '{content_type}'"},
            )

        prefix = _infer_upload_prefix(file_name, content_type)
        key = f"{prefix}/{timestamp}_{file_name}"

        try:
            presigned_post = s3.generate_presigned_post(
                Bucket=BUCKET,
                Key=key,
                Fields={"Content-Type": content_type},
                Conditions=[
                    {"Content-Type": content_type},
                    ["content-length-range", 0, MAX_UPLOAD_BYTES],
                ],
                ExpiresIn=600,  # 10 min — longer window for batch uploads
            )
        except Exception as e:
            logger.error("Error generating presigned URL for %s: %s", file_name, e, exc_info=True)
            return _response(event, 500, {"error": f"Failed to generate presigned URL for {file_name}"})

        results.append({
            "file_name": file_name,
            "presigned_url": presigned_post["url"],
            "fields": presigned_post["fields"],
            "key": key,
            "bucket": BUCKET,
        })

    return _response(event, 200, {"presigned_urls": results})

import os
import json
from helpers.cors import get_cors_headers
import boto3
import logging
import psycopg2

from helpers.stage_data_sources import stage_data_sources
from helpers.stage_data_sources_batch import stage_data_sources_batch
from helpers.start_ingestion_job import start_ingestion_job
from helpers.generate_presigned_url import generate_presigned_url
from helpers.generate_presigned_urls_batch import generate_presigned_urls_batch
from helpers.update_status import update_status
from helpers.audit import audit_log, pick

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
KB_SECRET_NAME = os.environ["KB_SECRET_NAME"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# RDS Proxy presents an ACM certificate, so it is verified against the Amazon Trust Services
# roots rather than the RDS CA bundle. verify-full also checks the host name.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html
DB_CA_BUNDLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs", "amazon-root-ca.pem")

# Cached resources
connection = None
secret_cache = {}

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager", region_name=REGION)

def _get_secret(secret_name: str, expect_json: bool = True):
    if secret_name in secret_cache:
        return secret_cache[secret_name]

    try:
        response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        value = json.loads(response) if expect_json else response
        secret_cache[secret_name] = value
        return value
    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode JSON for secret '{secret_name}': {e}")
        raise ValueError(f"Secret '{secret_name}' is not properly formatted as JSON.")
    except Exception as e:
        logger.error(f"Error fetching secret '{secret_name}': {e}")
        raise

def _connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            db_secret = _get_secret(DB_SECRET_NAME, expect_json=True)
            connection_params = {
                'dbname': db_secret["dbname"],
                'user': db_secret["username"],
                'password': db_secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': db_secret["port"],
                'sslmode': 'verify-full',
                'sslrootcert': DB_CA_BUNDLE,
            }
            connection = psycopg2.connect(**connection_params)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def _resolve_admin_user(connection, event):
    """The acting administrator, from the verified token e-mail; None unless the users row has role 'admin'."""
    email = ((event.get("requestContext") or {}).get("authorizer") or {}).get("email")
    if not isinstance(email, str) or not email.strip():
        return None

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, email
            FROM users
            WHERE lower(email) = lower(%s) AND role = 'admin'::user_role
            LIMIT 1
            """,
            (email.strip(),),
        )
        row = cursor.fetchone()
    connection.commit()
    return {"id": str(row[0]), "email": row[1]} if row else None


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }

def _parse_body(event):
    body = {}
    raw_body = event.get("body")

    if not raw_body:
        return body

    try:
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            raise ValueError("Unsupported body format")
    except Exception as e:
        logger.error("Failed to parse body: %s", e)
        raise ValueError("Invalid JSON body")

    return body

def _is_scheduler_invocation(event):
    # API Gateway events carry a requestContext; only a direct scheduler invocation does not
    return event.get("task") == "poll_ingestion_run" and "requestContext" not in event


# Request fields recorded with the audit entry; bodies are otherwise left out of the logs
_AUDIT_BODY_FIELDS = [
    "type", "name", "include_patterns", "exclude_patterns",
    "csv_s3_key", "markdown_s3_key", "metadata_s3_key",
]


def _audit_details_from_body(body):
    if not isinstance(body, dict):
        return {}
    details = pick(body, _AUDIT_BODY_FIELDS)
    files = body.get("files")
    if isinstance(files, list):
        details["file_count"] = len(files)
    items = body.get("items")
    if isinstance(items, list):
        details["item_count"] = len(items)
        details["s3_keys"] = [
            k for item in items[:100] if isinstance(item, dict)
            for k in pick(item, ["primary_s3_key", "metadata_s3_key"]).values()
        ]
    return details


def handler(event, context=None):
    details = {}
    response = _handle(event, details)
    if not _is_scheduler_invocation(event):
        audit_log(event, response["statusCode"], privileged=True, details=details or None)
    return response


def _handle(event, audit_details):
    # Body and headers are omitted: the headers carry the caller's bearer token
    safe_event = {k: v for k, v in event.items() if k not in ('body', 'headers', 'multiValueHeaders')}
    logger.info("Event: %s (body and headers omitted)", json.dumps(safe_event))
    
    try:
        # Scheduler polling path
        # API Gateway events carry a requestContext; only a direct scheduler invocation does not
        if _is_scheduler_invocation(event):
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return _response(event, 500, {"error": "Error connecting to database"})

            return update_status(event=event, connection=connection)

        # API Gateway path
        caller_role = ((event.get("requestContext") or {}).get("authorizer") or {}).get("role")
        if caller_role != "admin":
            return _response(event, 403, {"error": "Admin access required"})

        method = event.get("httpMethod", "")
        resource = event.get("resource", "")

        try:
            connection = _connect_to_db()
        except Exception as e:
            logger.error(f"Error connecting to database: {e}")
            return _response(event, 500, {"error": "Error connecting to database"})

        # The acting administrator comes from the token, never from the request body
        acting_user = _resolve_admin_user(connection, event)
        if not acting_user:
            return _response(event, 403, {"error": "Admin access required"})

        # Route: GET /admin/generate-presigned-url
        if method == "GET" and resource == "/admin/generate-presigned-url":
            audit_details.update(pick(event.get("queryStringParameters"), ["file_name", "content_type"]))
            return generate_presigned_url(event=event)

        try:
            body = _parse_body(event)
        except ValueError as e:
            return _response(event, 400, {"error": str(e)})

        audit_details.update(_audit_details_from_body(body))

        # Route: POST /admin/generate-presigned-urls/batch
        if method == "POST" and resource == "/admin/generate-presigned-urls/batch":
            return generate_presigned_urls_batch(event=event, body=body)

        # Route: POST /admin/data_sources
        if method == "POST" and resource == "/admin/data_sources":
            return stage_data_sources(event=event, body=body, connection=connection, acting_user=acting_user)

        # Route: POST /admin/data_sources/batch
        if method == "POST" and resource == "/admin/data_sources/batch":
            return stage_data_sources_batch(event=event, body=body, connection=connection, acting_user=acting_user)

        # Everything below this point needs KB ID
        try:
            kb_id = _get_secret(KB_SECRET_NAME, expect_json=False)
        except Exception as e:
            logger.error(f"Error getting knowledge base ID: {e}")
            return _response(event, 500, {"error": "Error getting knowledge base ID"})

        # Route: POST /admin/data_sources/sync
        if method == "POST" and resource == "/admin/data_sources/sync":
            return start_ingestion_job(
                event=event,
                body=body,
                connection=connection,
                kb_id=kb_id,
                acting_user=acting_user,
            )

        return _response(
            event,
            404,
            {
                "error": "Route not found",
                "method": method,
                "resource": resource,
            },
        )

    except Exception as e:
        logger.error("Error: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Internal server error"})
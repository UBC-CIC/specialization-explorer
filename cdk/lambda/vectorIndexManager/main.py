import json
import time
import urllib.request
import urllib.error
import ssl

from botocore.awsrequest import AWSRequest
from botocore.auth import SigV4Auth
from botocore.credentials import Credentials
from botocore.session import Session


# Keep under Lambda timeout (900s) with headroom
COLLECTION_READY_MAX_ATTEMPTS = 18   # 18 * 10s = 180s (+ one 10s stabilization)
COLLECTION_READY_SLEEP_SECONDS = 10

PROPAGATION_DELAY_SECONDS = 90       # Increased to 90s for policy propagation

CREATE_INDEX_MAX_ATTEMPTS = 15       # Increased to 15 (15 * 15s = 225s)
CREATE_INDEX_SLEEP_SECONDS = 15

INDEX_VISIBLE_MAX_ATTEMPTS = 18      # 18 * 5s = 90s
INDEX_VISIBLE_SLEEP_SECONDS = 5


def _normalize_endpoint(endpoint: str) -> str:
    endpoint = endpoint.strip()
    if not endpoint.startswith("http://") and not endpoint.startswith("https://"):
        endpoint = "https://" + endpoint
    return endpoint.rstrip("/")


def _signed_request(method: str, url: str, region: str, body_obj=None):
    session = Session()
    creds = session.get_credentials()
    frozen = creds.get_frozen_credentials()

    body = None
    headers = {"content-type": "application/json"}
    if body_obj is not None:
        body = json.dumps(body_obj).encode("utf-8")

    aws_req = AWSRequest(method=method, url=url, data=body, headers=headers)
    SigV4Auth(
        Credentials(frozen.access_key, frozen.secret_key, frozen.token),
        "aoss",
        region
    ).add_auth(aws_req)
    prepared = aws_req.prepare()

    req = urllib.request.Request(
        prepared.url,
        data=body,
        method=method,
        headers=dict(prepared.headers.items()),
    )

    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context()) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8") if e.fp else ""
        return e.code, raw


def _wait_for_collection(endpoint: str, region: str,
                         max_attempts=COLLECTION_READY_MAX_ATTEMPTS,
                         sleep_seconds=COLLECTION_READY_SLEEP_SECONDS):
    """
    Collection endpoint readiness:
    - 200 means endpoint responds and caller can access _cat
    - 403 means endpoint exists but data access for this operation/principal is not allowed
    """
    last = None
    for attempt in range(1, max_attempts + 1):
        code, body = _signed_request("GET", endpoint + "/_cat/indices?v", region)
        print(f"Collection readiness attempt {attempt}: code={code}, body={body[:500]}")
        last = (code, body)

        if code == 200:
            time.sleep(10)
            return

        # Retry transient startup conditions
        if code in (401, 403, 429, 500, 502, 503, 504):
            time.sleep(sleep_seconds)
            continue

        time.sleep(sleep_seconds)

    raise RuntimeError(
        f"Timed out waiting for OpenSearch Serverless collection endpoint readiness. Last={last}"
    )


def _create_or_update_index(endpoint: str,
                            index_name: str,
                            region: str,
                            vector_field: str,
                            text_field: str,
                            metadata_field: str,
                            dimensions: int):
    mapping_body = {
        "settings": {
            "index": {
                "knn": True
            }
        },
        "mappings": {
            "properties": {
                vector_field: {
                    "type": "knn_vector",
                    "dimension": dimensions,
                    "method": {
                        "engine": "faiss",
                        "name": "hnsw",
                        "space_type": "l2"
                    }
                },
                text_field: {
                    "type": "text"
                },
                metadata_field: {
                    "type": "text",
                    "index": False
                }
            }
        }
    }

    create_url = f"{endpoint}/{index_name}"

    # Retry 403 errors more patiently - data access policy can take 60-90s to propagate
    consecutive_403 = 0
    last_error = None

    for attempt in range(1, CREATE_INDEX_MAX_ATTEMPTS + 1):
        code, body = _signed_request("PUT", create_url, region, mapping_body)
        print(f"Create index attempt {attempt}: code={code}, body={body[:1000]}")

        if code in (200, 201):
            return

        if code == 403:
            consecutive_403 += 1
            last_error = f"{code} {body}"
            # Allow more 403 retries - policy propagation can be slow
            # Only fail if we've exhausted all attempts
            if consecutive_403 >= CREATE_INDEX_MAX_ATTEMPTS:
                raise RuntimeError(
                    "Persistent 403 Forbidden creating index in AOSS after endpoint readiness. "
                    "This Lambda principal is not authorized by the OpenSearch Serverless data access policy "
                    f"for index operations on '{index_name}'. Last response: {body}"
                )
            print(f"Got 403 (attempt {consecutive_403}/{CREATE_INDEX_MAX_ATTEMPTS}). Data access policy may still be propagating...")
            time.sleep(CREATE_INDEX_SLEEP_SECONDS)
            continue
        else:
            consecutive_403 = 0

        if code == 400 and ("resource_already_exists_exception" in body or "already exists" in body.lower()):
            map_url = f"{endpoint}/{index_name}/_mapping"
            code2, body2 = _signed_request(
                "PUT",
                map_url,
                region,
                {"properties": mapping_body["mappings"]["properties"]}
            )
            print(f"Update mapping response: code={code2}, body={body2[:1000]}")
            if code2 in (200, 201):
                return

            raise RuntimeError(f"Failed to update index mapping: {code2} {body2}")

        # Retry only genuinely transient conditions
        if code in (401, 404, 409, 429, 500, 502, 503, 504):
            last_error = f"{code} {body}"
            time.sleep(CREATE_INDEX_SLEEP_SECONDS)
            continue

        raise RuntimeError(f"Failed to create index: {code} {body}")

    raise RuntimeError(f"Failed to create/update index after retries. Last error: {last_error}")


def _wait_for_index_visible(endpoint: str, index_name: str, region: str,
                            max_attempts=INDEX_VISIBLE_MAX_ATTEMPTS,
                            sleep_seconds=INDEX_VISIBLE_SLEEP_SECONDS):
    index_url = f"{endpoint}/{index_name}"
    cat_url = f"{endpoint}/_cat/indices/{index_name}?format=json"
    last = None

    for attempt in range(1, max_attempts + 1):
        code1, body1 = _signed_request("GET", index_url, region)
        code2, body2 = _signed_request("GET", cat_url, region)
        print(f"Index visibility attempt {attempt}: GET /index => {code1}, _cat => {code2}")
        last = (code1, body1, code2, body2)

        if code1 == 200 or code2 == 200:
            time.sleep(10)
            return

        time.sleep(sleep_seconds)

    raise RuntimeError(f"Timed out waiting for index visibility. Last responses: {last}")


def handler(event, context):
    print("Event:", json.dumps(event))
    
    # Debug: Print the Lambda execution role to verify it matches the data access policy
    import boto3
    sts = boto3.client('sts')
    identity = sts.get_caller_identity()
    print(f"Lambda execution role ARN: {identity['Arn']}")
    print(f"Account: {identity['Account']}")

    request_type = event.get("RequestType")

    # CDK Provider pattern: return objects; do NOT manually send ResponseURL replies
    if request_type == "Delete":
        # MUST preserve existing physical resource ID during delete/rollback
        existing_physical_id = event.get("PhysicalResourceId") or "vector-index-custom-resource"
        props = event.get("ResourceProperties", {}) or {}
        index_name = props.get("IndexName", "unknown-index")

        return {
            "PhysicalResourceId": existing_physical_id,
            "Data": {
                "IndexName": index_name,
                "SkippedDelete": "true",
            },
        }

    props = event.get("ResourceProperties", {})
    endpoint = _normalize_endpoint(props["CollectionEndpoint"])
    region = props["Region"]
    index_name = props["IndexName"]
    vector_field = props["VectorField"]
    text_field = props["TextField"]
    metadata_field = props["MetadataField"]
    dimensions = int(props["Dimensions"])

    # Reuse PhysicalResourceId on Update if present; set deterministic one on Create
    physical_id = event.get("PhysicalResourceId") or f"{index_name}-vector-index"

    _wait_for_collection(endpoint, region)

    print(f"Sleeping {PROPAGATION_DELAY_SECONDS}s to allow AOSS data access policy propagation...")
    time.sleep(PROPAGATION_DELAY_SECONDS)

    _create_or_update_index(
        endpoint=endpoint,
        index_name=index_name,
        region=region,
        vector_field=vector_field,
        text_field=text_field,
        metadata_field=metadata_field,
        dimensions=dimensions,
    )

    _wait_for_index_visible(endpoint, index_name, region)

    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "IndexName": index_name,
        },
    }
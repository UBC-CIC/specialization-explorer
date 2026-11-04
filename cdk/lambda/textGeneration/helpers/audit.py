import json
import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger("audit")
logger.setLevel(logging.INFO)

_SAFE_ID = re.compile(r"^[0-9a-zA-Z_-]{1,64}$")
_READ_ONLY_METHODS = {"GET", "HEAD", "OPTIONS"}
_MAX_VALUE_CHARS = 300
_MAX_LIST_ITEMS = 50


def _bounded(value):
    """Keeps a handler-supplied detail small and JSON-safe."""
    if isinstance(value, str):
        return value[:_MAX_VALUE_CHARS]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_bounded(v) for v in value[:_MAX_LIST_ITEMS]]
    return None


def pick(source, keys):
    """Copies only the named keys from a request mapping, bounded in size."""
    if not isinstance(source, dict):
        return {}
    return {k: _bounded(source[k]) for k in keys if k in source}


def _pick_target(path_parameters):
    return {
        k: v
        for k, v in (path_parameters or {}).items()
        if isinstance(v, str) and _SAFE_ID.match(v)
    }


def audit_log(event, status_code, privileged=False, details=None):
    """
    Writes one structured audit record for a request. Recorded for every state-changing
    request, every request to a privileged (admin) surface, and every denied request.
    Same record shape as the Node handlers' audit helper.
    """
    denied = status_code in (401, 403)
    changes_state = event.get("httpMethod") not in _READ_ONLY_METHODS
    if not privileged and not denied and not changes_state:
        return

    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}
    record = {
        "audit": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "requestId": request_context.get("requestId"),
        "actor": authorizer.get("userId") or authorizer.get("principalId") or "anonymous",
        "actorRole": authorizer.get("role") or "user",
        "sourceIp": (request_context.get("identity") or {}).get("sourceIp"),
        "action": f"{event.get('httpMethod')} {event.get('resource')}",
        "target": _pick_target(event.get("pathParameters")),
        "outcome": "denied" if denied else "failed" if status_code >= 400 else "success",
        "statusCode": status_code,
    }
    if details:
        record["details"] = details
    logger.info(json.dumps(record))

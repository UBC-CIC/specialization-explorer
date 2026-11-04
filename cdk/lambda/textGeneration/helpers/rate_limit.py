import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

RATE_WINDOW_SECONDS = 60

_dynamodb = None


def _client():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.client("dynamodb")
    return _dynamodb


def _parse_limit(value, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


MESSAGE_RATE_LIMIT = _parse_limit(os.environ.get("MESSAGE_RATE_LIMIT_PER_MINUTE"), 10)


class RateLimitUnavailableError(Exception):
    """The limiter could not be consulted; callers must fail closed."""


def consume_rate_limit(user_id: str, kind: str = "message", limit: int = MESSAGE_RATE_LIMIT) -> bool:
    """
    Counts one request in the user's current fixed window and returns False when the window is full.
    Uses the same table and item layout as the WebSocket default handler, so a user has one shared
    budget. The conditional update is atomic, so concurrent requests cannot exceed the limit.
    """
    now_seconds = int(time.time())
    window_start = now_seconds - (now_seconds % RATE_WINDOW_SECONDS)

    try:
        _client().update_item(
            TableName=os.environ["RATE_LIMIT_TABLE_NAME"],
            Key={"pk": {"S": f"{kind}#{user_id}#{window_start}"}},
            UpdateExpression="SET #expiresAt = if_not_exists(#expiresAt, :expiresAt) ADD #count :one",
            ConditionExpression="attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames={"#count": "requestCount", "#expiresAt": "expiresAt"},
            ExpressionAttributeValues={
                ":one": {"N": "1"},
                ":limit": {"N": str(limit)},
                # Kept one extra window so an item is never removed while it is still in use
                ":expiresAt": {"N": str(window_start + 2 * RATE_WINDOW_SECONDS)},
            },
        )
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        logger.error(f"Rate limit check failed: {e}")
        raise RateLimitUnavailableError() from e
    except Exception as e:
        logger.error(f"Rate limit check failed: {e}")
        raise RateLimitUnavailableError() from e

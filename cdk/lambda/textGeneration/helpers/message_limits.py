import logging
from datetime import datetime, timezone, timedelta
import helpers.config as config

logger = logging.getLogger(__name__)

def check_limit(user_id: str, db_connection) -> tuple[bool, dict]:
    """
    Checks if a user has exceeded their daily message limit.
    Always reads directly from the DB.
    Does NOT write to the DB.

    Returns:
        (is_under_limit: bool, usage_info: dict)
    """
    now_utc = datetime.now(timezone.utc)

    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                SELECT messages_sent, messages_window_started_at
                FROM users
                WHERE id = %s
                """,
                (user_id,)
            )
            row = cur.fetchone()

            if not row:
                logger.error("Message limit check for a user with no DB row")
                return False, {"error": "Unable to verify message limits from DB."}

            messages_sent = row[0] or 0
            window_start = row[1]

            if window_start is None:
                window_start = now_utc

            if window_start.tzinfo is None:
                window_start = window_start.replace(tzinfo=timezone.utc)

            if now_utc - window_start >= timedelta(hours=24):
                messages_sent = 0
                window_start = now_utc

            reset_at = (window_start + timedelta(hours=24)).isoformat()

            usage_info = {
                "messages_sent": messages_sent,
                "limit": config.MAX_MESSAGES_PER_DAY,
                "remaining": max(0, config.MAX_MESSAGES_PER_DAY - messages_sent),
                "reset_at": reset_at
            }

            return messages_sent < config.MAX_MESSAGES_PER_DAY, usage_info

    except Exception as e:
        logger.error(f"Error checking message limit DB: {e}")
        return False, {"error": "Unable to verify message limits from DB."}

def reserve_message(user_id: str, db_connection) -> tuple[bool, dict]:
    """
    Atomically charges one message to the user's daily allowance, resetting the 24-hour window
    if it has expired. The limit test and the increment happen in a single statement, so
    concurrent requests cannot all pass a check made before any of them is counted.

    Returns:
        (reserved: bool, usage_info: dict). When not reserved, usage_info describes the
        current usage (or carries an error).
    """
    now_utc = datetime.now(timezone.utc)

    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET
                    messages_sent = CASE
                        WHEN messages_window_started_at < NOW() - INTERVAL '24 hours' THEN 1
                        ELSE COALESCE(messages_sent, 0) + 1
                    END,
                    messages_window_started_at = CASE
                        WHEN messages_window_started_at < NOW() - INTERVAL '24 hours' THEN NOW()
                        ELSE messages_window_started_at
                    END
                WHERE id = %s
                  AND (
                      messages_window_started_at < NOW() - INTERVAL '24 hours'
                      OR COALESCE(messages_sent, 0) < %s
                  )
                RETURNING messages_sent, messages_window_started_at
                """,
                (user_id, config.MAX_MESSAGES_PER_DAY)
            )
            row = cur.fetchone()
        db_connection.commit()
    except Exception as e:
        logger.error(f"Error reserving a message: {e}")
        db_connection.rollback()
        return False, {"error": "Unable to verify message limits from DB."}

    if not row:
        # Either the user is at the limit or has no row; check_limit tells them apart
        return check_limit(user_id, db_connection)

    messages_sent = row[0] or 0
    window_start = row[1] or now_utc
    if window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=timezone.utc)

    return True, {
        "messages_sent": messages_sent,
        "limit": config.MAX_MESSAGES_PER_DAY,
        "remaining": max(0, config.MAX_MESSAGES_PER_DAY - messages_sent),
        "reset_at": (window_start + timedelta(hours=24)).isoformat()
    }

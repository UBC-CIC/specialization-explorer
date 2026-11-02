
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class DuplicateMessageError(Exception):
    """Raised when a message with the client-supplied id has already been saved."""


def get_exchange_count(chat_session_id: str, db_connection) -> int:
    """
    Counts the number of exchanges (User + AI pairs) in a session.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM chat_messages WHERE chat_session_id = %s", (chat_session_id,))
            msg_count = cur.fetchone()[0]
            # Each exchange is roughly 2 messages (User + AI)
            exchange_count = msg_count // 2
            return exchange_count
    except Exception as e:
        logger.error(f"Could not count history: {e}")
        return 0

def fetch_recent_messages(
    db_connection,
    chat_session_id: str,
) -> List[Dict[str, Any]]:    
    """
    Fetch the 20 most recent messages for a chat session, returned oldest->newest.
    Only sender and content are needed to build the model context.
    """
    with db_connection.cursor() as cur:
        # Newest first so LIMIT keeps the latest turns. The order matches the
        # idx_chat_messages_session_created_at index (chat_session_id, created_at, id).
        cur.execute(
            """
            SELECT sender, content, created_at
            FROM chat_messages
            WHERE chat_session_id = %s
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            (chat_session_id, 20)
        )
        rows = cur.fetchall()

    messages = []
    for sender, content, created_at in reversed(rows):
        messages.append({
            "sender": sender,          # 'user' or 'AI'
            "content": content,
            "created_at": created_at.isoformat() if created_at else None
        })
    return messages

def ensure_user_exists(db_connection, user_id: str) -> None:
    try:
        with db_connection.cursor() as cur:
            # We use a dummy email for now as we don't have it from the token in all cases yet
            dummy_email = f"user_{user_id[:8]}@example.com" 
            cur.execute(
                """
                INSERT INTO users (id, email, display_name, role, created_at, last_seen_at, messages_sent, messages_window_started_at, metadata)
                VALUES (%s, %s, %s, %s, NOW(), NOW(), 0, NOW(), '{}'::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                (user_id, dummy_email, "Student", "student")
            )
    except Exception as e:
        logger.error(f"ensure_user_exists failed: {e}")
        # Allow proceed as key constraint might be handled or user exists

def ensure_session_exists(db_connection, chat_session_id: str, user_id: Optional[str]) -> None:
    if not user_id:
        return
    ensure_user_exists(db_connection, user_id)
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_sessions (id, user_id, title, created_at, last_active_at)
                VALUES (%s, %s, %s, NOW(), NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (chat_session_id, user_id, "New Session")
            )
    except Exception as e:
        logger.error(f"ensure_session_exists failed: {e}")

def insert_message(
    db_connection,
    chat_session_id: str,
    sender: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None,
    warning: Optional[str] = None,
    message_id: Optional[str] = None,
) -> str:
    """
    Inserts a chat message. When the caller supplies message_id (a client-generated UUID),
    the insert is idempotent: if a row with that id already exists, nothing is written and
    DuplicateMessageError is raised so the request is not processed a second time.
    """
    client_supplied_id = message_id is not None
    message_id = message_id or str(uuid.uuid4())
    sources_json = json.dumps(sources or [])
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_messages (id, chat_session_id, sender, content, sources, warning, created_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, NOW())
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """,
                (message_id, chat_session_id, sender, content, sources_json, warning)
            )
            inserted = cur.fetchone()
    except Exception as e:
        logger.error(f"insert_message failed: {e}")
        raise e
    if inserted is None:
        if client_supplied_id:
            raise DuplicateMessageError("A message with this id has already been saved")
        # A server-generated UUID collided with an existing row; treat it as a failed insert
        raise RuntimeError("insert_message did not insert a row")
    return message_id

def message_exists(db_connection, message_id: str) -> bool:
    """
    Read-only check for an already-saved message id. Lets callers reject a replayed
    client-supplied id before doing any billable model work.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT 1 FROM chat_messages WHERE id = %s", (message_id,))
            return cur.fetchone() is not None
    except Exception as e:
        # Clear the aborted transaction so the reused connection stays usable
        db_connection.rollback()
        logger.error(f"message_exists failed: {e}")
        raise

def update_last_active_session(db_connection, chat_session_id: str) -> None:
    try:
        with db_connection.cursor() as cur:
            cur.execute("UPDATE chat_sessions SET last_active_at = NOW() WHERE id = %s", (chat_session_id,))
    except Exception as e:
        logger.error(f"update_last_active_session failed: {e}")

def fetch_system_config(db_connection) -> Dict[str, Any]:
    """
    Fetches system_messages (latest active version per type) and system_settings.
    """
    config = {'messages': {}, 'settings': {}}
    try:
        # Fetch System Messages
        # DISTINCT ON (type) ensures we get one row per type.
        # ORDER BY type, version DESC ensure that row is the highest version.
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (type) type, content
                FROM system_messages
                WHERE is_active = true
                ORDER BY type, version DESC
            """)
            rows = cur.fetchall()
            for row in rows:
                config['messages'][row[0]] = row[1]

        # Fetch System Settings
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT max_messages_per_day,
                       min_messages_before_suggest,
                       max_characters_per_user_message,
                       max_characters_per_ai_message,
                       temperature,
                       top_p,
                       support_score_threshold,
                       scope_alignment_score_threshold,
                       grounded_threshold,
                       partially_grounded_threshold,
                       specialization_list
                FROM system_settings
                ORDER BY updated_at DESC
                LIMIT 1
            """)
            row = cur.fetchone()
            if row:
                config['settings'] = {
                    'max_messages_per_day': row[0],
                    'min_messages_before_suggest': row[1],
                    'max_characters_per_user_message': row[2],
                    'max_characters_per_ai_message': row[3],
                    'temperature': float(row[4]) if row[4] is not None else 0.7,
                    'top_p': float(row[5]) if row[5] is not None else 0.9,
                    'support_score_threshold': float(row[6]) if row[6] is not None else 0.25,
                    'scope_alignment_score_threshold': float(row[7]) if row[7] is not None else 0.25,
                    'grounded_threshold': float(row[8]) if row[8] is not None else 0.75,
                    'partially_grounded_threshold': float(row[9]) if row[9] is not None else 0.50,
                    'specialization_list': row[10]
                }
    except Exception as e:
        logger.error(f"fetch_system_config failed: {e}")
        # Return what we have (empty or partial)
    return config

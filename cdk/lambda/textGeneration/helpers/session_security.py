import uuid
import logging 

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def sanitize_session_id(session_id: str) -> str:
    # Check 1: Reject a session id that's empty/None 

    if not session_id: 
        raise ValueError("Session ID is empty or None")

    # Check 2: Remove any whitespace 
    session_id = session_id.strip()

    # Check 3: Rejection anything that's not a valid uuid 
    try: 
        parsed = uuid.UUID(session_id)
    except ValueError:
        raise ValueError(f"Invalid session ID: {session_id}")
    
    # Return the canonical form: Python accepts prefixes, braces and misplaced
    # hyphens that Postgres rejects, so the raw string must not reach the query
    return str(parsed)

def _rollback(db_connection) -> None:
    # Clear the aborted transaction so the reused connection stays usable
    try:
        db_connection.rollback()
    except Exception as e:
        logger.error(f"Rollback failed: {e}")


def validate_session_ownership(db_connection, session_id: str, user_id: str) -> bool:
    if not session_id or not user_id: 
        logger.error("Session ID or user ID is empty or None")
        return False
    
    try: 
        with db_connection.cursor() as cursor: 
            cursor.execute("SELECT 1 FROM chat_sessions WHERE id = %s AND user_id = %s", (session_id, user_id))
            result = cursor.fetchone()
            is_owner = (result is not None)

            if not is_owner: 
                logger.warning(f"User{user_id} does not own chat session: {session_id}")
            
            return is_owner
        
    except Exception as e: 
        _rollback(db_connection)
        logger.error(f"DB Error: {e}")
        return False


def session_exists(db_connection, session_id: str) -> bool:
    try:
        with db_connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM chat_sessions WHERE id = %s", (session_id,))
            return cursor.fetchone() is not None
    except Exception as e:
        _rollback(db_connection)
        logger.error(f"DB Error: {e}")
        return True

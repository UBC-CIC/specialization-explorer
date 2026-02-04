import json
import logging
import uuid
from typing import Any, Dict, List, Optional

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# -----------------------------
# DB helpers
# -----------------------------
def _fetch_recent_messages(
    db_connection,
    chat_session_id: str,
    limit: int = 200
) -> List[Dict[str, Any]]:
    """
    Fetch recent messages for a chat session (oldest->newest).
    Returns list of dicts: {sender, content, created_at}
    """
    with db_connection.cursor() as cur:
        cur.execute(
            """
            SELECT sender, content, created_at
            FROM chat_messages
            WHERE chat_session_id = %s
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (chat_session_id, limit)
        )
        rows = cur.fetchall()

    messages = []
    for sender, content, created_at in rows:
        messages.append({
            "sender": sender,          # 'user' or 'AI'
            "content": content,
            "created_at": created_at.isoformat() if created_at else None
        })
    return messages


def _insert_message(
    db_connection,
    chat_session_id: str,
    sender: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None
) -> str:
    """
    Insert a single message into chat_messages.
    Returns the inserted message UUID (string).
    """
    message_id = str(uuid.uuid4())
    sources_json = json.dumps(sources or [])

    with db_connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO chat_messages (id, chat_session_id, sender, content, sources, created_at)
            VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
            """,
            (message_id, chat_session_id, sender, content, sources_json)
        )

    return message_id


def _touch_session(
    db_connection,
    chat_session_id: str
) -> None:
    """
    Update last_active_at for a chat session.
    """
    with db_connection.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_sessions
            SET last_active_at = NOW()
            WHERE id = %s
            """,
            (chat_session_id,)
        )


# -----------------------------
# KB citation normalization
# -----------------------------
def _normalize_sources_from_kb_response(kb_resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    sources: List[Dict[str, Any]] = []

    citations = kb_resp.get("citations") or []
    for c in citations:
        refs = c.get("retrievedReferences") or []
        for ref in refs:
            location = ref.get("location") or {}
            meta = ref.get("metadata") or {}

            url = None
            if location.get("type") == "WEB":
                url = (location.get("webLocation") or {}).get("url")
            elif location.get("type") == "S3":
                url = (location.get("s3Location") or {}).get("uri")

            page = meta.get("x-amz-bedrock-kb-document-page-number")
            data_source_id = meta.get("x-amz-bedrock-kb-data-source-id")
            source_uri = meta.get("x-amz-bedrock-kb-source-uri") or url

            sources.append({
                "type": location.get("type") or "UNKNOWN",
                "uri": source_uri,
                "url": url,
                "page": int(page) if isinstance(page, (int, float)) else None,
                "data_source_id": data_source_id,
            })

    # de-dupe while preserving order
    seen = set()
    deduped = []
    for s in sources:
        key = (s.get("uri"), s.get("page"), s.get("data_source_id"))
        if key not in seen:
            seen.add(key)
            deduped.append(s)

    return deduped


def _extract_answer_text(kb_resp: Dict[str, Any]) -> str:
    out = kb_resp.get("output") or {}
    return out.get("text") or ""


# -----------------------------
# Prompting
# -----------------------------
def _build_llama3_kb_input_text(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_query: str,
    is_first_message: bool,
    max_ai_chars: int
) -> str:
    """
    Build a Llama-3 style prompt *as a single string* because KB RnG only takes input.text.

    We instruct the model to stay within max_ai_chars, so we don't pay for extra output
    only to truncate it.
    """
    system_prompt = (system_prompt or "").strip()

    # conversation transcript
    if is_first_message:
        history_block = "This is the first message in the conversation."
    else:
        lines = []
        for m in history:
            role = "user" if m["sender"] == "user" else "assistant"
            # Keep it simple and consistent with Llama3 headers
            if role == "user":
                lines.append(f"User: {m['content']}")
            else:
                lines.append(f"Assistant: {m['content']}")
        history_block = "\n".join(lines)

    # Llama 3-ish format (single string)
    return (
        "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
        f"{system_prompt}\n\n"
        f"Rules:\n"
        f"- Use the knowledge base context when available.\n"
        f"- If you are unsure, say you don't know based on the knowledge base.\n"
        f"- Your answer MUST be at most {max_ai_chars} characters.\n"
        f"- Do not include any preamble.\n"
        "<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n"
        f"Conversation so far:\n{history_block}\n\n"
        f"User question: {user_query}\n"
        "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
    )


# -----------------------------
# Public API called by notebook
# -----------------------------
def get_response(
    query: str,
    knowledge_base_id: str,
    model_arn: str,
    bedrock_region: str,
    chat_session_id: str,
    user_id: Optional[str],   # unused for now
    system_prompt: str,
    db_connection,
    max_history_messages: int = 20,   # This is MAX_MESSAGES_PER_SESSION (exchanges)
    max_chars_user: int = 2000,
    max_chars_ai: int = 4000,
) -> Dict[str, Any]:
    """
    - If query exceeds max_chars_user: exit early (no DB insert, no KB call)
    - If #exchanges >= max_history_messages: exit early (no KB call)
    - Otherwise:
        - load full message history for session
        - insert user message
        - call KB retrieve_and_generate with Llama3-style prompt including system_prompt
        - insert AI message
    """
    _ = user_id  # keep signature stable

    # Validate user input length (hard stop)
    query = (query or "")
    if not query.strip():
        return {"response": "Please provide a non-empty question.", "sources_used": [], "is_first_message": False}

    if len(query) > max_chars_user:
        return {
            "response": f"Your message is too long. Please keep it under {max_chars_user} characters.",
            "sources_used": [],
            "is_first_message": False,
        }

    query = query.strip()

    # Load full history (we need it for exchange counting + prompt)
    # We fetch up to 2*max_history_messages messages because an exchange is user+AI
    max_messages_to_fetch = max_history_messages * 2
    history = _fetch_recent_messages(db_connection, chat_session_id, limit=max_messages_to_fetch)

    # Exchange-limit enforcement (hard stop, no KB call)
    # We count exchanges as min(#user_msgs, #ai_msgs), but simplest: total messages >= 2*max_exchanges
    if len(history) >= (max_history_messages * 2):
        return {
            "response": f"This conversation has reached the limit of {max_history_messages} exchanges. Please start a new conversation.",
            "sources_used": [],
            "is_first_message": False,
            "session_limit_reached": True
        }

    is_first = (len(history) == 0)

    # Insert user message
    try:
        _insert_message(
            db_connection=db_connection,
            chat_session_id=chat_session_id,
            sender="user",
            content=query,
            sources=None
        )
        _touch_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to insert user message: {e}", exc_info=True)

    # Build KB input using Llama3 template + your SYSTEM_PROMPT
    kb_input_text = _build_llama3_kb_input_text(
        system_prompt=system_prompt,
        history=history,
        user_query=query,
        is_first_message=is_first,
        max_ai_chars=max_chars_ai
    )

    # Call Bedrock KB
    client = boto3.client("bedrock-agent-runtime", region_name=bedrock_region)

    try:
        kb_resp = client.retrieve_and_generate(
            input={"text": kb_input_text},
            retrieveAndGenerateConfiguration={
                "type": "KNOWLEDGE_BASE",
                "knowledgeBaseConfiguration": {
                    "knowledgeBaseId": knowledge_base_id,
                    "modelArn": model_arn,
                },
            },
        )

        answer_text = _extract_answer_text(kb_resp).strip()
        if not answer_text:
            answer_text = "I couldn't find an answer from the knowledge base."

        # IMPORTANT: no truncation here. We rely on prompt constraint.
        sources_used = _normalize_sources_from_kb_response(kb_resp)

    except Exception as e:
        logger.error(f"KB retrieve_and_generate failed: {e}", exc_info=True)
        answer_text = "Sorry, I encountered an error while answering your question."
        sources_used = []

    # Insert AI message
    try:
        _insert_message(
            db_connection=db_connection,
            chat_session_id=chat_session_id,
            sender="AI",
            content=answer_text,
            sources=sources_used
        )
        _touch_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to insert AI message: {e}", exc_info=True)

    return {"response": answer_text, "sources_used": sources_used, "is_first_message": is_first}
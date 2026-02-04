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
    # KB retrieval configuration
    num_retrieval_results: int = 10,  # Balance between coverage and context limit
    search_type: str = "HYBRID",      # "HYBRID" or "SEMANTIC"
    # KB generation configuration
    max_tokens: int = 2048,           # Llama 3 70B limit is 2048
    temperature: float = 0.2,
    top_p: float = 0.9,
) -> Dict[str, Any]:
    """
    Two-step RAG approach:
    1. retrieve() - Query KB with CLEAN query to get relevant chunks
    2. invoke_model() - Generate response with full prompt (system prompt + context + instructions)
    
    This separation ensures:
    - Retrieval uses clean semantic search (no instruction pollution)
    - Generation has full control over prompt (follow-up questions, tone, etc.)
    - Conversation history is managed via our PostgreSQL DB
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

    # TWO-STEP APPROACH (separates retrieval from generation for full prompt control)
    # Step 1: retrieve() with CLEAN query → get relevant chunks from KB
    # Step 2: invoke_model() with full Llama3 prompt → generate response with instructions
    
    agent_client = boto3.client("bedrock-agent-runtime", region_name=bedrock_region)
    bedrock_client = boto3.client("bedrock-runtime", region_name=bedrock_region)

    try:
        # ========== STEP 1: RETRIEVE ==========
        # Use CLEAN query only - no instructions that would pollute semantic search
        retrieve_response = agent_client.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {
                    "numberOfResults": num_retrieval_results,
                    "overrideSearchType": search_type,
                }
            },
        )
        
        # Extract chunks and build sources from retrieval results
        retrieval_results = retrieve_response.get("retrievalResults", [])
        logger.info(f"KB retrieval: {len(retrieval_results)} chunks retrieved")
        
        chunks = []
        sources_used = []
        
        for result in retrieval_results:
            # Extract text content
            content_text = result.get("content", {}).get("text", "")
            if content_text:
                chunks.append(content_text)
            
            # Extract source metadata
            location = result.get("location", {})
            metadata = result.get("metadata", {})
            
            # Determine URL based on location type
            url = None
            loc_type = location.get("type", "UNKNOWN")
            if loc_type == "WEB":
                url = (location.get("webLocation") or {}).get("url")
            elif loc_type == "S3":
                url = (location.get("s3Location") or {}).get("uri")
            
            source_uri = metadata.get("x-amz-bedrock-kb-source-uri") or url
            page_num = metadata.get("x-amz-bedrock-kb-document-page-number")
            
            sources_used.append({
                "type": loc_type,
                "uri": source_uri,
                "url": url,
                "page": int(page_num) if page_num is not None else None,
                "data_source_id": metadata.get("x-amz-bedrock-kb-data-source-id"),
                "score": result.get("score"),
            })
        
        # De-duplicate sources while preserving order
        seen_sources = set()
        deduped_sources = []
        for src in sources_used:
            key = (src.get("uri"), src.get("page"))
            if key not in seen_sources:
                seen_sources.add(key)
                deduped_sources.append(src)
        sources_used = deduped_sources

        # ========== STEP 2: GENERATE ==========
        # Build full Llama 3 prompt with system prompt, context, and instructions
        
        # Format context from retrieved chunks
        if chunks:
            context_block = "\n\n---\n\n".join(chunks)
        else:
            context_block = "No relevant information was found in the knowledge base."
        
        # Build conversation history from DB (for multi-turn context)
        history_block = ""
        if history:
            recent_history = history 
            history_lines = []
            for msg in recent_history:
                role = "Student" if msg["sender"] == "user" else "Assistant"
                content = msg["content"][:300] + "..." if len(msg["content"]) > 300 else msg["content"]
                history_lines.append(f"{role}: {content}")
            history_block = "\n".join(history_lines)
        
        # Llama 3 Instruct format
        prompt = f"""<|begin_of_text|><|start_header_id|>system<|end_header_id|>

{system_prompt}

IMPORTANT RULES:
- Use ONLY the knowledge base context provided below to answer.
- If the context doesn't contain the answer, say "I don't have that information in my knowledge base."
- Keep your response concise (2-3 paragraphs maximum).
- ALWAYS end your response with a specific follow-up question to learn more about the student's interests or goals.
- Be conversational and friendly.
<|eot_id|><|start_header_id|>user<|end_header_id|>

"""
        # Add conversation history if exists
        if history_block:
            prompt += f"Previous conversation:\n{history_block}\n\n---\n\n"
        
        prompt += f"""Knowledge base context:
{context_block}

---

Current question: {query}
<|eot_id|><|start_header_id|>assistant<|end_header_id|>

"""
        
        # Call Llama 3 70B directly
        llm_response = bedrock_client.invoke_model(
            modelId="meta.llama3-70b-instruct-v1:0",
            body=json.dumps({
                "prompt": prompt,
                "max_gen_len": max_tokens,
                "temperature": temperature,
                "top_p": top_p,
            }),
            contentType="application/json",
            accept="application/json",
        )
        
        # Parse response
        response_body = json.loads(llm_response["body"].read())
        answer_text = response_body.get("generation", "").strip()
        
        if not answer_text:
            answer_text = "I couldn't generate a response. Please try rephrasing your question."

    except Exception as e:
        logger.error(f"KB retrieve/generate failed: {e}", exc_info=True)
        answer_text = "Sorry, I encountered an error while processing your question."
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

    return {
        "response": answer_text,
        "sources_used": sources_used,
        "is_first_message": is_first,
    }
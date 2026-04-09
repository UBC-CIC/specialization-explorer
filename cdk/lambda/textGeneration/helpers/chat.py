import boto3
from botocore.config import Config
import logging
from typing import Dict, Any, Optional, List, Tuple

from helpers.crud import (
    fetch_recent_messages, ensure_session_exists, insert_message, update_last_active_session
)
from helpers.logic import get_current_prompt
from helpers.bedrock import retrieve_documents, format_context_for_prompt
from helpers.intervention import assess_response
import helpers.config as config
from helpers.token_limits import check_limit, record_usage

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def _rewrite_query_for_retrieval(
    raw_query: str,
    chat_history: List[Dict[str, Any]],
    llm_region: str,
    haiku_model_arn: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0" 
) -> str:
    """
    Uses a fast, low-cost LLM call to rewrite a conversational user query into a
    keyword-rich search query optimized for vector database retrieval.
    Falls back to the raw query on any error.
    """
    # Build a condensed history string (last few exchanges only)
    history_lines = []
    for msg in chat_history[-6:]:
        role = "User" if msg["sender"] == "user" else "Assistant"
        history_lines.append(f"{role}: {msg['content']}")
    history_block = "\n".join(history_lines) if history_lines else "(no prior conversation)"

    rewrite_system_prompt = """
<instructions>
You are a search query optimizer for a university specialization database.
Given the conversation history and the user's latest message, generate a short, keyword-rich search query to find relevant documents.
Focus on academic subjects, degree requirements, career goals, and specific interests mentioned.
Output ONLY the search query. Do not include explanations, preambles, or quotes.
</instructions>
"""

    user_message = f"""
<conversation_history>
{history_block}
</conversation_history>

<latest_user_message>
{raw_query}
</latest_user_message>
"""

    try:
        bedrock_config = Config(
            retries={
                'max_attempts': 3,
                'mode': 'adaptive'  
            },
            connect_timeout= 5,
            read_timeout= 60
        )
        bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region, config=bedrock_config)
        response = bedrock_runtime.converse(
            modelId=haiku_model_arn,
            messages=[{"role": "user", "content": [{"text": user_message}]}],
            system=[{"text": rewrite_system_prompt}],
            inferenceConfig={
                "maxTokens": 50,  
                "temperature": 0.0
            }
        )
        rewritten = response["output"]["message"]["content"][0]["text"].strip()
        logger.info(f"Query rewrite: '{raw_query}' -> '{rewritten}'")
        return rewritten if rewritten else raw_query
    except Exception as e:
        logger.warning(f"Query rewrite failed, using raw query: {e}")
        return raw_query

def _prepare_conversation(
    query: str,
    knowledge_base_id: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    search_type: Optional[str] = None,
    save_user_message: bool = True
) -> Tuple[List[Dict[str, Any]], str, List[Dict[str, Any]], str]:
    """
    Handles validation, history fetching, user msg saving, retrieval, and prompt construction.
    Returns: (bedrock_messages, full_system_prompt, sources, phase_name)
    """
    # Resolve dynamic defaults
    if search_type is None:
        search_type = config.SEARCH_TYPE

    # 1. Validation
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # Query Length Validation 
    if len(query) > config.MAX_CHARACTERS_PER_USER_MESSAGE: 
        raise ValueError(f"Message exceeds the maximum allowed length of {config.MAX_CHARACTERS_PER_USER_MESSAGE} characters.")

    # 2. Retrieve History
    raw_history = fetch_recent_messages(db_connection, chat_session_id)
    
    # 3. Save User Message
    try:
        if save_user_message:
            ensure_session_exists(db_connection, chat_session_id, user_id)
            insert_message(
                db_connection,
                chat_session_id,
                "user",
                query,
                sources=None,
                warning=None
            )
            update_last_active_session(db_connection, chat_session_id)
            db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"DB Error: {e}")
        raise

    # 4. Determine Phase & Prompt
    current_system_prompt, num_retrieval_results, phase_name = get_current_prompt(
        chat_session_id,
        db_connection
    )

    # 5. Rewrite query for better retrieval
    search_query = _rewrite_query_for_retrieval(
        raw_query=query,
        chat_history=raw_history,
        llm_region=llm_region
    )

    # 6. RAG Retrieval (using rewritten query)
    sources = retrieve_documents(
        search_query,
        knowledge_base_id,
        region,
        num_retrieval_results,
        search_type=search_type
    )
    
    # 7. Build Context
    context_block = format_context_for_prompt(sources)
    
    # 8. Construct Final System Prompt
    full_system_prompt = f"""{current_system_prompt}

<retrieved_context>
{context_block}
</retrieved_context>

<response_instructions>
1. Answer the user's question using the retrieved_context if relevant.
2. If the user is just chatting (e.g. "hello", "thanks"), respond naturally.
3. If the retrieved context does not clearly support the answer, say you do not have enough grounded information and ask a clarifying question.
4. Do NOT invent course names, requirements, or specialization details that are not supported by the retrieved context.

You MUST wrap your conversational response to the user in <answer> tags.
After your answer, you MUST list the integer indices of the sources you actively used inside <cited_indices> tags as a JSON array (e.g., <cited_indices>[1, 3]</cited_indices>). If none, use <cited_indices>[]</cited_indices>.
</response_instructions>
"""

    # 9. Build Messages
    bedrock_messages = []
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        if msg["content"]:
            bedrock_messages.append({
                "role": role,
                "content": [{"text": msg["content"]}]
            })
            
    bedrock_messages.append({
        "role": "user",
        "content": [{"text": query}]
    })

    return bedrock_messages, full_system_prompt, sources, phase_name

def _save_ai_response(
    db_connection,
    chat_session_id: str,
    answer_text: str,
    sources: List[Dict[str, Any]],
    warning_text: Optional[str] = None,
):
    try:
        sources_for_db = []
        for s in sources:
            s_copy = s.copy()
            if 'content' in s_copy and isinstance(s_copy['content'], str):
                s_copy['content'] = s_copy['content']
            sources_for_db.append(s_copy)

        insert_message(
            db_connection,
            chat_session_id,
            "AI",
            answer_text,
            sources_for_db,
            warning_text
        )
        update_last_active_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to save AI response: {e}")

def get_response(
    query: str,
    knowledge_base_id: str,
    model_arn: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True,
    stream_callback=None
) -> Dict[str, Any]:
    
    usage_info = {}
    is_under_limit = True

    try:
        if user_id:
            is_under_limit, usage_info = check_limit(user_id, db_connection)
            if not is_under_limit:
                return {
                    "response": "Daily token limit exceeded. Please try again tomorrow.",
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "is_first_message": False,
                    "token_limit_exceeded": True,
                    "token_usage": usage_info,
                    "warning": None,
                    "intervention": None
                }

        bedrock_messages, full_system_prompt, sources, phase_name = _prepare_conversation(
            query,
            knowledge_base_id,
            region,
            llm_region,
            chat_session_id,
            user_id,
            db_connection,
            save_user_message=save_user_message
        )
    except ValueError as e:
        return {
            "response": str(e),
            "sources_used": [],
            "warning": None,
            "intervention": None
        }
    except Exception as e:
        logger.error(f"Prepare conversation failed: {e}")
        return {
            "response": "An error occurred.",
            "sources_used": [],
            "warning": None,
            "intervention": None,
        }

    request_payload = {
        "modelId": model_arn,
        "messages": bedrock_messages,
        "system": [{"text": full_system_prompt}],
        "inferenceConfig": {
            "maxTokens": config.MAX_TOKENS,
            "temperature": config.TEMPERATURE
        },
        "additionalModelRequestFields": {
            "thinking": {"type": "disabled"},
            "output_config": {"effort": "low"}
        }
    }

    bedrock_config = Config(
        retries={
            'max_attempts': 3,
            'mode': 'adaptive'
        },
        connect_timeout=5,
        read_timeout=60
    )
    bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region, config=bedrock_config)
    
    full_response_text = ""
    answer_text = ""
    cited_indices = []
    last_answer_len = 0

    import re
    try:
        response = bedrock_runtime.converse_stream(**request_payload)
        for event in response.get("stream", []):
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    chunk = delta["text"]
                    full_response_text += chunk
                    
                    # Look for answer tags; if present, use the content inside, else use the whole text
                    match = re.search(r'<answer>(.*)', full_response_text, re.DOTALL)
                    if match:
                        current_answer = match.group(1)
                    else:
                        current_answer = full_response_text
                        
                    # Remove cited indices or unexpected closing tags from the stream
                    current_answer = current_answer.split('</answer>')[0].split('<cited')[0]
                    
                    is_closed = '</answer>' in full_response_text or '<cited' in full_response_text
                    
                    if is_closed:
                        safe_answer = current_answer
                    else:
                        # Withhold the last 15 characters to prevent accidental output of tag fragments
                        safe_answer = current_answer[:-15] if len(current_answer) > 15 else ""
                    
                    if len(safe_answer) > last_answer_len:
                        new_text = safe_answer[last_answer_len:]
                        last_answer_len = len(safe_answer)
                        if stream_callback:
                            stream_callback(new_text)

        # Parse final answer text properly
        final_answer_match = re.search(r'<answer>(.*?)</answer>', full_response_text, re.DOTALL)
        if final_answer_match:
            answer_text = final_answer_match.group(1).strip()
        else:
            answer_text = full_response_text.split('<cited_indices>')[0].strip()
            
        # Ensure any remaining buffered text (or the entire text if the model forgot tags) is pushed
        if stream_callback and answer_text and len(answer_text) > last_answer_len:
            stream_callback(answer_text[last_answer_len:])
            
        # Parse cited_indices
        indices_match = re.search(r'<cited_indices>\s*\[(.*?)\]\s*</cited_indices>', full_response_text, re.DOTALL)
        if indices_match:
            indices_str = indices_match.group(1).strip()
            if indices_str:
                try:
                    cited_indices = [int(x.strip()) for x in indices_str.split(',')]
                except ValueError:
                    pass

    except Exception as e:
        logger.error(f"Generation Failed: {e}")
        answer_text = "I encountered an error generating the response."
        cited_indices = []

    used_sources = []
    for i, source in enumerate(sources, 1):
        if i in cited_indices:
            used_sources.append(source)

    warning_text = None
    intervention_result = None

    if phase_name == "SUGGESTION" and answer_text and not answer_text.startswith("I encountered an error"):
        try:
            intervention_result = assess_response(
                query=query,
                answer_text=answer_text,
                sources=used_sources,
                llm_region=llm_region,
                verifier_model_id=model_arn,
            )
            warning_text = intervention_result.get("warning_text")
        except Exception as e:
            logger.error(f"Intervention Failed: {e}")
            warning_text = None
            intervention_result = None
            
    final_answer_text = answer_text

    _save_ai_response(
        db_connection,
        chat_session_id,
        final_answer_text,
        used_sources,
        warning_text
    )

    if user_id and final_answer_text and not answer_text.startswith("I encountered an error"):
        usage_info = record_usage(user_id, answer_text, db_connection)

    return {
        "response": final_answer_text,
        "raw_response": answer_text,
        "sources_used": used_sources,
        "sessionId": chat_session_id,
        "is_first_message": False,
        "token_usage": usage_info,
        "warning": warning_text,
        "intervention": intervention_result
    }

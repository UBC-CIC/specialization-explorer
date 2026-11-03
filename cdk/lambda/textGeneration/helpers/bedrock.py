
import logging
from typing import List, Dict, Any

from helpers.aws_clients import get_bedrock_client

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def retrieve_documents(
    query: str,
    knowledge_base_id: str,
    region: str,
    num_results: int, 
    search_type: str = "HYBRID",
) -> List[Dict[str, Any]]:
    """
    Retrieve documents from the Knowledge Base.
    """
    agent_runtime = get_bedrock_client("bedrock-agent-runtime", region)
    
    try:
        response = agent_runtime.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={'text': query},
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': num_results,
                    "overrideSearchType": search_type
                }
            }
        )
        
        results = response.get('retrievalResults', [])
        logger.info(f"Retrieval found {len(results)} chunks.")
        
        sources = []
        for r in results:
            location = r.get("location", {})
            metadata = r.get("metadata", {})
            content = r.get("content", {}).get("text", "")
            
            loc_type = location.get("type", "UNKNOWN")
            url = None
            if loc_type == "WEB":
                url = location.get("webLocation", {}).get("url")
            elif loc_type == "S3":
                url = location.get("s3Location", {}).get("uri")
                
            sources.append({
                "type": loc_type,
                "uri": metadata.get("x-amz-bedrock-kb-source-uri") or url,
                "url": url,
                "content": content,
                "score": r.get("score")
            })
            
        return sources
    except Exception as e:
        logger.error(f"Retrieval failed: {e}")
        return []

def format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    if not sources:
        return "No specific documents found."
    context_str = ""
    for i, source in enumerate(sources, 1):
        context_str += f"<source_{i}>\n{source['content']}\n</source_{i}>\n\n"
    return context_str

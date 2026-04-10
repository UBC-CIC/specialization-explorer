
import boto3.exceptions
import json
from helpers.cors import get_cors_headers
import logging
import os
import boto3
from helpers.chat import get_response
from helpers.db_connection import get_db_connection
import helpers.config as config
from helpers.session_security import validate_session_ownership, sanitize_session_id

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context=None):
    # Log event but exclude body to prevent sensitive data exposure (user_id, chat_session_id)
    safe_event = {k: v for k, v in event.items() if k != 'body'}
    logger.info("Event: %s (body omitted)", json.dumps(safe_event))
    
    body = {}
    if 'body' in event and event['body']:
        try:
            if isinstance(event['body'], str):
                body = json.loads(event['body'])
            else:
                body = event['body']
        except Exception as e:
            logger.error(f"Failed to parse body: {e}")
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON body'})
            }

    query = body.get('query')
    
    # Perform Query Length Validation 
    if len(query) > config.MAX_CHARACTERS_PER_USER_MESSAGE:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': f'Query exceeds maximum length of {config.MAX_CHARACTERS_PER_USER_MESSAGE} characters'})
        }
    
    chat_session_id = body.get('chat_session_id')
    
    # Fallback to path parameters
    if not chat_session_id and 'pathParameters' in event and event['pathParameters']:
        chat_session_id = event['pathParameters'].get('chat_session_id') or event['pathParameters'].get('id')

    user_id = body.get('user_id')
    
    if not query or not chat_session_id:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Missing query or chat_session_id'})
        }

    # Sanitize session ID before querying DB
    try: 
        chat_session_id = sanitize_session_id(chat_session_id)
    except ValueError as e: 
        logger.error(f"Invalid session ID: {e}")
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Invalid session ID'})
        }

    conn = None
    try:
        conn = get_db_connection()
        conn.autocommit = False

        # Validate the session ownership before doing anything with the session 
        if user_id: 
            if not validate_session_ownership(conn, chat_session_id, user_id): 
                return {
                    'statusCode': 403,
                    'body': json.dumps({'error': 'Unauthorized access to chat session'})
                }
        
        # Load dynamic configuration from DB
        config.load_config(conn)
        
        request_context = event.get('requestContext', {})
        connection_id = request_context.get('connectionId')
        apigw_management = None
        
        if connection_id:
            domain_name = request_context.get('domainName')
            stage = request_context.get('stage')
            if domain_name and stage:
                endpoint_url = f"https://{domain_name}/{stage}"
                try:
                    apigw_management = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint_url)
                    # Send start message
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({'type': 'start'})
                    )
                except Exception as e:
                    logger.error(f"Failed to initialize WebSocket client: {e}")

        def stream_chunk(chunk_text):
            if apigw_management and connection_id:
                try:
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({'type': 'chunk', 'content': chunk_text})
                    )
                except Exception as e:
                    logger.error(f"Failed to send stream chunk: {e}")

        response_data = get_response(
            query=query,
            knowledge_base_id=config.KB_ID,
            model_arn=config.SONNET_ARN,
            region=config.REGION,
            llm_region=config.LLM_REGION,
            chat_session_id=chat_session_id,
            user_id=user_id,
            db_connection=conn,
            stream_callback=stream_chunk
        )
        
        # Format response to match API contract
        # Map sources_used -> sources
        response_body = {
            "response": response_data.get("response", ""),
            "sources": response_data.get("sources_used", []),
            "warning": response_data.get("warning"),
            "chat_session_id": response_data.get("sessionId"),
            "token_usage": response_data.get("token_usage", {})
        }
        
        status_code = 200
        if response_data.get("token_limit_exceeded"):
            status_code = 429
            response_body["error"] = "TOKEN_LIMIT_EXCEEDED"
            response_body["message"] = response_body["response"]
            
        # Send WebSocket complete message
        if apigw_management and connection_id:
            try:
                if status_code == 429:
                    # Send specific error over WS for token limits
                    error_msg = {
                        'type': 'error',
                        'error': 'TOKEN_LIMIT_EXCEEDED',
                        'message': response_body['message'],
                        'token_usage': response_body.get('token_usage', {})
                    }
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps(error_msg)
                    )
                    logger.info(f"Sent WebSocket token limit error to {connection_id}")
                else:
                    # Send complete message with sources
                    complete_msg = {
                        'type': 'complete',
                        'sources': response_body['sources'],
                        'warning': response_body.get('warning'),
                        'chat_session_id': response_body['chat_session_id'],
                        'token_usage': response_body.get('token_usage', {})
                    }
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps(complete_msg)
                    )
                    logger.info(f"Sent WebSocket response (complete) to {connection_id}")
            except Exception as e:
                logger.error(f"Failed to post to WebSocket connection: {e}")

        return {
            'statusCode': status_code,
            'headers': { 'Content-Type': 'application/json', **get_cors_headers(event if 'event' in locals() else {}) },
            'body': json.dumps(response_body)
        }
        
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': { 'Content-Type': 'application/json', **get_cors_headers(event if 'event' in locals() else {}) },
            'body': json.dumps({'error': 'Internal server error'})
        }

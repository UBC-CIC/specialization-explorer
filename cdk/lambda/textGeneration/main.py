
import boto3.exceptions
import json
import uuid
from helpers.cors import get_cors_headers
import logging
import os
import boto3
from helpers.chat import get_response
from helpers.db_connection import get_db_connection
import helpers.config as config
from helpers.session_security import validate_session_ownership, sanitize_session_id, session_exists
from helpers.tracing import tracer

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Response and error capture stay off: both can contain message text
@tracer.capture_lambda_handler(capture_response=False, capture_error=False)
def handler(event, context=None):
    # Warm-up invocation from the WebSocket default route. Module imports have already run;
    # opening the cached DB connection also moves the secret fetch and TLS handshake off
    # the first real request. API Gateway events never carry a top-level "warmup" key.
    if event.get('warmup') is True:
        try:
            get_db_connection()
        except Exception as e:
            logger.warning(f"Warm-up could not open a DB connection: {e}")
        return {'statusCode': 200}

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

    if not isinstance(body, dict):
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Invalid JSON body'})
        }

    query = body.get('query')
    is_intro_message = body.get('is_intro_message', False)

    # Optional client-generated id for the user message; a repeated id is not processed twice
    message_id = body.get('message_id')
    if message_id is not None:
        try:
            message_id = str(uuid.UUID(str(message_id)))
        except ValueError:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'message_id must be a valid UUID'})
            }
    
    # The session comes from the route; the identity comes from the verified token
    path_parameters = event.get('pathParameters') or {}
    chat_session_id = path_parameters.get('chat_session_id') or path_parameters.get('id')

    user_id = ((event.get('requestContext') or {}).get('authorizer') or {}).get('userId')
    try:
        user_id = str(uuid.UUID(str(user_id)))
    except ValueError:
        return {
            'statusCode': 401,
            'body': json.dumps({'error': 'Unauthorized'})
        }

    if not isinstance(query, str) or not query.strip() or not chat_session_id:
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

        # Sessions are only created through POST /chat_sessions, so an unknown id is a 404
        # and nothing is written before ownership and the message quota are checked
        if not validate_session_ownership(conn, chat_session_id, user_id):
            if not session_exists(conn, chat_session_id):
                return {
                    'statusCode': 404,
                    'body': json.dumps({'error': 'Chat session not found'})
                }
            return {
                'statusCode': 403,
                'body': json.dumps({'error': 'Unauthorized access to chat session'})
            }
        
        # Load dynamic configuration from DB (cached for config.CONFIG_REFRESH_SECONDS)
        with tracer.provider.in_subsegment("## load_config"):
            config.load_config(conn)
        
        # Validate the query length against the configured limit
        if len(query) > config.MAX_CHARACTERS_PER_USER_MESSAGE:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': f'Query exceeds maximum length of {config.MAX_CHARACTERS_PER_USER_MESSAGE} characters'})
            }

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

        # Requests without a WebSocket connection come from the synchronous HTTP fallback,
        # which must answer within the API Gateway integration timeout
        response_data = get_response(
            max_tokens=None if connection_id else config.HTTP_FALLBACK_MAX_TOKENS,
            query=query,
            knowledge_base_id=config.KB_ID,
            region=config.REGION,
            llm_region=config.LLM_REGION,
            chat_session_id=chat_session_id,
            user_id=user_id,
            db_connection=conn,
            stream_callback=stream_chunk,
            is_intro_message=is_intro_message,
            user_message_id=message_id
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
        elif response_data.get("duplicate_message"):
            status_code = 409
            response_body["error"] = "DUPLICATE_MESSAGE"
            response_body["message"] = response_body["response"]
            
        # Send WebSocket complete message
        if apigw_management and connection_id:
            try:
                if status_code == 409:
                    apigw_management.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({
                            'type': 'error',
                            'error': 'DUPLICATE_MESSAGE',
                            'message': response_body['message'],
                        })
                    )
                    logger.info(f"Sent WebSocket duplicate message error to {connection_id}")
                elif status_code == 429:
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
        if (event.get('requestContext') or {}).get('connectionId'):
            # WebSocket requests are invoked asynchronously and nobody reads the return value.
            # Raising sends the event to the on-failure destination, which notifies the client.
            raise
        return {
            'statusCode': 500,
            'headers': { 'Content-Type': 'application/json', **get_cors_headers(event if 'event' in locals() else {}) },
            'body': json.dumps({'error': 'Internal server error'})
        }

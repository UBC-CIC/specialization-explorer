import json
import boto3
import logging
import time
import random

logger = logging.getLogger()
logger.setLevel(logging.INFO)

bedrock_agent = boto3.client('bedrock-agent')

# Reduced window because the index is already guaranteed to exist.
# This only accounts for Bedrock's internal cache delays.
KB_CREATE_RETRY_WINDOW_SECONDS = 120 

def calculate_exponential_backoff(attempt, base=2, max_sleep=15): 
    sleep_time = min(base**attempt, max_sleep)
    sleep_time *= (0.5 + random.random() / 2)
    return sleep_time

DEFAULT_S3_INCLUSION_PREFIX = 'uploads/'


DEFAULT_SEMANTIC_CHUNKING = {
    'chunkingConfiguration': {
        'chunkingStrategy': 'SEMANTIC',
        'semanticChunkingConfiguration': {
            'maxTokens': 512,
            'bufferSize': 1,
            'breakpointPercentileThreshold': 85,
        }
    }
}


def _s3_data_source_configuration(props, bucket_arn):
    """Only objects under this prefix are ingested; uploads land elsewhere until staging promotes them"""
    prefix = props.get('S3InclusionPrefix') or DEFAULT_S3_INCLUSION_PREFIX
    return {
        'type': 'S3',
        's3Configuration': {
            'bucketArn': bucket_arn,
            'inclusionPrefixes': [prefix],
        }
    }


def _web_data_source_configuration(src):
    """Build a WEB dataSourceConfiguration (seed URLs + crawler filters/limits) from a source spec."""
    seed_urls = [u.strip() for u in src.get('seedUrls', []) if u and u.strip()]
    crawler = {}
    inclusion = [f for f in (src.get('inclusionFilters') or []) if f]
    exclusion = [f for f in (src.get('exclusionFilters') or []) if f]
    if inclusion:
        crawler['inclusionFilters'] = inclusion
    if exclusion:
        crawler['exclusionFilters'] = exclusion

    limits = {}
    # Values may arrive as strings via CloudFormation; coerce defensively.
    if src.get('rateLimit') not in (None, ''):
        limits['rateLimit'] = int(src['rateLimit'])
    if src.get('maxPages') not in (None, ''):
        limits['maxPages'] = int(src['maxPages'])
    if limits:
        crawler['crawlerLimits'] = limits

    web_config = {
        'sourceConfiguration': {
            'urlConfiguration': {
                'seedUrls': [{'url': u} for u in seed_urls]
            }
        }
    }
    if crawler:
        web_config['crawlerConfiguration'] = crawler
    return {'type': 'WEB', 'webConfiguration': web_config}


def _vector_ingestion_configuration(chunking):
    """Map a chunking spec to a Bedrock vectorIngestionConfiguration.

    Returns None to omit the parameter entirely, which makes Bedrock apply its
    default chunking (used by the 'DEFAULT' strategy).
    """
    if not chunking:
        return None
    strategy = (chunking.get('strategy') or 'DEFAULT').upper()

    if strategy == 'DEFAULT':
        return None
    if strategy == 'NONE':
        return {'chunkingConfiguration': {'chunkingStrategy': 'NONE'}}
    if strategy == 'HIERARCHICAL':
        levels = chunking.get('levels') or [1000, 500]
        return {
            'chunkingConfiguration': {
                'chunkingStrategy': 'HIERARCHICAL',
                'hierarchicalChunkingConfiguration': {
                    'levelConfigurations': [{'maxTokens': int(lvl)} for lvl in levels],
                    'overlapTokens': int(chunking.get('overlapTokens', 60)),
                }
            }
        }
    if strategy == 'FIXED':
        return {
            'chunkingConfiguration': {
                'chunkingStrategy': 'FIXED_SIZE',
                'fixedSizeChunkingConfiguration': {
                    'maxTokens': int(chunking.get('maxTokens', 300)),
                    'overlapPercentage': int(chunking.get('overlapPercentage', 20)),
                }
            }
        }
    if strategy == 'SEMANTIC':
        return {
            'chunkingConfiguration': {
                'chunkingStrategy': 'SEMANTIC',
                'semanticChunkingConfiguration': {
                    'maxTokens': int(chunking.get('maxTokens', 512)),
                    'bufferSize': int(chunking.get('bufferSize', 1)),
                    'breakpointPercentileThreshold': int(chunking.get('breakpointPercentileThreshold', 85)),
                }
            }
        }
    # Unknown strategy: fall back to Bedrock default.
    logger.warning("Unknown chunking strategy %s; using Bedrock default.", strategy)
    return None


def _desired_web_sources(props):
    """Normalize the web sources to provision.

    Prefers the structured 'WebDataSources' JSON list; falls back to the legacy
    flat 'WebCrawlerUrls'/'WebCrawlerExclusionFilters' props for backward compatibility.
    Each returned item: {suffix, seedUrls, inclusionFilters, exclusionFilters,
    rateLimit, maxPages, chunking}.
    """
    raw = props.get('WebDataSources')
    if raw:
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            logger.warning("WebDataSources is not valid JSON; no web sources will be created.")
            return []
        sources = []
        for item in (parsed or []):
            suffix = item.get('name') or 'web'
            sources.append({
                'suffix': suffix,
                'seedUrls': item.get('seedUrls', []),
                'inclusionFilters': item.get('inclusionFilters', []),
                'exclusionFilters': item.get('exclusionFilters', []),
                'rateLimit': item.get('rateLimit'),
                'maxPages': item.get('maxPages'),
                'chunking': item.get('chunking'),
            })
        return sources

    # Legacy fallback: single web source from flat props.
    web_urls_str = props.get('WebCrawlerUrls', '')
    if web_urls_str and web_urls_str != 'dummy-value':
        urls = [u.strip() for u in web_urls_str.split(',') if u.strip()]
        if urls:
            excl_str = props.get('WebCrawlerExclusionFilters', '')
            exclusion = [f.strip() for f in excl_str.split(',') if f.strip()]
            return [{
                'suffix': 'web-source',
                'seedUrls': urls,
                'inclusionFilters': [],
                'exclusionFilters': exclusion,
                'rateLimit': None,
                'maxPages': None,
                'chunking': {'strategy': 'SEMANTIC'},
            }]
    return []


def _create_web_data_source(kb_id, ds_name, src):
    """Create one WEB data source; returns its data source id."""
    kwargs = {
        'knowledgeBaseId': kb_id,
        'name': ds_name,
        'dataSourceConfiguration': _web_data_source_configuration(src),
    }
    vic = _vector_ingestion_configuration(src.get('chunking'))
    if vic:
        kwargs['vectorIngestionConfiguration'] = vic
    resp = bedrock_agent.create_data_source(**kwargs)
    return resp['dataSource']['dataSourceId']


def _create_kb_and_data_sources(props):
    name = props['Name']
    role_arn = props['RoleArn']
    embedding_model_arn = props['EmbeddingModelArn']
    collection_arn = props['CollectionArn']
    vector_index_name = props['VectorIndexName']
    vector_field = props['VectorField']
    text_field = props['TextField']
    metadata_field = props['MetadataField']
    description = props.get('Description', '')

    logger.info(f"Creating Knowledge Base: {name}")

    deadline = time.time() + KB_CREATE_RETRY_WINDOW_SECONDS
    attempt = 0
    while True:
        attempt += 1
        try:
            response = bedrock_agent.create_knowledge_base(
                name=name,
                description=description,
                roleArn=role_arn,
                knowledgeBaseConfiguration={
                    'type': 'VECTOR',
                    'vectorKnowledgeBaseConfiguration': {
                        'embeddingModelArn': embedding_model_arn
                    }
                },
                storageConfiguration={
                    'type': 'OPENSEARCH_SERVERLESS',
                    'opensearchServerlessConfiguration': {
                        'collectionArn': collection_arn,
                        'vectorIndexName': vector_index_name,
                        'fieldMapping': {
                            'vectorField': vector_field,
                            'textField': text_field,
                            'metadataField': metadata_field
                        }
                    }
                }
            )
            break
        except bedrock_agent.exceptions.ValidationException as e:
            message = str(e)
            is_index_not_ready = (
                "no such index" in message.lower()
                or "storage configuration provided is invalid" in message.lower()
            )

            if is_index_not_ready:
                sleep_time = calculate_exponential_backoff(attempt)
                
                if time.time() + sleep_time > deadline:
                    logger.error(f"Bedrock failed to recognize the index after {KB_CREATE_RETRY_WINDOW_SECONDS} seconds.")
                    raise

                seconds_left = int(deadline - time.time())
                logger.warning(
                    "Bedrock API cache has not recognized the index yet. "
                    "Retrying in %.1fs (time left: %ss). Error: %s",
                    sleep_time,
                    seconds_left,
                    message,
                )          
                time.sleep(sleep_time)
                continue
            raise

    kb_id = response['knowledgeBase']['knowledgeBaseId']
    logger.info(f"Successfully created Knowledge Base. ID: {kb_id}")

    s3_ds_id = ''
    web_ds_ids = []

    s3_bucket_arn = props.get('S3BucketArn')
    if s3_bucket_arn:
        logger.info(f"Creating S3 Data Source for bucket: {s3_bucket_arn}")
        ds_response = bedrock_agent.create_data_source(
            knowledgeBaseId=kb_id,
            name=f"{name}-s3-source",
            dataSourceConfiguration=_s3_data_source_configuration(props, s3_bucket_arn),
            vectorIngestionConfiguration=DEFAULT_SEMANTIC_CHUNKING,
        )
        s3_ds_id = ds_response['dataSource']['dataSourceId']
        logger.info(f"Successfully created S3 Data Source. ID: {s3_ds_id}")

    for src in _desired_web_sources(props):
        ds_name = f"{name}-{src['suffix']}"
        try:
            logger.info("Creating web data source %s with seeds %s", ds_name, src.get('seedUrls'))
            web_ds_id = _create_web_data_source(kb_id, ds_name, src)
            web_ds_ids.append(web_ds_id)
            logger.info("Successfully created web data source %s. ID: %s", ds_name, web_ds_id)
        except Exception as e:
            logger.warning("Could not create web data source %s. Error: %s", ds_name, str(e))

    return {
        'kb_id': kb_id,
        's3_ds_id': s3_ds_id,
        'web_ds_ids': web_ds_ids,
    }


def _restrict_s3_data_source(kb_id, ds_id, props):
    """Bring a data source created before the prefix restriction in line with the current scope"""
    ds = bedrock_agent.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)['dataSource']
    wanted = _s3_data_source_configuration(props, props.get('S3BucketArn'))
    current = ds.get('dataSourceConfiguration', {})
    if current.get('s3Configuration', {}).get('inclusionPrefixes') == wanted['s3Configuration']['inclusionPrefixes']:
        return

    logger.info("Restricting S3 data source %s to prefix %s", ds_id, wanted['s3Configuration']['inclusionPrefixes'])
    current_s3 = dict(current.get('s3Configuration', {}))
    current_s3['inclusionPrefixes'] = wanted['s3Configuration']['inclusionPrefixes']
    update = {
        'knowledgeBaseId': kb_id,
        'dataSourceId': ds_id,
        'name': ds['name'],
        'dataSourceConfiguration': {**current, 'type': 'S3', 's3Configuration': current_s3},
    }
    for optional in ('description', 'vectorIngestionConfiguration', 'dataDeletionPolicy'):
        if ds.get(optional):
            update[optional] = ds[optional]
    bedrock_agent.update_data_source(**update)


def _list_all_data_sources(kb_id):
    """Return all data source summaries for a KB, following pagination."""
    summaries = []
    next_token = None
    while True:
        kwargs = {'knowledgeBaseId': kb_id, 'maxResults': 100}
        if next_token:
            kwargs['nextToken'] = next_token
        response = bedrock_agent.list_data_sources(**kwargs)
        summaries.extend(response.get('dataSourceSummaries', []))
        next_token = response.get('nextToken')
        if not next_token:
            return summaries


def _ensure_data_sources_for_kb(kb_id, props):
    name = props['Name']
    s3_ds_id = ''
    web_ds_ids = []

    existing_by_name = {}
    for ds in _list_all_data_sources(kb_id):
        existing_by_name[ds.get('name', '')] = ds.get('dataSourceId', '')

    s3_ds_id = existing_by_name.get(f"{name}-s3-source", '')

    if s3_ds_id and props.get('S3BucketArn'):
        _restrict_s3_data_source(kb_id, s3_ds_id, props)

    if not s3_ds_id and props.get('S3BucketArn'):
        logger.info("S3 data source missing on update; creating it.")
        ds_response = bedrock_agent.create_data_source(
            knowledgeBaseId=kb_id,
            name=f"{name}-s3-source",
            dataSourceConfiguration=_s3_data_source_configuration(props, props.get('S3BucketArn')),
            vectorIngestionConfiguration=DEFAULT_SEMANTIC_CHUNKING,
        )
        s3_ds_id = ds_response['dataSource']['dataSourceId']

    # Reconcile each desired web source by name, creating any that are missing.
    # Existing web sources are left in place; only missing ones are created.
    for src in _desired_web_sources(props):
        ds_name = f"{name}-{src['suffix']}"
        existing_id = existing_by_name.get(ds_name)
        if existing_id:
            web_ds_ids.append(existing_id)
            continue
        try:
            logger.info("Web data source %s missing on update; creating it.", ds_name)
            web_ds_ids.append(_create_web_data_source(kb_id, ds_name, src))
        except Exception as e:
            logger.warning("Could not create web data source %s on update. Error: %s", ds_name, str(e))

    return s3_ds_id, web_ds_ids

def handler(event, context):
    logger.info(f"Received event: {json.dumps(event)}")
    request_type = event['RequestType']
    
    try:
        if request_type == 'Create':
            return on_create(event)
        elif request_type == 'Update':
            return on_update(event)
        elif request_type == 'Delete':
            return on_delete(event)
        else:
            raise Exception(f"Invalid request type: {request_type}")
    except Exception as e:
        logger.error(f"Error handling event: {str(e)}")
        raise e

def on_create(event):
    props = event['ResourceProperties']
    created = _create_kb_and_data_sources(props)
    kb_id = created['kb_id']
    web_ds_ids = created['web_ds_ids']

    return {
        'PhysicalResourceId': kb_id,
        'Data': {
            'KnowledgeBaseId': kb_id,
            'S3DataSourceId': created['s3_ds_id'],
            # First web source kept for backward compatibility; full list also provided.
            'WebCrawlerDataSourceId': web_ds_ids[0] if web_ds_ids else '',
            'WebCrawlerDataSourceIds': ','.join(web_ds_ids),
        }
    }

def on_update(event):
    physical_id = event['PhysicalResourceId']
    props = event.get('ResourceProperties', {})

    s3_ds_id = ''
    web_ds_ids = []
    effective_kb_id = physical_id

    try:
        bedrock_agent.get_knowledge_base(knowledgeBaseId=physical_id)
        s3_ds_id, web_ds_ids = _ensure_data_sources_for_kb(physical_id, props)
        logger.info(f"Update operation requested for: {physical_id}. Returning existing attributes.")
    except bedrock_agent.exceptions.ResourceNotFoundException:
        logger.warning(
            f"Knowledge Base {physical_id} not found during update. Recreating knowledge base and data sources."
        )
        created = _create_kb_and_data_sources(props)
        effective_kb_id = created['kb_id']
        s3_ds_id = created['s3_ds_id']
        web_ds_ids = created['web_ds_ids']
    except Exception as e:
        logger.error(f"Update failed while reconciling knowledge base/data sources: {str(e)}")
        raise

    return {
        'PhysicalResourceId': effective_kb_id,
        'Data': {
            'KnowledgeBaseId': effective_kb_id,
            'S3DataSourceId': s3_ds_id,
            'WebCrawlerDataSourceId': web_ds_ids[0] if web_ds_ids else '',
            'WebCrawlerDataSourceIds': ','.join(web_ds_ids),
        }
    }

def on_delete(event):
    kb_id = event['PhysicalResourceId']
    if kb_id and kb_id != 'failed-to-create' and not kb_id.startswith('CustomResource'):
        try:
            logger.info(f"Deleting Knowledge Base: {kb_id}")
            bedrock_agent.delete_knowledge_base(knowledgeBaseId=kb_id)
            logger.info(f"Successfully deleted Knowledge Base: {kb_id}")
        except bedrock_agent.exceptions.ResourceNotFoundException:
            logger.info(f"Knowledge Base {kb_id} already deleted.")
        except Exception as e:
            logger.error(f"Error deleting knowledge base: {str(e)}")
            raise e
    return {
        'PhysicalResourceId': event['PhysicalResourceId'],
        'Data': {}
    }
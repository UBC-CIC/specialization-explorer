import functools

import boto3
from botocore.config import Config

# Shared settings for Bedrock calls. Adaptive retries back off and rate-limit on throttling.
# read_timeout is the longest wait for the next bytes of a response, which covers the gap
# before a streamed answer starts; it stays under the function timeout.
# https://boto3.amazonaws.com/v1/documentation/api/latest/guide/retries.html
BEDROCK_CLIENT_CONFIG = Config(
    retries={"mode": "adaptive", "max_attempts": 4},
    connect_timeout=5,
    read_timeout=60,
)


@functools.lru_cache(maxsize=None)
def get_bedrock_client(service_name: str, region_name: str):
    """
    Returns a Bedrock client ("bedrock-runtime" or "bedrock-agent-runtime") for the region.
    Each client is created once per execution environment and reused by warm invocations,
    which keeps its connection pool and its adaptive retry state.
    """
    return boto3.client(service_name, region_name=region_name, config=BEDROCK_CLIENT_CONFIG)

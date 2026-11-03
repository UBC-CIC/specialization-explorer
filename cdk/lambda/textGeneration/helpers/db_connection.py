
import os
import boto3
import json
import psycopg2
import logging

logger = logging.getLogger(__name__)

# Environment variables
REGION = os.environ.get("REGION", "ca-central-1")
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")

# RDS Proxy presents an ACM certificate, so it is verified against the Amazon Trust Services
# roots rather than the RDS CA bundle. verify-full also checks the host name.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html
DB_CA_BUNDLE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "certs", "amazon-root-ca.pem"
)

# Cached resources
connection = None

# AWS Powertools
from aws_lambda_powertools.utilities import parameters

def get_secret():
    if not DB_SECRET_NAME:
        raise ValueError("SM_DB_CREDENTIALS environment variable not set")
        
    try:
        # Powertools caches for 5 mins (300 sec) and handles JSON parsing
        return parameters.get_secret(DB_SECRET_NAME, transform='json', max_age=300)
    except Exception as e:
        logger.error(f"Error retrieving secret {DB_SECRET_NAME}: {e}")
        raise e

def get_db_connection():
    global connection
    try:
        if connection is None or connection.closed:
            # The database only admits the proxy, so there is no direct-connection fallback
            if not RDS_PROXY_ENDPOINT:
                raise ValueError("RDS_PROXY_ENDPOINT environment variable not set")

            secret = get_secret()

            connection = psycopg2.connect(
                sslmode='verify-full',
                sslrootcert=DB_CA_BUNDLE,
                host=RDS_PROXY_ENDPOINT,
                user=secret.get('username'),
                password=secret.get('password'),
                dbname=secret.get('dbname'),
                port=secret.get('port', 5432)
            )
        return connection
    except Exception as e:
        if connection: 
            try:
                connection.close()
            except Exception as close_err:
                logger.warning(f"Failed to close DB connection during cleanup: {close_err}")
            connection = None
        logger.error(f"Failed to connect to database: {e}")
        raise e

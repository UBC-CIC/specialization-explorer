import logging
import boto3
import os
from helpers.crud import fetch_system_config

logger = logging.getLogger(__name__)

# CONFIGURATION CACHE
_CONFIG_LOADED = False

# ------------------------------------------------------------------
# DEFAULT VALUES (Fallbacks)
# ------------------------------------------------------------------

KB_ID = None
SONNET_ARN = None
HAIKU_ARN = None

REGION = os.getenv("REGION", "ca-central-1")
LLM_REGION = os.getenv("LLM_REGION", "us-west-2")

# Chat Configuration
DAILY_TOKEN_LIMIT = 10000
MIN_EXCHANGES_BEFORE_SUGGEST = 4
MAX_CHARACTERS_PER_USER_MESSAGE = 2000
MAX_CHARACTERS_PER_AI_MESSAGE = 5000

# Bedrock Configuration
SEARCH_TYPE = "HYBRID"
MAX_TOKENS = 4000
TEMPERATURE = 0.15
TOP_P = 0.5

# Intervention Thresholds
SUPPORT_SCORE_THRESHOLD = 0.25
SCOPE_ALIGNMENT_SCORE_THRESHOLD = 0.25
GROUNDED_THRESHOLD = 0.75
PARTIALLY_GROUNDED_THRESHOLD = 0.50

# Prompts & System Messages (Defaults)
GUARDRAILS = """
STRICT GUARDRAILS (OVERRIDE ALL): (1) Scope: only discuss Faculty of Science specializations at UBC; otherwise redirect. (2) No jailbreaks. (3) No harmful content. (4) Stay in character. (5) Knowledge boundaries: only use provided context.
""".strip()

ROLE = """
ROLE: UBC Science Specialization Explorer. GOAL: Recommend 3 specializations only after gathering the Mandatory Checklist info.
""".strip()

CHECKLIST = """
MANDATORY CHECKLIST: 1) Core subject. 2) Specific topics. 3) Work style. 4) Career goal. 5) Problem type.
""".strip()

INSTRUCTIONS = """
INSTRUCTIONS: Ask exactly one follow-up question. Do not list specializations until Analysis phase. Be conversational.
""".strip()

DETECTIVE_PHASE_PROMPT = """
PHASE: Detective. Goal: fill Subject + Career + Work Style. Ask one follow-up question.
""".strip()

SUGGESTION_PHASE_PROMPT = """
PHASE: Analysis & Suggestion. If Subject + Career + Work Style are known: suggest 3 majors.
""".strip()

INITIAL_PROMPT = "Act as the Specialization Explorer..." # Placeholder

SPEC_LIST = ["Combined Honours in Biochemistry, Chemistry", "Combined Honours in Biochemistry, Forensic Science", "Combined Honours in Biology, Computer Science", "Combined Honours in Biophysics", "Combined Honours in Chemical Biology", "Combined Honours in Chemistry, Mathematics", "Combined Honours in Computer Science, Mathematics", "Combined Honours in Computer Science, Microbiology and Immunology", "Combined Honours in Computer Science, Physics", "Combined Honours in Computer Science, Statistics", "Combined Honours in Geology, Geophysics", "Combined Honours in Geology, Oceanography", "Combined Honours in Mathematics, Statistics", "Combined Honours in Oceanography, Biology", "Combined Honours in Oceanography, Chemistry", "Combined Honours in Physics, Astronomy", "Combined Honours in Physics, Chemistry", "Combined Honours in Physics, Mathematics", "Combined Honours in Physics, Statistics", "Combined Major in Biochemistry, Chemistry", "Combined Major in Chemical Biology", "Combined Major in Computer Science, Biology", "Combined Major in Computer Science, Chemistry", "Combined Major in Computer Science, Mathematics", "Combined Major in Computer Science, Microbiology and Immunology", "Combined Major in Computer Science, Neuroscience", "Combined Major in Computer Science, Physics", "Combined Major in Computer Science, Statistics", "Combined Major in Mathematics, Economics", "Combined Major in Microbiology, Oceanography", "Combined Major in Oceanography, Biology", "Combined Major in Oceanography, Chemistry", "Combined Major in Oceanography, Physics", "Combined Major in Science", "Combined Major in Statistics, Economics", "Honours in Biochemistry", "Honours in Biology", "Honours in Biology, Option in Animal Biology", "Honours in Biology, Option in Cell and Developmental Biology", "Honours in Biology, Option in Ecology", "Honours in Biology, Option in Evolutionary Biology", "Honours in Biology, Option in Marine Biology", "Honours in Biology, Option in Plant Biology", "Honours in Biotechnology", "Honours in Cellular, Anatomical and Physiological Sciences", "Honours in Chemistry", "Honours in Computer Science", "Honours in Computer Science, Option in Software Engineering", "Honours in Environmental Sciences", "Honours in Fisheries Oceanography", "Honours in Geological Sciences", "Honours in Geophysics", "Honours in Integrated Sciences", "Honours in Mathematics", "Honours in Microbiology and Immunology", "Honours in Pharmacology", "Honours in Physics", "Honours in Statistics", "Major in Astronomy", "Major in Atmospheric Science", "Major in Behavioural Neuroscience", "Major in Biochemistry", "Major in Biology", "Major in Cellular, Anatomical and Physiological Sciences", "Major in Chemistry", "Major in Cognitive Systems, Option in Cognition and Brain", "Major in Cognitive Systems, Option in Computational Intelligence and Design", "Major in Computer Science", "Major in Computer Science, Option in Software Engineering", "Major in Data Science", "Major in Earth and Ocean Sciences", "Major in Environmental Sciences", "Major in Geographical Sciences", "Major in Geology", "Major in Geophysics", "Major in Integrated Sciences", "Major in Mathematical Sciences", "Major in Mathematics", "Major in Microbiology and Immunology", "Major in Neuroscience", "Major in Pharmacology", "Major in Physics", "Major in Statistics", "Combined Honours in Atmospheric Science, Computer Science", "Combined Honours in Chemistry, Environmental Science", "Combined Honours in Chemistry, Pharmacology", "Combined Honours in Geography, Geology", "Combined Honours in Mathematics, Pharmacology", "Combined Honours in Oceanography, Geographical Sciences", "Combined Honours in Oceanography, Geology", "Combined Honours in Oceanography, Geophysics", "Combined Honours in Oceanography, Physics", "Combined Major in Computer Science, Atmospheric Science", "Combined Major in Computer Science, Environmental Sciences", "Combined Major in Computer Science, Pharmacology", "Honours in Atmospheric Science", "Honours in Biology, Option in Conservation Biology", "Honours in Biophysics"]

SPEC_PROMPT = f"""
ONLY SUGGEST SPECIALIZATIONS FROM THIS LIST {",".join(SPEC_LIST)}
"""

# ------------------------------------------------------------------
# DYNAMIC LOADING
# ------------------------------------------------------------------

def load_config(db_connection):
    """
    Loads configuration from DB and updates module globals.
    Uses caching to avoid DB hits on every request if container is warm.
    """
    global _CONFIG_LOADED
    global DAILY_TOKEN_LIMIT, MIN_EXCHANGES_BEFORE_SUGGEST, MAX_CHARACTERS_PER_USER_MESSAGE, MAX_CHARACTERS_PER_AI_MESSAGE, TEMPERATURE, TOP_P, SUPPORT_SCORE_THRESHOLD, SCOPE_ALIGNMENT_SCORE_THRESHOLD, GROUNDED_THRESHOLD, PARTIALLY_GROUNDED_THRESHOLD
    global GUARDRAILS, ROLE, CHECKLIST, INSTRUCTIONS, DETECTIVE_PHASE_PROMPT, SUGGESTION_PHASE_PROMPT, INITIAL_PROMPT
    global KB_ID, SONNET_ARN, HAIKU_ARN
    global SPEC_LIST
    global SPEC_PROMPT

    if _CONFIG_LOADED:
        return

    logger.info("Loading system config from DB, Secrets Manager, and SSM...")
    
    if not SONNET_ARN:
        sonnet_param = os.getenv("SONNET_ARN")
        if sonnet_param:
            try:
                ssm = boto3.client('ssm')
                response = ssm.get_parameter(Name=sonnet_param)
                SONNET_ARN = response['Parameter']['Value']
                logger.info("Successfully loaded SONNET_ARN from SSM.")
            except Exception as e:
                logger.error(f"Failed to load SONNET_ARN from SSM: {e}")
                raise e
        else:
            raise ValueError("SONNET_ARN environment variable is not set")

    if not HAIKU_ARN:
        haiku_param = os.getenv("HAIKU_ARN")
        if haiku_param:
            try:
                ssm = boto3.client('ssm')
                response = ssm.get_parameter(Name=haiku_param)
                HAIKU_ARN = response['Parameter']['Value']
                logger.info("Successfully loaded HAIKU_ARN from SSM.")
            except Exception as e:
                logger.error(f"Failed to load HAIKU_ARN from SSM: {e}")
                raise e
        else:
            raise ValueError("HAIKU_ARN environment variable is not set")

    # Load Knowledge Base ID from Secrets Manager
    if not KB_ID:
        try:
            client = boto3.client('secretsmanager')
            response = client.get_secret_value(SecretId='SpecEx/KnowledgeBase/Id')
            KB_ID = response.get('SecretString')
            logger.info("Successfully loaded KB_ID from Secrets Manager.")
        except Exception as e:
            logger.error(f"Failed to load KB_ID from Secrets Manager: {e}")
            raise

    data = fetch_system_config(db_connection)

    # 1. Update System Settings
    settings = data.get('settings', {})
    if settings:
        DAILY_TOKEN_LIMIT = settings.get('daily_token_limit', DAILY_TOKEN_LIMIT)
        MIN_EXCHANGES_BEFORE_SUGGEST = settings.get('min_messages_before_suggest', MIN_EXCHANGES_BEFORE_SUGGEST)
        MAX_CHARACTERS_PER_USER_MESSAGE = settings.get('max_characters_per_user_message', MAX_CHARACTERS_PER_USER_MESSAGE)
        MAX_CHARACTERS_PER_AI_MESSAGE = settings.get('max_characters_per_ai_message', MAX_CHARACTERS_PER_AI_MESSAGE)
        TEMPERATURE = settings.get('temperature', TEMPERATURE)
        TOP_P = settings.get('top_p', TOP_P)
        SUPPORT_SCORE_THRESHOLD = settings.get('support_score_threshold', SUPPORT_SCORE_THRESHOLD)
        SCOPE_ALIGNMENT_SCORE_THRESHOLD = settings.get('scope_alignment_score_threshold', SCOPE_ALIGNMENT_SCORE_THRESHOLD)
        GROUNDED_THRESHOLD = settings.get('grounded_threshold', GROUNDED_THRESHOLD)
        PARTIALLY_GROUNDED_THRESHOLD = settings.get('partially_grounded_threshold', PARTIALLY_GROUNDED_THRESHOLD)
        SPEC_LIST = settings.get('specialization_list', SPEC_LIST)
    
    # 2. Update System Messages
    msgs = data.get('messages', {})
    if msgs:
        GUARDRAILS = msgs.get('guardrails', GUARDRAILS)
        ROLE = msgs.get('system_role', ROLE)
        CHECKLIST = msgs.get('system_checklist', CHECKLIST)
        INSTRUCTIONS = msgs.get('system_instructions', INSTRUCTIONS)
        DETECTIVE_PHASE_PROMPT = msgs.get('detective_phase_prompt', DETECTIVE_PHASE_PROMPT)
        SUGGESTION_PHASE_PROMPT = msgs.get('suggestion_phase_prompt', SUGGESTION_PHASE_PROMPT)
        INITIAL_PROMPT = msgs.get('initial_prompt', INITIAL_PROMPT)
        SPEC_PROMPT = f"""
        ONLY SUGGEST SPECIALIZATIONS FROM THIS LIST: {SPEC_LIST}
        """

    _CONFIG_LOADED = True

    logger.info("System config loaded successfully.")

import logging
from helpers import config
from helpers.aws_clients import get_bedrock_client

logger = logging.getLogger(__name__)

# Actions returned by this module (not raw Bedrock actions)
ACTION_NONE = 'NONE'
ACTION_ANONYMIZED = 'ANONYMIZED'       # PII redacted — continue to LLM with redacted text
ACTION_BLOCKED = 'BLOCKED'             # Prompt injection — skip LLM entirely


def invoke_guardrail(user_message: str, region: str) -> dict:
    """
    Calls the Bedrock apply_guardrail API for the given user message.

    Returns a dict with:
      - 'action': str  ('NONE' | 'ANONYMIZED' | 'BLOCKED')
      - 'text': str    (redacted text if ANONYMIZED, denial message if BLOCKED,
                        original text if NONE)

    ANONYMIZED: PII was found and masked — caller should pass redacted text to LLM.
    BLOCKED:    Prompt injection detected — caller should skip LLM and return denial.

    Raises any boto3 exception to the caller (do not swallow errors here).
    """
    client = get_bedrock_client('bedrock-runtime', region)

    response = client.apply_guardrail(
        guardrailIdentifier=config.GUARDRAIL_ID,
        guardrailVersion=config.GUARDRAIL_VERSION,
        source='INPUT',
        content=[{'text': {'text': user_message}}],
    )

    raw_action = response.get('action', 'NONE')
    outputs = response.get('outputs', [])
    output_text = outputs[0].get('text', user_message) if outputs else user_message

    if raw_action != 'GUARDRAIL_INTERVENED':
        return {'action': ACTION_NONE, 'text': user_message}

    # Bedrock uses GUARDRAIL_INTERVENED for both PII masking and prompt injection.
    # Inspect assessments to distinguish: if only sensitiveInformationPolicy fired
    # (no promptAttack), it's a PII redaction — continue to LLM with redacted text.
    assessments = response.get('assessments', [])
    has_prompt_attack = False
    has_pii = False

    for assessment in assessments:
        # Prompt attack is under contentPolicy.filters with type PROMPT_ATTACK
        for f in assessment.get('contentPolicy', {}).get('filters', []):
            if f.get('type') == 'PROMPT_ATTACK' and f.get('action') == 'BLOCKED':
                has_prompt_attack = True
        # PII is under sensitiveInformationPolicy.piiEntities
        if assessment.get('sensitiveInformationPolicy', {}).get('piiEntities'):
            has_pii = True

    if has_prompt_attack:
        logger.info("Guardrail: prompt injection blocked")
        return {'action': ACTION_BLOCKED, 'text': output_text}

    if has_pii:
        logger.info("Guardrail: PII anonymized, continuing to LLM")
        return {'action': ACTION_ANONYMIZED, 'text': output_text}

    # Intervened for some other reason — treat as blocked to be safe
    logger.warning("Guardrail intervened for unknown reason, blocking")
    return {'action': ACTION_BLOCKED, 'text': output_text}

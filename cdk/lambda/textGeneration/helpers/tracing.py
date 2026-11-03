from aws_lambda_powertools import Tracer

# Shared X-Ray tracer for the chat pipeline (Powertools layer). Libraries are not auto-patched:
# patching botocore would add a subsegment for every streamed WebSocket chunk, so each pipeline
# step is timed with a named subsegment instead.
# Traces carry timings and step names only: never record message text, prompts or responses.
# https://docs.aws.amazon.com/powertools/python/latest/core/tracer/
tracer = Tracer(service="textGeneration", auto_patch=False)

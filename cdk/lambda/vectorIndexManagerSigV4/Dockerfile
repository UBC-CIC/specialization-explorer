FROM public.ecr.aws/lambda/python:3.14

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY main.py ${LAMBDA_TASK_ROOT}/

RUN chown -R 1000:1000 ${LAMBDA_TASK_ROOT}
USER 1000

CMD ["main.handler"]

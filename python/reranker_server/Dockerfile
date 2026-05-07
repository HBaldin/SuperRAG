FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
ENV RERANKER_MODEL=BAAI/bge-reranker-v2-m3
ENV RERANKER_PORT=8002
ENV RERANKER_HOST=0.0.0.0
EXPOSE 8002
CMD ["python", "main.py"]

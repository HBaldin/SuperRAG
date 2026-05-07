FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN mkdir -p /app/cache/embeddings

ENV EMBEDDING_MODEL=BAAI/bge-m3
ENV EMBEDDING_PORT=8001
ENV EMBEDDING_HOST=0.0.0.0
ENV EMBEDDING_CACHE_DIR=/app/cache/embeddings

EXPOSE 8001

CMD ["python", "main.py"]

# =============================================================================
# SuperRAG — Dockerfile multi-stage
# Single container com: Qdrant + Python embedding/reranker + Node.js API
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Extrai binário do Qdrant da imagem oficial
# -----------------------------------------------------------------------------
FROM qdrant/qdrant:latest AS qdrant-bin

# -----------------------------------------------------------------------------
# Stage 2: Build Python — instala dependências e pré-baixa modelos ML
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS python-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cria venv único para embedding + reranker
RUN python -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Instala torch CPU-only primeiro (evita baixar versão CUDA ~2GB)
RUN pip install --no-cache-dir \
    "torch==2.6.0" --index-url https://download.pytorch.org/whl/cpu

# Copia requirements e instala (sem torch — já instalado acima)
COPY python/embedding_server/requirements.txt /tmp/embed-req.txt
COPY python/reranker_server/requirements.txt /tmp/rerank-req.txt

RUN grep -v "^torch" /tmp/embed-req.txt > /tmp/embed-req-notorch.txt && \
    grep -v "^torch" /tmp/rerank-req.txt > /tmp/rerank-req-notorch.txt && \
    pip install --no-cache-dir -r /tmp/embed-req-notorch.txt && \
    pip install --no-cache-dir -r /tmp/rerank-req-notorch.txt && \
    pip install --no-cache-dir supervisor

# Pré-baixa modelos HuggingFace (evita cold start de 5-10min)
ENV HF_HOME=/app/models
RUN python -c "\
from sentence_transformers import SentenceTransformer, CrossEncoder; \
print('[build] Baixando BAAI/bge-m3...'); \
SentenceTransformer('BAAI/bge-m3'); \
print('[build] Baixando BAAI/bge-reranker-v2-m3...'); \
CrossEncoder('BAAI/bge-reranker-v2-m3', max_length=512); \
print('[build] Modelos prontos.'); \
"

# -----------------------------------------------------------------------------
# Stage 3: Build Node.js — compila TypeScript e instala dependências nativas
# -----------------------------------------------------------------------------
FROM node:20-slim AS node-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 4: Runtime — imagem final mínima
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# Instala Node.js 20 LTS e dependências mínimas de runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates libgomp1 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia binário do Qdrant
COPY --from=qdrant-bin /qdrant/qdrant /app/bin/qdrant
RUN chmod +x /app/bin/qdrant

# Copia venv Python (com supervisor, torch, sentence-transformers, etc.)
COPY --from=python-builder /app/venv /app/venv

# Copia modelos HuggingFace pré-baixados
COPY --from=python-builder /app/models /app/models

# Copia código Python dos servidores
COPY python/embedding_server/ /app/python/embedding_server/
COPY python/reranker_server/ /app/python/reranker_server/

# Copia artefatos Node.js compilados
COPY --from=node-builder /build/dist /app/dist
COPY --from=node-builder /build/node_modules /app/node_modules
COPY package.json /app/package.json

# Copia scripts e configs do container
COPY docker/ /app/docker/
RUN chmod +x /app/docker/*.sh

# Cria diretórios necessários
RUN mkdir -p /app/data /workspace /app/bin

# Variáveis de ambiente padrão
ENV PATH="/app/venv/bin:/app/bin:$PATH"
ENV HF_HOME="/app/models"
ENV HF_HUB_OFFLINE="1"
ENV TRANSFORMERS_OFFLINE="1"
ENV NODE_ENV="production"
ENV PORT="3000"
ENV HOST="0.0.0.0"
ENV AUTO_INDEX="true"
ENV WATCH_PATH="/workspace"
ENV WATCH_ENABLED="true"
ENV RAG_DATA_DIR="/app/data"
ENV QDRANT_URL="http://localhost:6333"
ENV RAG_EMBEDDING_URL="http://localhost:8001"
ENV RAG_RERANK_URL="http://localhost:8002"

# Expõe apenas a porta da API REST
EXPOSE 3000

# Volumes para repositório externo e persistência de dados
VOLUME ["/workspace", "/app/data"]

# Health check da API
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD curl -sf http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

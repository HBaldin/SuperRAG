#!/bin/bash
set -e

echo "[entrypoint] Iniciando SuperRAG container..."

# Cria diretórios de dados necessários
mkdir -p \
  /app/data/qdrant \
  /app/data/sqlite \
  /app/data/cache \
  /app/data/embedding-cache \
  /workspace

# Configura RAG_CONFIG: usa customizada via env ou a padrão do container
if [ -z "$RAG_CONFIG" ]; then
  export RAG_CONFIG="/app/rag.config.json"
  if [ ! -f "$RAG_CONFIG" ]; then
    echo "[entrypoint] Copiando config padrão do container..."
    cp /app/docker/rag.config.container.json "$RAG_CONFIG"
  fi
else
  echo "[entrypoint] Usando RAG_CONFIG customizada: $RAG_CONFIG"
fi

# Exibe configuração de ambiente
echo "[entrypoint] Configuração:"
echo "  RAG_CONFIG=$RAG_CONFIG"
echo "  RAG_DATA_DIR=${RAG_DATA_DIR:-/app/data}"
echo "  WATCH_PATH=${WATCH_PATH:-/workspace}"
echo "  AUTO_INDEX=${AUTO_INDEX:-true}"
echo "  WATCH_ENABLED=${WATCH_ENABLED:-true}"

# Inicia auto-indexação em background após os serviços subirem
# O script auto-index.sh aguarda a API estar pronta antes de indexar
(sleep 10 && /app/docker/auto-index.sh) &

echo "[entrypoint] Iniciando supervisord..."
exec /app/venv/bin/supervisord -c /app/docker/supervisord.conf

#!/bin/bash
set -e

SERVICES=(
  "http://localhost:6333/health:Qdrant"
  "http://localhost:8001/health:Embedding"
  "http://localhost:8002/health:Reranker"
)

MAX_WAIT=180
INTERVAL=3

for entry in "${SERVICES[@]}"; do
  url="${entry%%:*}"
  name="${entry##*:}"
  elapsed=0
  echo "[wait-for-services] Aguardando $name em $url..."
  until curl -sf "$url" > /dev/null 2>&1; do
    if [ $elapsed -ge $MAX_WAIT ]; then
      echo "[wait-for-services] TIMEOUT: $name não respondeu em ${MAX_WAIT}s. Abortando."
      exit 1
    fi
    sleep $INTERVAL
    elapsed=$((elapsed + INTERVAL))
  done
  echo "[wait-for-services] $name pronto (${elapsed}s)."
done

echo "[wait-for-services] Todos os serviços prontos. Iniciando: $*"
exec "$@"

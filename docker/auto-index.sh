#!/bin/bash
# auto-index.sh — Indexa o repositório montado em WATCH_PATH e ativa o file watcher

AUTO_INDEX="${AUTO_INDEX:-true}"
WATCH_PATH="${WATCH_PATH:-/workspace}"
WATCH_ENABLED="${WATCH_ENABLED:-true}"
API_URL="http://localhost:3000"
MAX_WAIT=120
INTERVAL=3

if [ "$AUTO_INDEX" != "true" ]; then
  echo "[auto-index] AUTO_INDEX=false, pulando indexação automática."
  exit 0
fi

if [ ! -d "$WATCH_PATH" ] || [ -z "$(ls -A "$WATCH_PATH" 2>/dev/null)" ]; then
  echo "[auto-index] WATCH_PATH=$WATCH_PATH não existe ou está vazio. Pulando indexação."
  exit 0
fi

# Aguarda API estar pronta
elapsed=0
echo "[auto-index] Aguardando API em $API_URL/health..."
until curl -sf "$API_URL/health" > /dev/null 2>&1; do
  if [ $elapsed -ge $MAX_WAIT ]; then
    echo "[auto-index] TIMEOUT: API não respondeu em ${MAX_WAIT}s."
    exit 1
  fi
  sleep $INTERVAL
  elapsed=$((elapsed + INTERVAL))
done
echo "[auto-index] API pronta. Iniciando indexação de $WATCH_PATH..."

# Indexação inicial
RESPONSE=$(curl -sf -X POST "$API_URL/index" \
  -H "Content-Type: application/json" \
  -d "{\"projectPath\":\"$WATCH_PATH\",\"force\":false}" 2>&1) || true

if [ -n "$RESPONSE" ]; then
  echo "[auto-index] Resposta da indexação: $RESPONSE"
else
  echo "[auto-index] Indexação iniciada (sem resposta imediata)."
fi

# Ativa file watcher se habilitado
if [ "$WATCH_ENABLED" = "true" ]; then
  echo "[auto-index] Ativando file watcher em $WATCH_PATH..."
  WATCH_RESPONSE=$(curl -sf -X POST "$API_URL/index/watch" \
    -H "Content-Type: application/json" \
    -d "{\"projectPath\":\"$WATCH_PATH\"}" 2>&1) || true
  echo "[auto-index] Watcher: $WATCH_RESPONSE"
fi

echo "[auto-index] Concluído."

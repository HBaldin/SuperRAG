#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create venv if not exists
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install deps
pip install -q -r requirements.txt

# Create cache dir
mkdir -p ./cache/embeddings

# Start server
echo "Starting embedding server on port ${EMBEDDING_PORT:-8001}..."
python main.py

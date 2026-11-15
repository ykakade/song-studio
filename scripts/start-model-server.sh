#!/bin/bash
# Starts the ACE-Step 1.5 REST API (the music model) on localhost only.
# Cold start takes about 80 s until /health answers. Stop it with Ctrl-C, or:
#   kill -INT $(lsof -nP -tiTCP:8001 -sTCP:LISTEN)
set -euo pipefail

# ACE-Step is expected next to this repository (../ACE-Step-1.5); set ACESTEP_DIR if it is elsewhere.
ACESTEP_DIR="${ACESTEP_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/ACE-Step-1.5}"
ACESTEP_HOST="${ACESTEP_HOST:-127.0.0.1}"
ACESTEP_PORT="${ACESTEP_PORT:-8001}"
UV="${UV:-$(command -v uv || echo "$HOME/.local/bin/uv")}"

if [ ! -d "$ACESTEP_DIR" ]; then
  echo "ACE-Step was not found at $ACESTEP_DIR. Set ACESTEP_DIR to where you cloned it." >&2
  exit 1
fi

if lsof -nP -tiTCP:"$ACESTEP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already listening on port $ACESTEP_PORT." >&2
  exit 1
fi

cd "$ACESTEP_DIR"
exec env ACESTEP_LM_BACKEND=mlx TOKENIZERS_PARALLELISM=false \
  ACESTEP_INIT_LLM=auto ACESTEP_NO_INIT=false \
  "$UV" run acestep-api --host "$ACESTEP_HOST" --port "$ACESTEP_PORT"

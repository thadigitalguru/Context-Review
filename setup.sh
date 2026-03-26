#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

echo "Installing dependencies..."
npm install

mkdir -p data .codex

cat <<'EOF'

Context Review setup complete.

Start the app:
  npm start

Endpoints:
  Dashboard: http://localhost:5000
  Proxy:     http://localhost:8080

Example proxy configuration:
  export ANTHROPIC_BASE_URL=http://localhost:8080
  export OPENAI_BASE_URL=http://localhost:8080
  export GOOGLE_API_BASE_URL=http://localhost:8080
EOF

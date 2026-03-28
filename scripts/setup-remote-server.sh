#!/usr/bin/env bash
# =============================================================================
# setup-remote-server.sh
#
# One-time setup of the production server for katisha-api-gw.
# Idempotent — safe to re-run.
#
# Usage:
#   1. cp scripts/setup-remote-server.sh scripts/setup-remote-server.prod.sh
#   2. Fill in every YOUR_* placeholder in the .prod copy
#   3. bash scripts/setup-remote-server.prod.sh
# =============================================================================
set -euo pipefail

SSH_HOST="YOUR_SERVER_IP_OR_HOSTNAME"
SSH_USER="YOUR_SERVER_SSH_USER"
SSH_PORT="22"
SSH_KEY="YOUR_PATH_TO_PRIVATE_KEY"
DEPLOY_PATH="YOUR_SERVER_DEPLOY_PATH"

DOCKER_USERNAME="YOUR_DOCKERHUB_USERNAME"
DOCKER_TOKEN="YOUR_DOCKERHUB_ACCESS_TOKEN"

# --- Service env vars ---
NODE_ENV="production"
PORT="3000"
JWT_PUBLIC_KEY="YOUR_RS256_PUBLIC_KEY_SINGLE_LINE_WITH_LITERAL_NEWLINES"
CONFIG_REPO_URL="YOUR_RAW_GITHUB_URL_TO_ROUTES_YAML"
CONFIG_REPO_TOKEN="YOUR_GITHUB_PAT"
CONFIG_POLL_INTERVAL_MS="30000"
USER_SERVICE_URL="http://katisha-user-service:3001"

SSH_CMD="ssh -i ${SSH_KEY} -p ${SSH_PORT} -o StrictHostKeyChecking=no ${SSH_USER}@${SSH_HOST}"
SCP_CMD="scp -i ${SSH_KEY} -P ${SSH_PORT} -o StrictHostKeyChecking=no"

echo "→ Creating deployment directory"
$SSH_CMD "mkdir -p ${DEPLOY_PATH}"

echo "→ Uploading docker-compose.yml"
$SCP_CMD docker-compose.yml "${SSH_USER}@${SSH_HOST}:${DEPLOY_PATH}/docker-compose.yml"

echo "→ Writing .env on server"
$SSH_CMD "cat > ${DEPLOY_PATH}/.env" << EOF
NODE_ENV=${NODE_ENV}
PORT=${PORT}
DOCKER_USERNAME=${DOCKER_USERNAME}
IMAGE_TAG=latest
JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}
CONFIG_REPO_URL=${CONFIG_REPO_URL}
CONFIG_REPO_TOKEN=${CONFIG_REPO_TOKEN}
CONFIG_POLL_INTERVAL_MS=${CONFIG_POLL_INTERVAL_MS}
USER_SERVICE_URL=${USER_SERVICE_URL}
EOF

echo "→ Creating katisha-net network (skipped if exists)"
$SSH_CMD "docker network inspect katisha-net > /dev/null 2>&1 || docker network create katisha-net"

echo "→ Docker Hub login on server"
$SSH_CMD "echo '${DOCKER_TOKEN}' | docker login --username '${DOCKER_USERNAME}' --password-stdin"

echo "→ Initial pull and start"
$SSH_CMD "cd ${DEPLOY_PATH} && docker compose pull api-gw && docker compose up -d api-gw"

echo ""
echo "✓ Server setup complete."
echo "  Logs: ssh ${SSH_USER}@${SSH_HOST} 'docker logs -f katisha-api-gw'"

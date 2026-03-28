#!/usr/bin/env bash
# =============================================================================
# setup-github-secrets.sh
#
# Registers all GitHub Actions secrets for the katisha-api-gw repo.
#
# Usage:
#   1. cp scripts/setup-github-secrets.sh scripts/setup-github-secrets.prod.sh
#   2. Fill in every YOUR_* placeholder in the .prod copy
#   3. bash scripts/setup-github-secrets.prod.sh
#
# Prerequisites: gh CLI installed and authenticated (gh auth login)
# =============================================================================
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "Setting secrets for: ${REPO}"

DOCKER_USERNAME="YOUR_DOCKERHUB_USERNAME"
DOCKER_TOKEN="YOUR_DOCKERHUB_ACCESS_TOKEN"

SSH_HOST="YOUR_SERVER_IP_OR_HOSTNAME"
SSH_USER="YOUR_SERVER_SSH_USER"
SSH_PORT="22"
SSH_PRIVATE_KEY_PATH="YOUR_PATH_TO_PRIVATE_KEY"

DEPLOY_PATH="YOUR_SERVER_DEPLOY_PATH"

echo "→ Docker Hub credentials"
gh secret set DOCKER_USERNAME  --repo "$REPO" --body "$DOCKER_USERNAME"
gh secret set DOCKER_TOKEN     --repo "$REPO" --body "$DOCKER_TOKEN"

echo "→ SSH connection"
gh secret set SSH_HOST         --repo "$REPO" --body "$SSH_HOST"
gh secret set SSH_USER         --repo "$REPO" --body "$SSH_USER"
gh secret set SSH_PORT         --repo "$REPO" --body "$SSH_PORT"

echo "→ SSH private key (read from file)"
gh secret set SSH_PRIVATE_KEY  --repo "$REPO" < "$SSH_PRIVATE_KEY_PATH"

echo "→ Deployment path"
gh secret set DEPLOY_PATH      --repo "$REPO" --body "$DEPLOY_PATH"

echo ""
echo "✓ All secrets set. Verify at:"
echo "  https://github.com/${REPO}/settings/secrets/actions"

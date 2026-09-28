#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

# Use an isolated Compose project and no real credentials, even if a local .env exists.
project="agent-office-smoke-$$"
export AGENT_OFFICE_PASSWORD=container-smoke-test-only
export AGENT_OFFICE_AGENT=claude AGENT_OFFICE_MAX_WORKERS=1
export AGENT_OFFICE_BUDGET= AGENT_OFFICE_BUDGET_PAUSE=0 AGENT_OFFICE_CITY=
export GH_TOKEN= ANTHROPIC_API_KEY= CLAUDE_CODE_OAUTH_TOKEN=
export GIT_USER_NAME=ContainerTest GIT_USER_EMAIL=container-test@example.invalid
compose() { docker compose --env-file /dev/null -p "$project" -f docker-compose.yml "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color || true; fi
  # Only this script's uniquely named test project and volume are removed.
  compose down --volumes --remove-orphans
}
trap cleanup EXIT

compose config --quiet
compose build
compose up --detach --wait --wait-timeout 120
compose exec -T agent-office node --input-type=module - < deploy/docker-smoke.mjs
compose up --detach --force-recreate --wait --wait-timeout 120
compose exec -T agent-office node --input-type=module - after-recreate < deploy/docker-smoke.mjs

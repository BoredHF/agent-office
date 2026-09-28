#!/bin/sh
set -eu
umask 077

mkdir -p "$AGENT_OFFICE_HOME" "$AGENT_OFFICE_PROJECTS"

# Use gh's credential helper so git clone/push works without embedding tokens in URLs.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git --hostname github.com
fi
if [ -n "${GIT_USER_NAME:-}" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

exec "$@"

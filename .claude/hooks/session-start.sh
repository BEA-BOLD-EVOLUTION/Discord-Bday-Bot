#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (remote) sessions; local sessions manage
# their own dependencies.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Async mode: run the install in the background so the session starts without
# waiting. asyncTimeout is in milliseconds (5 min). Trade-off vs. synchronous:
# the agent could act before deps finish installing.
echo '{"async": true, "asyncTimeout": 300000}'

cd "$CLAUDE_PROJECT_DIR"

# Install Node dependencies so tests/linters/the bot can run. `npm install`
# (not `ci`) is idempotent and benefits from the cached container state.
npm install

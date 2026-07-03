#!/usr/bin/env bash
# Build + deploy to Cloudflare (production by default, staging with `staging`).
#
# FOOTGUN this script exists to prevent: Node's --env-file does NOT override
# variables already present in the environment. A shell that had sourced
# .env.local (dev Clerk keys) once shipped a production bundle with
# pk_test_* baked into the client, which broke sign-in for everyone
# (dev-instance handshake tokens vs the prod CLERK_SECRET_KEY → kid mismatch
# → 500). Sourcing .env.production HERE overwrites whatever the parent shell
# had, so the build always inlines production NEXT_PUBLIC_* values.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env.production
set +a
# Never let dev-only Clerk secrets leak into the build environment.
unset CLERK_SECRET_KEY

node node_modules/@opennextjs/cloudflare/dist/cli/index.js build

# Real keys have a base64 payload after the prefix; Clerk's own library code
# contains bare "pk_test_"/"pk_live_" prefix-check strings, which are fine.
BUILT_KEY=$(grep -rho "pk_live_[A-Za-z0-9]\{8,\}\|pk_test_[A-Za-z0-9]\{8,\}" .open-next/assets/_next/static/chunks 2>/dev/null | sort -u | head -3)
echo "Clerk publishable key(s) in built client bundle: ${BUILT_KEY:-none found}"
if [ "${1:-}" != "staging" ] && echo "$BUILT_KEY" | grep -q "pk_test"; then
  echo "ERROR: refusing to deploy — a pk_test (dev instance) Clerk key is baked into the production bundle." >&2
  exit 1
fi

if [ "${1:-}" = "staging" ]; then
  node node_modules/@opennextjs/cloudflare/dist/cli/index.js deploy -- --env staging
else
  node node_modules/@opennextjs/cloudflare/dist/cli/index.js deploy
fi

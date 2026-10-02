#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR=${CLOUD_HARNESS_CONFIG_DIR:-/etc/cloud-harness-mcp}
STATE_DIR=${CLOUD_HARNESS_STATE_DIR:-/var/lib/cloud-harness}
ENV_FILE="${CLOUD_HARNESS_ENV_FILE:-$CONFIG_DIR/runtime.env}"

source deploy/scripts/release-runtime.sh
ingress_mode=$(resolve_ingress_mode "$CONFIG_DIR/ingress.conf")
compose_files=(-f compose.yaml -f compose.production.yaml)
if [[ $ingress_mode == tunnel ]]; then
  [[ -f deploy/cloudflare-tunnel/compose.tunnel.yaml ]] || { echo "tunnel Compose file is missing" >&2; exit 1; }
  validate_tunnel_token_file "$CONFIG_DIR/cloudflare-tunnel-token"
  compose_files+=(-f deploy/cloudflare-tunnel/compose.tunnel.yaml)
fi

export CLOUD_HARNESS_CONFIG_DIR="$CONFIG_DIR"
export CLOUD_HARNESS_ENV_FILE="$ENV_FILE"
export HOST_JOBS_ROOT="${HOST_JOBS_ROOT:-$STATE_DIR/jobs}"
export HOST_STATE_ROOT="${HOST_STATE_ROOT:-$STATE_DIR/state}"
export HOST_ARTIFACT_ROOT="${HOST_ARTIFACT_ROOT:-$STATE_DIR/artifacts}"

exec /usr/bin/docker compose "${compose_files[@]}" "$@"

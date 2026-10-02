#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=${CLOUD_HARNESS_REPO_DIR:-/opt/cloud-harness-mcp/repo}
state=${CLOUD_HARNESS_STATE_DIR:-/var/lib/cloud-harness}
config_root=${CLOUD_HARNESS_CONFIG_DIR:-/etc/cloud-harness-mcp}
env_file=$config_root/runtime.env
canary_credentials_file=$config_root/canary-credentials

[[ -d $repo/.git ]] || { echo "deployment checkout is unavailable" >&2; exit 1; }
cd "$repo"
source deploy/scripts/release-runtime.sh

exec 9>"$state/deploy.lock"
if ! flock -n 9; then
  echo "another Cloud Harness deployment is already running" >&2
  exit 75
fi

snapshot=$(resolve_rollback_snapshot) || { echo "no valid rollback snapshot is available" >&2; exit 1; }
if ! rollback_to_snapshot "$snapshot"; then
  contain_failed_release || true
  echo "rollback did not become healthy; service contained" >&2
  exit 70
fi

echo "restored rollback snapshot $(basename "$snapshot")"

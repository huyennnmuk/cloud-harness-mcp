#!/usr/bin/env bash
set -euo pipefail
umask 077

state=${CLOUD_HARNESS_STATE_DIR:-/var/lib/cloud-harness}
config_root=${CLOUD_HARNESS_CONFIG_DIR:-/etc/cloud-harness-mcp}
env_file=$config_root/runtime.env
canary_credentials_file=$config_root/canary-credentials
repo=${CLOUD_HARNESS_REPO_DIR:-/opt/cloud-harness-mcp/repo}
origin=${CLOUD_HARNESS_PROJECT_ORIGIN:-https://github.com/huyennnmuk/cloud-harness-mcp.git}
release_sha=${1:-}

install -d -o root -g root -m 0700 "$state" "$state/state" "$state/backups"
install -d -o root -g root -m 0750 "$state/jobs" "$state/artifacts"
deploy_lock="$state/deploy.lock"
exec 9>"$deploy_lock"
if ! flock -n 9; then
  echo "another Cloud Harness deployment is already running" >&2
  exit 75
fi

[[ $release_sha =~ ^[0-9a-f]{40}$ ]] || { echo "release must be an exact 40-character commit SHA" >&2; exit 2; }
[[ ! -L $env_file && -f $env_file ]] || { echo "runtime configuration must be a regular non-symlink file" >&2; exit 5; }
if grep -Eq '^(MCP_CANARY_URL|MCP_CANARY_ACCESS_CLIENT_ID|MCP_CANARY_ACCESS_CLIENT_SECRET)=' "$env_file"; then
  echo "Access canary credentials must be stored in $canary_credentials_file, not the runtime configuration" >&2
  exit 5
fi

if [[ ! -d $repo/.git ]]; then
  git clone --filter=blob:none --no-checkout "$origin" "$repo"
fi
cd "$repo"
[[ $(git remote get-url origin) == "$origin" ]] || { echo "unexpected deployment origin" >&2; exit 3; }
git fetch --force --prune origin main
git cat-file -e "$release_sha^{commit}" 2>/dev/null || { echo "release commit is unavailable" >&2; exit 4; }
git merge-base --is-ancestor "$release_sha" origin/main || { echo "release is not on origin/main" >&2; exit 4; }
for required in \
  compose.yaml compose.production.yaml deploy/cloudflare-tunnel/compose.tunnel.yaml \
  deploy/scripts/deploy-release.sh deploy/scripts/release-runtime.sh \
  deploy/scripts/rollback-release.sh deploy/scripts/service-compose.sh \
  deploy/scripts/setup-dependency-firewall.sh deploy/scripts/reconcile-dependency-egress.sh \
  deploy/systemd/cloud-harness-mcp.service; do
  git cat-file -e "$release_sha:$required" 2>/dev/null || { echo "release is missing required deployment file: $required" >&2; exit 4; }
done

candidate_dir=$(mktemp -d "$state/candidate.XXXXXX")
trap 'rm -rf -- "$candidate_dir"' EXIT
git archive "$release_sha" | tar -x -C "$candidate_dir"
(
  cd "$candidate_dir"
  source deploy/scripts/release-runtime.sh
  resolved_ingress_mode=$(resolve_ingress_mode "$config_root/ingress.conf")
  if [[ $resolved_ingress_mode == tunnel ]]; then
    validate_tunnel_token_file "$config_root/cloudflare-tunnel-token"
  fi
  compose config --quiet
)
source "$candidate_dir/deploy/scripts/release-runtime.sh"
resolved_ingress_mode=$(resolve_ingress_mode "$config_root/ingress.conf")

previous_sha=$(cat "$state/release-current" 2>/dev/null || true)
if [[ -n $previous_sha && ! $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
  echo "current release metadata is invalid" >&2
  exit 6
fi
if [[ $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
  if [[ -f $state/release-generation-current/sha ]]; then
    gen_sha=$(cat "$state/release-generation-current/sha" 2>/dev/null || true)
    if [[ $gen_sha != "$previous_sha" ]]; then
      echo "current release generation SHA ($gen_sha) does not match recorded release SHA ($previous_sha)" >&2
      exit 6
    fi
  fi
fi
if [[ $previous_sha =~ ^[0-9a-f]{40}$ ]]; then
  if [[ ! -e $state/release-config-current && ! -L $state/release-config-current ]]; then
    record_release_config || { echo "could not seed the last-known-good configuration" >&2; exit 6; }
  fi
  [[ ! -L $state/release-config-current && -d $state/release-config-current ]] || { echo "last-known-good configuration is unavailable" >&2; exit 6; }
  image_metadata_complete=true
  for name in "${IMAGE_NAMES[@]}"; do
    if [[ -f $state/release-${name}-image ]]; then
      recorded_id=$(<"$state/release-${name}-image")
      docker image inspect "$recorded_id" >/dev/null 2>&1 || image_metadata_complete=false
    else
      image_metadata_complete=false
    fi
  done
  if [[ $image_metadata_complete == false ]]; then
    verify_running_images || { echo "current release image identity could not be verified" >&2; exit 6; }
    record_images release || { echo "current release image metadata could not be seeded" >&2; exit 6; }
  fi
  for name in "${IMAGE_NAMES[@]}"; do
    image_id=$(<"$state/release-${name}-image")
    [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "recorded image metadata is invalid" >&2; exit 6; }
    docker image inspect "$image_id" >/dev/null 2>&1 || { echo "recorded rollback image is unavailable" >&2; exit 6; }
  done
fi

auth_mode=$(read_env_value AUTH_MODE "$env_file") || { echo "runtime AUTH_MODE is missing or invalid" >&2; exit 5; }
if [[ $auth_mode == owner-bearer ]]; then
  read_env_value MCP_BEARER_TOKEN "$env_file" >/dev/null || { echo "owner canary credential is missing" >&2; exit 5; }
elif [[ $auth_mode == cloudflare-access ]]; then
  url=$(read_env_value MCP_CANARY_URL "$canary_credentials_file") || { echo "Access canary URL is missing" >&2; exit 5; }
  [[ $url == https://* ]] || { echo "MCP_CANARY_URL must be the public HTTPS Access endpoint" >&2; exit 5; }
  read_env_value MCP_CANARY_ACCESS_CLIENT_ID "$canary_credentials_file" >/dev/null || { echo "Access canary client id is missing" >&2; exit 5; }
  read_env_value MCP_CANARY_ACCESS_CLIENT_SECRET "$canary_credentials_file" >/dev/null || { echo "Access canary client secret is missing" >&2; exit 5; }
else
  echo "unsupported AUTH_MODE: $auth_mode" >&2
  exit 5
fi

rollback_probe="$state/backups/.write-probe.$$"
(umask 077; : > "$rollback_probe") || { echo "rollback storage is not writable" >&2; exit 6; }
rm -f -- "$rollback_probe"

backup_dir=
trap rollback ERR
stop_release
snapshot_path="$state/backups/cloud-harness-$(date -u +%Y%m%dT%H%M%S)-$(date +%N)-$$"
create_snapshot "$snapshot_path" "$previous_sha"
backup_dir=$snapshot_path
publish_rollback_snapshot "$backup_dir"

git checkout --detach --force "$release_sha"
[[ -z $(git status --porcelain --untracked-files=all) ]] || { echo "deployment checkout is dirty" >&2; false; }
source deploy/scripts/release-runtime.sh
resolved_ingress_mode=$(resolve_ingress_mode "$config_root/ingress.conf")
install_release_service_files
compose --profile images build executor-image agent-image network-guard-image api runner model-gateway
systemctl enable --now cloud-harness-mcp.service
wait_ready
verify_running_images
run_release_canary "$resolved_ingress_mode"
record_release_generation "$release_sha"
install -m 0755 deploy/scripts/deploy-release.sh /usr/local/sbin/cloud-harness-deploy
install -m 0755 deploy/scripts/rollback-release.sh /usr/local/sbin/cloud-harness-rollback
install -m 0755 deploy/scripts/upgrade-nginx-dashboard.sh /usr/local/sbin/cloud-harness-upgrade-nginx
prune_release_backups
trap - ERR
echo "deployed $release_sha"

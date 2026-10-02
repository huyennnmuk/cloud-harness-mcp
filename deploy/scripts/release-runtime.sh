#!/usr/bin/env bash

IMAGE_NAMES=(api runner executor network-guard agent model-gateway)

image_reference() {
  case "$1" in
    api) printf '%s\n' cloud-harness-api:local ;;
    runner) printf '%s\n' cloud-harness-runner:local ;;
    executor) printf '%s\n' cloud-harness-executor:local ;;
    network-guard) printf '%s\n' cloud-harness-network-guard:local ;;
    agent) printf '%s\n' cloud-harness-agent:local ;;
    model-gateway) printf '%s\n' cloud-harness-model-gateway:local ;;
    *) return 1 ;;
  esac
}

resolve_ingress_mode() {
  local path=$1 line mode='' assignments=0 size
  if [[ ! -e $path && ! -L $path ]]; then
    printf '%s\n' legacy-managed-nginx
    return 0
  fi
  [[ ! -L $path && -f $path ]] || { echo "ingress configuration must be a regular non-symlink file: $path" >&2; return 1; }
  size=$(stat -c '%s' -- "$path") || return 1
  (( size <= 4096 )) || { echo "ingress configuration exceeds 4096 bytes" >&2; return 1; }
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*$ || $line =~ ^[[:space:]]*# ]] && continue
    if [[ $line =~ ^INGRESS_MODE=(tunnel|caddy|custom)$ ]]; then
      (( assignments += 1 ))
      mode=${BASH_REMATCH[1]}
      (( assignments == 1 )) || { echo "ingress configuration contains duplicate assignments" >&2; return 1; }
    else
      echo "ingress configuration contains an unsupported line" >&2
      return 1
    fi
  done < "$path"
  (( assignments == 1 )) || { echo "ingress configuration must contain exactly one INGRESS_MODE assignment" >&2; return 1; }
  printf '%s\n' "$mode"
}

validate_tunnel_token_file() {
  local path=${1:-/etc/cloud-harness-mcp/cloudflare-tunnel-token}
  local metadata parent_metadata owner group mode size token byte_length
  local -a lines=()
  [[ ! -L $path && -f $path ]] || { echo "Cloudflare Tunnel token file must be a regular non-symlink file" >&2; return 1; }
  parent_metadata=$(stat -c '%u:%g:%a' -- "$(dirname "$path")") || return 1
  [[ $parent_metadata == 0:0:700 ]] || { echo "Cloudflare Tunnel token directory must be owned by root:root with mode 0700" >&2; return 1; }
  metadata=$(stat -c '%u:%g:%a:%s' -- "$path") || return 1
  IFS=: read -r owner group mode size <<< "$metadata"
  [[ $owner == 0 && $group == 65534 && $mode == 640 ]] || {
    echo "Cloudflare Tunnel token file must be owned by root:65534 with mode 0640" >&2
    return 1
  }
  (( size > 0 && size <= 16384 )) || { echo "Cloudflare Tunnel token file size is invalid" >&2; return 1; }
  mapfile -t lines < "$path"
  (( ${#lines[@]} == 1 )) || { echo "Cloudflare Tunnel token file must contain exactly one line" >&2; return 1; }
  token=${lines[0]}
  [[ -n $token && $token != *$'\r'* ]] || { echo "Cloudflare Tunnel token file contains an invalid value" >&2; return 1; }
  LC_ALL=C printf -v byte_length '%d' "${#token}"
  (( size == byte_length || size == byte_length + 1 )) || { echo "Cloudflare Tunnel token file contains invalid bytes" >&2; return 1; }
}

compose() {
  local ingress_mode=${resolved_ingress_mode:-}
  local root=${config_root:-/etc/cloud-harness-mcp}
  local compose_files=(-f compose.yaml -f compose.production.yaml)
  if [[ -z $ingress_mode ]]; then
    ingress_mode=$(resolve_ingress_mode "$root/ingress.conf") || return 1
  fi
  if [[ $ingress_mode == tunnel ]]; then
    [[ -f deploy/cloudflare-tunnel/compose.tunnel.yaml ]] || { echo "tunnel Compose file is missing" >&2; return 1; }
    validate_tunnel_token_file "$root/cloudflare-tunnel-token" || return 1
    compose_files+=(-f deploy/cloudflare-tunnel/compose.tunnel.yaml)
  fi
  CLOUD_HARNESS_CONFIG_DIR="$root" CLOUD_HARNESS_ENV_FILE="$env_file" \
    HOST_JOBS_ROOT="$state/jobs" HOST_STATE_ROOT="$state/state" HOST_ARTIFACT_ROOT="$state/artifacts" \
    docker compose "${compose_files[@]}" "$@"
}
compose_core() {
  local resolved_ingress_mode=custom
  compose "$@"
}


wait_ready() {
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3100/readyz >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

record_images() {
  local prefix=$1 name reference
  for name in "${IMAGE_NAMES[@]}"; do
    reference=$(image_reference "$name") || return 1
    docker image inspect "$reference" --format '{{.Id}}' > "$state/${prefix}-${name}-image" || return 1
  done
}

verify_running_images() {
  local name reference expected service container actual
  for name in "${IMAGE_NAMES[@]}"; do
    reference=$(image_reference "$name") || return 1
    docker image inspect "$reference" --format '{{.Id}}' >/dev/null || return 1
  done
  while read -r service name; do
    reference=$(image_reference "$name") || return 1
    expected=$(docker image inspect "$reference" --format '{{.Id}}') || return 1
    container=$(compose_core ps -q "$service") || return 1
    [[ -n $container ]] || return 1
    actual=$(docker inspect "$container" --format '{{.Image}}') || return 1
    [[ $actual == "$expected" ]] || return 1
  done <<'EOF'
api api
ingress api
provisioning-proxy api
runner runner
model-gateway model-gateway
executor-image-keepalive executor
agent-image-keepalive agent
EOF
}

stop_release() {
  local failed=0 status containers
  systemctl stop cloud-harness-mcp.service || failed=1
  compose down --remove-orphans || failed=1
  if systemctl is-active --quiet cloud-harness-mcp.service; then
    failed=1
  else
    status=$?
    [[ $status -eq 3 ]] || failed=1
  fi
  if ! containers=$(compose ps -q); then
    failed=1
  elif [[ -n $containers ]]; then
    failed=1
  fi
  return "$failed"
}

contain_failed_release() {
  local failed=0 status containers
  systemctl disable --now cloud-harness-mcp.service || failed=1
  compose down --remove-orphans || failed=1
  if systemctl is-active --quiet cloud-harness-mcp.service; then
    failed=1
  else
    status=$?
    [[ $status -eq 3 ]] || failed=1
  fi
  if ! containers=$(compose ps -q); then
    failed=1
  elif [[ -n $containers ]]; then
    failed=1
  fi
  return "$failed"
}

install_release_service_files() {
  local failed=0
  install -m 0755 deploy/scripts/service-compose.sh /usr/local/sbin/cloud-harness-service-compose || failed=1
  install -m 0755 deploy/scripts/setup-dependency-firewall.sh /usr/local/sbin/cloud-harness-setup-dependency-firewall || failed=1
  if [[ -f deploy/scripts/reconcile-dependency-egress.sh ]]; then
    install -m 0755 deploy/scripts/reconcile-dependency-egress.sh /usr/local/sbin/cloud-harness-reconcile-dependency-egress || failed=1
  else
    rm -f -- /usr/local/sbin/cloud-harness-reconcile-dependency-egress || failed=1
  fi
  install -m 0644 deploy/systemd/cloud-harness-mcp.service /etc/systemd/system/cloud-harness-mcp.service || failed=1
  systemctl daemon-reload || failed=1
  return "$failed"
}

prepare_access_ingress() {
  case "$1" in
    legacy-managed-nginx) deploy/scripts/upgrade-nginx-dashboard.sh ;;
    tunnel|caddy|custom) return 0 ;;
    *) echo "unsupported resolved ingress mode: $1" >&2; return 1 ;;
  esac
}

read_env_value() {
  local name=$1 path=$2 line found=0 value=''
  [[ ! -L $path && -f $path ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$name="* ]]; then
      (( found += 1 ))
      value=${line#*=}
    fi
  done < "$path"
  (( found == 1 )) || return 1
  [[ -n $value && $value != *$'\r'* ]] || return 1
  printf '%s\n' "$value"
}

run_release_canary() {
  local ingress_mode=$1 auth_mode token url client_id client_secret
  auth_mode=$(read_env_value AUTH_MODE "$env_file") || return 1
  if [[ $auth_mode == owner-bearer ]]; then
    token=$(read_env_value MCP_BEARER_TOKEN "$env_file") || return 1
    curl --fail --silent --show-error --max-time 10 \
      --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"1.0.0"}}}' \
      --config - >/dev/null <<EOF
url = "http://127.0.0.1:3100/mcp"
request = "POST"
header = "Host: 127.0.0.1"
header = "Authorization: Bearer $token"
header = "Content-Type: application/json"
header = "Accept: application/json, text/event-stream"
EOF
    compose_core exec -T api node /app/scripts/deploy-canary.mjs
  elif [[ $auth_mode == cloudflare-access ]]; then
    prepare_access_ingress "$ingress_mode" || return 1
    url=$(read_env_value MCP_CANARY_URL "$canary_credentials_file") || return 1
    client_id=$(read_env_value MCP_CANARY_ACCESS_CLIENT_ID "$canary_credentials_file") || return 1
    client_secret=$(read_env_value MCP_CANARY_ACCESS_CLIENT_SECRET "$canary_credentials_file") || return 1
    [[ $url == https://* ]] || { echo "MCP_CANARY_URL must be the public HTTPS Access endpoint" >&2; return 1; }
    (
      export MCP_CANARY_URL=$url MCP_CANARY_ACCESS_CLIENT_ID=$client_id MCP_CANARY_ACCESS_CLIENT_SECRET=$client_secret
      compose_core run --rm --no-deps \
        -e MCP_CANARY_URL -e MCP_CANARY_ACCESS_CLIENT_ID -e MCP_CANARY_ACCESS_CLIENT_SECRET \
        ingress node /app/scripts/deploy-canary.mjs
    )
  else
    echo "unsupported AUTH_MODE: $auth_mode" >&2
    return 1
  fi
}

snapshot_manifest_value() {
  local snapshot=$1 key=$2 line found=0 value=''
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$key="* ]]; then
      (( found += 1 ))
      value=${line#*=}
    fi
  done < "$snapshot/manifest"
  (( found == 1 )) || return 1
  printf '%s\n' "$value"
}

validate_snapshot() {
  local snapshot=$1 canonical kind sha version name image_id
  [[ ! -L $snapshot && -d $snapshot ]] || return 1
  canonical=$(readlink -f -- "$snapshot") || return 1
  [[ $canonical == "$state/backups/"* ]] || return 1
  for name in manifest config.tar state.tar artifacts.tar SHA256SUMS; do
    [[ ! -L $snapshot/$name && -f $snapshot/$name ]] || return 1
  done
  version=$(snapshot_manifest_value "$snapshot" version) || return 1
  kind=$(snapshot_manifest_value "$snapshot" kind) || return 1
  sha=$(snapshot_manifest_value "$snapshot" sha) || return 1
  [[ $version == 1 ]] || return 1
  if [[ $kind == release ]]; then
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ ! -L $snapshot/images && -d $snapshot/images ]] || return 1
    for name in "${IMAGE_NAMES[@]}"; do
      [[ ! -L $snapshot/images/$name && -f $snapshot/images/$name ]] || return 1
      image_id=$(<"$snapshot/images/$name")
      [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
      docker image inspect "$image_id" >/dev/null 2>&1 || return 1
    done
  elif [[ $kind == absent ]]; then
    [[ $sha == none && ! -e $snapshot/images ]] || return 1
  else
    return 1
  fi
  (cd "$snapshot" && sha256sum --check --status SHA256SUMS) || return 1
  tar -tf "$snapshot/config.tar" >/dev/null || return 1
  tar -tf "$snapshot/state.tar" >/dev/null || return 1
  tar -tf "$snapshot/artifacts.tar" >/dev/null || return 1
}

record_release_config() {
  local staged="$state/release-config-next"
  [[ ! -L $config_root && -d $config_root ]] || return 1
  rm -rf -- "$staged"
  cp -a "$config_root" "$staged" || return 1
  rm -rf -- "$state/release-config-current"
  mv "$staged" "$state/release-config-current"
}
record_release_generation() {
  local sha=$1
  local staged="$state/.release-generation-staged.$$"
  local name reference image_id
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  rm -rf -- "$staged"
  install -d -m 0700 "$staged" "$staged/images" "$staged/config"
  printf '%s\n' "$sha" > "$staged/sha"
  cp -a "$config_root/." "$staged/config/" || return 1
  for name in "${IMAGE_NAMES[@]}"; do
    reference=$(image_reference "$name") || return 1
    image_id=$(docker image inspect "$reference" --format '{{.Id}}') || return 1
    printf '%s\n' "$image_id" > "$staged/images/$name"
    printf '%s\n' "$image_id" > "$state/release-${name}-image"
  done
  record_release_config || return 1
  rm -rf -- "$state/release-generation-current"
  mv "$staged" "$state/release-generation-current" || return 1
  printf '%s\n' "$sha" > "$state/release-current"
}


create_snapshot() {
  local snapshot=$1 prior_sha=$2 kind=absent name image_id config_source=$config_root
  [[ $snapshot == "$state/backups/"* && ! -e $snapshot ]] || return 1
  install -d -m 0700 "$snapshot"
  if [[ $prior_sha =~ ^[0-9a-f]{40}$ ]]; then
    if [[ -f $state/release-generation-current/sha ]]; then
      local gen_sha
      gen_sha=$(cat "$state/release-generation-current/sha" 2>/dev/null || true)
      [[ $gen_sha == "$prior_sha" ]] || return 1
    fi
    [[ ! -L $state/release-config-current && -d $state/release-config-current ]] || return 1
    config_source=$state/release-config-current
  fi
  tar -C "$config_source" -cf "$snapshot/config.tar" . || return 1
  tar -C "$state/state" -cf "$snapshot/state.tar" . || return 1
  tar -C "$state/artifacts" -cf "$snapshot/artifacts.tar" . || return 1
  if [[ $prior_sha =~ ^[0-9a-f]{40}$ ]]; then
    kind=release
    install -d -m 0700 "$snapshot/images"
    for name in "${IMAGE_NAMES[@]}"; do
      [[ -f $state/release-${name}-image ]] || return 1
      image_id=$(<"$state/release-${name}-image")
      [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
      docker image inspect "$image_id" >/dev/null 2>&1 || return 1
      printf '%s\n' "$image_id" > "$snapshot/images/$name"
    done
  else
    prior_sha=none
  fi
  printf 'version=1\nkind=%s\nsha=%s\n' "$kind" "$prior_sha" > "$snapshot/manifest"
  (
    cd "$snapshot"
    if [[ $kind == release ]]; then
      sha256sum manifest config.tar state.tar artifacts.tar images/* > SHA256SUMS
    else
      sha256sum manifest config.tar state.tar artifacts.tar > SHA256SUMS
    fi
  ) || return 1
  chmod -R go-rwx "$snapshot"
  validate_snapshot "$snapshot"
}

publish_rollback_snapshot() {
  local snapshot=$1 link="$state/.rollback-current.$$"
  validate_snapshot "$snapshot" || return 1
  ln -s "backups/$(basename "$snapshot")" "$link" || return 1
  mv -Tf "$link" "$state/rollback-current"
}

resolve_rollback_snapshot() {
  local link="$state/rollback-current" target
  [[ -L $link ]] || return 1
  target=$(readlink -f -- "$link") || return 1
  [[ $target == "$state/backups/"* ]] || return 1
  validate_snapshot "$target" || return 1
  printf '%s\n' "$target"
}

restore_tar_directory() {
  local archive=$1 root=$2 parent staged failed
  parent=$(dirname "$root")
  staged=$(mktemp -d "$parent/.cloud-harness-restore.XXXXXX") || return 1
  failed="$parent/.cloud-harness-failed.$$"
  [[ ! -e $failed ]] || { rm -rf -- "$staged"; return 1; }
  if ! tar -C "$staged" -xf "$archive"; then rm -rf -- "$staged"; return 1; fi
  if [[ -e $root ]] && ! mv "$root" "$failed"; then rm -rf -- "$staged"; return 1; fi
  if ! mv "$staged" "$root"; then
    [[ -e $failed ]] && mv "$failed" "$root" || true
    rm -rf -- "$staged"
    return 1
  fi
  rm -rf -- "$failed"
}

restore_snapshot() {
  local snapshot=$1
  local config_parent state_parent artifacts_parent
  local staged_config staged_state staged_artifacts
  validate_snapshot "$snapshot" || return 1
  config_parent=$(dirname "$config_root")
  state_parent=$(dirname "$state/state")
  artifacts_parent=$(dirname "$state/artifacts")
  staged_config=$(mktemp -d "$config_parent/.cloud-harness-restore-config.XXXXXX") || return 1
  staged_state=$(mktemp -d "$state_parent/.cloud-harness-restore-state.XXXXXX") || { rm -rf -- "$staged_config"; return 1; }
  staged_artifacts=$(mktemp -d "$artifacts_parent/.cloud-harness-restore-artifacts.XXXXXX") || { rm -rf -- "$staged_config" "$staged_state"; return 1; }

  if ! tar -C "$staged_config" -xf "$snapshot/config.tar" || \
     ! tar -C "$staged_state" -xf "$snapshot/state.tar" || \
     ! tar -C "$staged_artifacts" -xf "$snapshot/artifacts.tar"; then
    rm -rf -- "$staged_config" "$staged_state" "$staged_artifacts"
    return 1
  fi

  local failed_config="$config_parent/.cloud-harness-failed-config.$$"
  local failed_state="$state_parent/.cloud-harness-failed-state.$$"
  local failed_artifacts="$artifacts_parent/.cloud-harness-failed-artifacts.$$"

  local swap_failed=0
  if [[ -e $config_root ]] && ! mv "$config_root" "$failed_config"; then swap_failed=1; fi
  if [[ $swap_failed -eq 0 && -e $state/state ]] && ! mv "$state/state" "$failed_state"; then swap_failed=1; fi
  if [[ $swap_failed -eq 0 && -e $state/artifacts ]] && ! mv "$state/artifacts" "$failed_artifacts"; then swap_failed=1; fi

  if [[ $swap_failed -eq 0 ]] && \
     mv "$staged_config" "$config_root" && \
     mv "$staged_state" "$state/state" && \
     mv "$staged_artifacts" "$state/artifacts"; then
    rm -rf -- "$failed_config" "$failed_state" "$failed_artifacts"
    return 0
  fi

  [[ -e $failed_artifacts && ! -e $state/artifacts ]] && mv "$failed_artifacts" "$state/artifacts" || true
  [[ -e $failed_state && ! -e $state/state ]] && mv "$failed_state" "$state/state" || true
  [[ -e $failed_config && ! -e $config_root ]] && mv "$failed_config" "$config_root" || true
  rm -rf -- "$staged_config" "$staged_state" "$staged_artifacts" "$failed_config" "$failed_state" "$failed_artifacts"
  return 1
}

restore_snapshot_images() {
  local snapshot=$1 name image_id reference
  [[ $(snapshot_manifest_value "$snapshot" kind) == release ]] || return 1
  for name in "${IMAGE_NAMES[@]}"; do
    image_id=$(<"$snapshot/images/$name")
    reference=$(image_reference "$name") || return 1
    docker image tag "$image_id" "$reference" || return 1
  done
}

rollback_to_snapshot() {
  local snapshot=$1 kind sha restored_ingress
  validate_snapshot "$snapshot" || return 1
  kind=$(snapshot_manifest_value "$snapshot" kind) || return 1
  stop_release || return 1
  if [[ $kind == absent ]]; then
    contain_failed_release
    return $?
  fi
  sha=$(snapshot_manifest_value "$snapshot" sha) || return 1
  git checkout --detach --force "$sha" || return 1
  [[ -z $(git status --porcelain --untracked-files=all) ]] || return 1
  if [[ ${CLOUD_HARNESS_ROLLBACK_RELOAD_RUNTIME:-true} == true && -f deploy/scripts/release-runtime.sh ]]; then
    source deploy/scripts/release-runtime.sh
  fi
  install_release_service_files || return 1
  restore_snapshot "$snapshot" || return 1
  restore_snapshot_images "$snapshot" || return 1
  restored_ingress=$(resolve_ingress_mode "$config_root/ingress.conf") || return 1
  resolved_ingress_mode=$restored_ingress
  systemctl enable --now cloud-harness-mcp.service || return 1
  wait_ready || return 1
  verify_running_images || return 1
  run_release_canary "$restored_ingress" || return 1
  record_release_generation "$sha" || return 1
}

prune_release_backups() {
  local current canonical path kept=0
  current=$(readlink -f -- "$state/rollback-current") || return 1
  while IFS= read -r path; do
    canonical=$(readlink -f -- "$path") || return 1
    [[ $canonical == "$state/backups/"* ]] || return 1
    if [[ $canonical == "$current" ]]; then
      continue
    fi
    (( kept += 1 ))
    if (( kept > 5 )); then
      rm -rf -- "$canonical"
    fi
  done < <(find "$state/backups" -mindepth 1 -maxdepth 1 -type d -name 'cloud-harness-*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
}

rollback() {
  local exit_code=$? rollback_failed=0
  trap - ERR
  set +e
  if [[ -n ${backup_dir:-} ]]; then
    rollback_to_snapshot "$backup_dir" || rollback_failed=1
  elif [[ ${previous_sha:-} =~ ^[0-9a-f]{40}$ ]]; then
    systemctl enable --now cloud-harness-mcp.service || rollback_failed=1
    if [[ $rollback_failed -eq 0 ]]; then wait_ready || rollback_failed=1; fi
    if [[ $rollback_failed -eq 0 ]]; then run_release_canary "$resolved_ingress_mode" || rollback_failed=1; fi
  else
    contain_failed_release || rollback_failed=1
  fi
  if [[ $rollback_failed -ne 0 ]]; then
    contain_failed_release || true
    echo "deployment failed and rollback did not become healthy" >&2
    exit 70
  fi
  exit "$exit_code"
}

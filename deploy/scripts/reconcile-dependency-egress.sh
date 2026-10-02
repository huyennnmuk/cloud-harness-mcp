#!/usr/bin/env bash
set -euo pipefail

runtime_env=${1:-/etc/cloud-harness-mcp/runtime.env}
[[ ! -L $runtime_env && -f $runtime_env ]] || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: runtime configuration must be a regular non-symlink file" >&2; exit 1; }
size=$(stat -c '%s' -- "$runtime_env")
(( size <= 1048576 )) || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: runtime configuration is too large" >&2; exit 1; }

profile=''
assignments=0
while IFS= read -r line || [[ -n $line ]]; do
  if [[ $line == WORKSPACE_NETWORK_MODE=* ]]; then
    echo "DEPENDENCY_EGRESS_UNAVAILABLE: retired WORKSPACE_NETWORK_MODE is not accepted" >&2
    exit 1
  elif [[ $line == WORKSPACE_NETWORK_PROFILE=* ]]; then
    (( assignments += 1 ))
    profile=${line#*=}
  elif [[ $line == DEPENDENCY_NETWORK_NAME=* ]]; then
    val=${line#*=}
    [[ $val =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: invalid DEPENDENCY_NETWORK_NAME" >&2; exit 1; }
    export DEPENDENCY_NETWORK_NAME="${DEPENDENCY_NETWORK_NAME:-$val}"
  elif [[ $line == DEPENDENCY_BRIDGE_INTERFACE=* ]]; then
    val=${line#*=}
    [[ $val =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: invalid DEPENDENCY_BRIDGE_INTERFACE" >&2; exit 1; }
    export DEPENDENCY_BRIDGE_INTERFACE="${DEPENDENCY_BRIDGE_INTERFACE:-$val}"
  elif [[ $line == DEPENDENCY_BRIDGE_SUBNET=* ]]; then
    val=${line#*=}
    [[ $val =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: invalid DEPENDENCY_BRIDGE_SUBNET" >&2; exit 1; }
    export DEPENDENCY_BRIDGE_SUBNET="${DEPENDENCY_BRIDGE_SUBNET:-$val}"
  elif [[ $line == DEPENDENCY_DNS_RESOLVERS=* ]]; then
    val=${line#*=}
    [[ -n $val && $val != *$'\r'* ]] || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: invalid DEPENDENCY_DNS_RESOLVERS" >&2; exit 1; }
    export DEPENDENCY_DNS_RESOLVERS="${DEPENDENCY_DNS_RESOLVERS:-$val}"
  fi
done < "$runtime_env"

(( assignments == 1 )) || { echo "DEPENDENCY_EGRESS_UNAVAILABLE: WORKSPACE_NETWORK_PROFILE must occur exactly once" >&2; exit 1; }
case "$profile" in
  network-none)
    exit 0
    ;;
  dependency-access)
    helper=${CLOUD_HARNESS_FIREWALL_HELPER:-/usr/local/sbin/cloud-harness-setup-dependency-firewall}
    if [[ ! -x $helper && -z ${CLOUD_HARNESS_FIREWALL_HELPER:-} ]]; then
      helper=deploy/scripts/setup-dependency-firewall.sh
    fi
    if ! "$helper"; then
      echo "DEPENDENCY_EGRESS_UNAVAILABLE: dependency firewall reconciliation or attestation failed" >&2
      exit 1
    fi
    ;;
  *)
    echo "DEPENDENCY_EGRESS_UNAVAILABLE: unsupported WORKSPACE_NETWORK_PROFILE" >&2
    exit 1
    ;;
esac

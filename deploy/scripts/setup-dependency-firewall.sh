#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BRIDGE_NAME="${DEPENDENCY_NETWORK_NAME:-cloud-harness-dependency-access}"
BRIDGE_IF="${DEPENDENCY_BRIDGE_INTERFACE:-chm-egress0}"
SUBNET="${DEPENDENCY_BRIDGE_SUBNET:-172.30.240.0/24}"
DNS_SOURCE="${DEPENDENCY_DNS_RESOLVERS:-8.8.8.8,1.1.1.1}"
VERSION=v1
INPUT_CHAIN="CHM-INPUT-$VERSION"
EGRESS_CHAIN="CHM-EGRESS-$VERSION"
NAT_CHAIN="CHM-NAT-$VERSION"

[[ $BRIDGE_NAME =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || { echo "ERROR: invalid dependency network name" >&2; exit 1; }
[[ $BRIDGE_IF =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$ ]] || { echo "ERROR: invalid dependency bridge interface" >&2; exit 1; }
[[ $SUBNET =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "ERROR: invalid dependency bridge subnet" >&2; exit 1; }
IFS=', ' read -r -a DNS_RESOLVERS <<< "$DNS_SOURCE"
(( ${#DNS_RESOLVERS[@]} > 0 )) || { echo "ERROR: at least one DNS resolver is required" >&2; exit 1; }
for resolver in "${DNS_RESOLVERS[@]}"; do
  [[ $resolver =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "ERROR: invalid DNS resolver" >&2; exit 1; }
done

SUDO=()
if [[ $(id -u) -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || { echo "ERROR: root privileges are required" >&2; exit 1; }
  SUDO=(sudo)
fi

work=$(mktemp -d /tmp/chm-firewall.XXXXXX)
chmod 0700 "$work"
network_created=0
cleanup_files() { rm -rf -- "$work"; }
trap cleanup_files EXIT

save_managed_policy() {
  "${SUDO[@]}" iptables-save -t filter > "$work/raw.filter"
  grep -E "^(:($INPUT_CHAIN|$EGRESS_CHAIN) |\-A ($INPUT_CHAIN|$EGRESS_CHAIN) |\-A (INPUT|DOCKER-USER) .*\-j ($INPUT_CHAIN|$EGRESS_CHAIN)( |$))" "$work/raw.filter" > "$work/before.filter" || true
  "${SUDO[@]}" iptables-save -t nat > "$work/raw.nat"
  grep -E "^(:$NAT_CHAIN |\-A $NAT_CHAIN |\-A POSTROUTING .*\-j $NAT_CHAIN( |$))" "$work/raw.nat" > "$work/before.nat" || true
}

remove_target_jumps() {
  local table=$1 chain=$2 target=$3 line
  local -a parts ipt=("${SUDO[@]}" iptables -w 10)
  [[ -z $table ]] || ipt+=(-t "$table")
  while IFS= read -r line; do
    [[ $line == "-A $chain "* && $line == *" -j $target"* ]] || continue
    read -r -a parts <<< "$line"
    "${ipt[@]}" -D "$chain" "${parts[@]:2}" || true
  done < <("${ipt[@]}" -S "$chain" 2>/dev/null || true)
}

cleanup_managed_policy() {
  remove_target_jumps '' INPUT "$INPUT_CHAIN"
  remove_target_jumps '' DOCKER-USER "$EGRESS_CHAIN"
  remove_target_jumps nat POSTROUTING "$NAT_CHAIN"
  "${SUDO[@]}" iptables -w 10 -F "$INPUT_CHAIN" 2>/dev/null || true
  "${SUDO[@]}" iptables -w 10 -X "$INPUT_CHAIN" 2>/dev/null || true
  "${SUDO[@]}" iptables -w 10 -F "$EGRESS_CHAIN" 2>/dev/null || true
  "${SUDO[@]}" iptables -w 10 -X "$EGRESS_CHAIN" 2>/dev/null || true
  "${SUDO[@]}" iptables -w 10 -t nat -F "$NAT_CHAIN" 2>/dev/null || true
  "${SUDO[@]}" iptables -w 10 -t nat -X "$NAT_CHAIN" 2>/dev/null || true
}

build_restore_payload() {
  local filter=$1 nat=$2
  {
    echo '*filter'
    echo ":$INPUT_CHAIN - [0:0]"
    echo ":$EGRESS_CHAIN - [0:0]"
    echo "-A $INPUT_CHAIN -j REJECT --reject-with icmp-port-unreachable"
    echo "-A $EGRESS_CHAIN -m conntrack --ctstate ESTABLISHED -j ACCEPT"
    echo "-A $EGRESS_CHAIN -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited"
    echo "-A $EGRESS_CHAIN -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited"
    for resolver in "${DNS_RESOLVERS[@]}"; do
      echo "-A $EGRESS_CHAIN -p udp -d $resolver --dport 53 -j ACCEPT"
      echo "-A $EGRESS_CHAIN -p tcp -d $resolver --dport 53 -j ACCEPT"
    done
    echo "-A $EGRESS_CHAIN -p tcp --dport 80 -j ACCEPT"
    echo "-A $EGRESS_CHAIN -p tcp --dport 443 -j ACCEPT"
    echo "-A $EGRESS_CHAIN -j REJECT --reject-with icmp-port-unreachable"
    echo COMMIT
  } > "$filter"
  {
    echo '*nat'
    echo ":$NAT_CHAIN - [0:0]"
    echo "-A $NAT_CHAIN -p tcp -m multiport --dports 80,443 -j MASQUERADE"
    for resolver in "${DNS_RESOLVERS[@]}"; do
      echo "-A $NAT_CHAIN -p udp -d $resolver --dport 53 -j MASQUERADE"
      echo "-A $NAT_CHAIN -p tcp -d $resolver --dport 53 -j MASQUERADE"
    done
    echo COMMIT
  } > "$nat"
}

restore_prior_policy() {
  local source line table chain target failed=0
  local -a parts
  trap - ERR
  cleanup_managed_policy
  for table in filter nat; do
    source="$work/before.$table"
    [[ -s $source ]] || continue
    {
      echo "*$table"
      grep -E '^:' "$source" || true
      grep -E "^-A ($INPUT_CHAIN|$EGRESS_CHAIN|$NAT_CHAIN) " "$source" || true
      echo COMMIT
    } > "$work/restore.$table"
    if ! "${SUDO[@]}" iptables-restore -w 10 -n --test < "$work/restore.$table"; then
      failed=1
      continue
    fi
    if ! "${SUDO[@]}" iptables-restore -w 10 --noflush < "$work/restore.$table"; then
      failed=1
      continue
    fi
    while IFS= read -r line; do
      [[ $line == '-A INPUT '* || $line == '-A DOCKER-USER '* || $line == '-A POSTROUTING '* ]] || continue
      read -r -a parts <<< "$line"
      chain=${parts[1]}
      target=${parts[${#parts[@]}-1]}
      if [[ $target == "$NAT_CHAIN" ]]; then
        "${SUDO[@]}" iptables -w 10 -t nat -I "$chain" 1 "${parts[@]:2}" || failed=1
      else
        "${SUDO[@]}" iptables -w 10 -I "$chain" 1 "${parts[@]:2}" || failed=1
      fi
    done < "$source"
  done
  if (( network_created )) && ! docker network rm "$BRIDGE_NAME" >/dev/null 2>&1; then failed=1; fi
  return "$failed"
}

on_error() {
  local status=$?
  if restore_prior_policy; then
    echo "ERROR: dependency egress policy reconciliation failed; prior managed policy restored" >&2
  else
    echo "ERROR: dependency egress policy reconciliation failed; prior managed policy restoration was incomplete" >&2
  fi
  exit "$status"
}
trap on_error ERR

save_managed_policy
build_restore_payload "$work/desired.filter" "$work/desired.nat"
"${SUDO[@]}" iptables-restore -w 10 -n --test < "$work/desired.filter"
"${SUDO[@]}" iptables-restore -w 10 -n --test < "$work/desired.nat"

if ! docker network inspect "$BRIDGE_NAME" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --opt "com.docker.network.bridge.name=$BRIDGE_IF" \
    --opt "com.docker.network.bridge.enable_icc=false" \
    --opt "com.docker.network.bridge.enable_ip_masquerade=false" \
    --subnet "$SUBNET" \
    --ipv6=false \
    --label "cloud-harness.managed=true" \
    --label "cloud-harness.network-profile=dependency-access" \
    "$BRIDGE_NAME" >/dev/null
  network_created=1
fi

cleanup_managed_policy
"${SUDO[@]}" iptables-restore -w 10 --noflush < "$work/desired.filter"
"${SUDO[@]}" iptables-restore -w 10 --noflush < "$work/desired.nat"
"${SUDO[@]}" iptables -w 10 -I INPUT 1 -i "$BRIDGE_IF" -j "$INPUT_CHAIN"
"${SUDO[@]}" iptables -w 10 -I DOCKER-USER 1 -i "$BRIDGE_IF" -j "$EGRESS_CHAIN"
"${SUDO[@]}" iptables -w 10 -t nat -I POSTROUTING 1 -s "$SUBNET" -j "$NAT_CHAIN"

network_shape=$(docker network inspect "$BRIDGE_NAME" --format '{{.Driver}}|{{.EnableIPv6}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}|{{(index .IPAM.Config 0).Subnet}}|{{index .Labels "cloud-harness.managed"}}|{{index .Labels "cloud-harness.network-profile"}}')
[[ $network_shape == "bridge|false|$BRIDGE_IF|false|false|$SUBNET|true|dependency-access" ]]
first_input=$("${SUDO[@]}" iptables -w 10 -S INPUT | grep '^-A ' | { IFS= read -r line; printf '%s' "$line"; })
first_egress=$("${SUDO[@]}" iptables -w 10 -S DOCKER-USER | grep '^-A ' | { IFS= read -r line; printf '%s' "$line"; })
first_nat=$("${SUDO[@]}" iptables -w 10 -t nat -S POSTROUTING | grep '^-A ' | { IFS= read -r line; printf '%s' "$line"; })
[[ $first_input == "-A INPUT -i $BRIDGE_IF -j $INPUT_CHAIN" ]]
[[ $first_egress == "-A DOCKER-USER -i $BRIDGE_IF -j $EGRESS_CHAIN" ]]
[[ $first_nat == "-A POSTROUTING -s $SUBNET -j $NAT_CHAIN" ]]
"${SUDO[@]}" iptables -w 10 -S "$INPUT_CHAIN" > "$work/actual.input"
"${SUDO[@]}" iptables -w 10 -S "$EGRESS_CHAIN" > "$work/actual.egress"
"${SUDO[@]}" iptables -w 10 -t nat -S "$NAT_CHAIN" > "$work/actual.nat"
grep -E "^(:$INPUT_CHAIN |\-A $INPUT_CHAIN )" "$work/desired.filter" | sed "s/^:$INPUT_CHAIN - \[0:0\]$/-N $INPUT_CHAIN/" > "$work/expected.input"
grep -E "^(:$EGRESS_CHAIN |\-A $EGRESS_CHAIN )" "$work/desired.filter" | sed "s/^:$EGRESS_CHAIN - \[0:0\]$/-N $EGRESS_CHAIN/" > "$work/expected.egress"
grep -E "^(:$NAT_CHAIN |\-A $NAT_CHAIN )" "$work/desired.nat" | sed "s/^:$NAT_CHAIN - \[0:0\]$/-N $NAT_CHAIN/" > "$work/expected.nat"
cmp -s "$work/actual.input" "$work/expected.input"
cmp -s "$work/actual.egress" "$work/expected.egress"
cmp -s "$work/actual.nat" "$work/expected.nat"

trap - ERR
echo "cloud-harness-dependency-firewall: reconciled and attested IPv4 policy"

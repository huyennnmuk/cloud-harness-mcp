---
phase: 1
title: "Repository release and ingress readiness"
status: completed
priority: P1
effort: "10h"
dependencies: []
---

# Phase 1: Repository release and ingress readiness

## Goal

Produce one merged release SHA that can be installed on a fresh host without
leaking Tunnel credentials, requiring pre-provisioned model-provider secrets,
losing dependency-egress policy after reboot, or making same-SHA configuration
rollback impossible.

## Context Links

- [Plan](./plan.md)
- [Ingress research](./reports/ingress-research.md)
- [Advisory decision](./reports/advisory-decision.md)
- [Red-team adjudication](./reports/red-team-adjudication.md)
- [`scripts/install.sh`](../../scripts/install.sh)
- [`deploy/scripts/deploy-release.sh`](../../deploy/scripts/deploy-release.sh)
- [`deploy/scripts/release-runtime.sh`](../../deploy/scripts/release-runtime.sh)
- [`deploy/scripts/service-compose.sh`](../../deploy/scripts/service-compose.sh)
- [`deploy/scripts/setup-dependency-firewall.sh`](../../deploy/scripts/setup-dependency-firewall.sh)

## Requirements

- Missing `ingress.conf` preserves legacy managed-nginx behavior. Explicit
  `tunnel`, `caddy`, and `custom` modes never invoke the nginx upgrader.
- Ingress, release SHA, rollback prerequisites, and non-secret config structure
  are validated before `stop_release`.
- Tunnel credentials never appear in Compose interpolation, environment,
  command arguments, generated config output, test output, or process metadata.
- `cloudflared` is pinned to a reviewed immutable digest.
- A fresh deployment starts Model Gateway with an empty dynamic snapshot; no
  fake provider key or static profile is required.
- Installer validates and checks out the exact merged SHA before copying or
  executing repository-owned deployment files.
- Dependency-egress policy is reconciled and attested before every service start
  when selected, including after reboot.
- Every deployment records an immutable pre-mutation rollback target, even when
  the target SHA equals the current SHA.
- Tests execute behavior and inspect generated artifacts. Do not add source-text
  assertions.

## Architecture

- `/etc/cloud-harness-mcp/ingress.conf` selects ingress ownership.
- `/etc/cloud-harness-mcp/cloudflare-tunnel-token` is a direct bind-mounted
  credential consumed through `cloudflared --token-file`; `tunnel.env` is
  retired.
- Model Gateway starts with `MODEL_GATEWAY_DYNAMIC_MODE=true`. The runner sends
  encrypted dashboard-managed provider credentials and active profiles over the
  existing Docker control channel only after an operator creates them.
- `/var/lib/cloud-harness/rollback-current/` is an immutable snapshot of the
  last healthy pre-deploy state: exact SHA, configuration, database, artifacts,
  and image IDs. Manual rollback restores this snapshot directly rather than
  deriving a target from `release-previous`.
- A systemd pre-start helper applies or verifies dependency-egress policy from
  `runtime.env`; it exits without mutation for `network-none`.

## Files to Create / Modify

- `scripts/install.sh`
- `compose.yaml`
- `compose.production.yaml`
- `deploy/cloudflare-tunnel/compose.tunnel.yaml`
- `deploy/scripts/service-compose.sh`
- `deploy/scripts/release-runtime.sh`
- `deploy/scripts/deploy-release.sh`
- `deploy/scripts/rollback-release.sh`
- `deploy/scripts/setup-dependency-firewall.sh`
- `deploy/systemd/cloud-harness-mcp.service`
- Focused tests under `test/` plus existing model-gateway tests
- `scripts/verify-compose-boundaries.mjs`
- Internal and official deployment/configuration docs affected by these contracts

## Tasks & Steps

### Task 1.1 — Make ingress resolution fail before mutation

- **Goal:** External ingress uses the normal canary/rollback path without
  repository-owned nginx changes.
- **Steps:**
  1. Add a strict `resolve_ingress_mode <path>` parser in
     `release-runtime.sh`. A missing file resolves to `legacy-managed-nginx`.
     Accept one non-comment assignment only:
     `INGRESS_MODE=tunnel|caddy|custom`; reject duplicates, unknown keys,
     executable shell, malformed lines, and symlinks.
  2. Add `prepare_access_ingress <mode>`. Invoke the canonical nginx upgrader
     only for `legacy-managed-nginx`; return without nginx mutation for the
     three explicit external modes.
  3. Resolve and validate ingress before backup creation or `stop_release` in
     `deploy-release.sh`.
  4. Keep owner-bearer and Access canaries mandatory; ingress mode changes only
     transport ownership.
- **Success criteria:** Malformed ingress exits before any stop/build/backup
  trace. Tunnel mode reaches the Access canary without invoking nginx tooling.
- **Verify:** `npm test -- test/deploy-release-runtime.test.ts` exits 0 with
  behavioral cases for missing-file legacy, each explicit mode, malformed
  pre-mutation failure, canary execution, and automatic rollback.

### Task 1.2 — Replace Tunnel token interpolation with a token file

- **Goal:** No diagnostic or process surface contains the Tunnel credential.
- **Steps:**
  1. Add installer support for `--tunnel-token-file <absolute-path>` and the
     existing TTY secret prompt. Reject symlinks, non-regular files, multiline
     values, and token input through ordinary command arguments. Deprecate and
     remove `--tunnel-token` from docs and generated examples.
  2. Install the token as
     `/etc/cloud-harness-mcp/cloudflare-tunnel-token`, owned by root with the
     minimum group-read permission required by the non-root cloudflared UID/GID;
     keep the parent directory `0700` and never print the value.
  3. Change Tunnel Compose to a list-form command using
     `--token-file /run/secrets/cloudflare-tunnel-token` and a direct read-only
     file mount. Remove `CLOUDFLARE_TUNNEL_TOKEN` interpolation.
  4. Remove `tunnel.env` sourcing/export from both Compose wrappers. Fail closed
     when the exact token file is absent or has unsafe type/permissions.
  5. Pin `cloudflare/cloudflared` by reviewed version and digest. Document one
     explicit digest-update procedure; never use `latest`.
  6. Replace full `docker compose config` capture with a narrow, streamed
     non-secret projection of service names, published ports, networks, mounts,
     image references, and command flags with credential values structurally
     absent.
- **Success criteria:** The token exists only in the protected source file and
  cloudflared memory. Compose config, container command, environment, logs, and
  `/proc/*/cmdline` contain no token.
- **Verify:** Focused Tunnel lifecycle tests execute the wrapper with a
  disposable token, assert file permissions and non-secret resolved config,
  then search exact test-token bytes in captured stdout/stderr and container
  inspect output; zero matches. `npm run verify:compose` exits 0.

### Task 1.3 — Make fresh Model Gateway startup secret-free

- **Goal:** A new install is healthy before any model provider is configured.
- **Steps:**
  1. Set `MODEL_GATEWAY_DYNAMIC_MODE=true` for the production model-gateway
     service and remove static production profile/credential bind mounts.
  2. Do not create placeholder profiles or fake provider keys.
  3. Preserve the existing runner-to-gateway `apply_snapshot` control path.
     Startup with zero active profiles and zero credentials is healthy; agent
     launch requiring a profile remains unavailable until an operator creates
     and activates one.
  4. Keep test-only static profiles isolated under the test service.
  5. Extend Compose boundary verification so only Model Gateway can receive
     dynamic provider credentials and executors never receive them.
- **Success criteria:** Fresh production Compose reaches healthy state with an
  empty gateway digest; creating an encrypted profile later synchronizes it
  without restart.
- **Verify:** Run focused model-gateway dynamic-control tests, the production
  Compose config boundary test, and a throwaway production-config smoke that
  starts Model Gateway with no host profile/key files and observes `/healthz`
  plus digest counts of zero.

### Task 1.4 — Pin installer execution to the reviewed release

- **Goal:** Every installed script, unit, Compose file, and image source comes
  from the exact accepted SHA.
- **Steps:**
  1. Validate `RELEASE_SHA` as 40 lowercase hex characters before repository
     mutation. Resolve `origin/main` only when no SHA was supplied.
  2. Fetch the exact candidate, verify it is an ancestor of `origin/main`, then
     `git checkout --detach --force "$RELEASE_SHA"` and require a clean tree
     before `bootstrap_secrets`, ingress configuration, tool installation, or
     first deploy.
  3. Ensure first deployment receives the same immutable SHA.
  4. Keep the rollout route local-checkout based. Do not use curl-to-shell for
     production. Add behavioral tests proving non-interactive mode fails when a
     required secret file is absent and TTY/file input does not enter argv.
  5. Stop printing owner bearer credentials in installer success output. Store
     any temporary owner client config only in a root `0600` file and print its
     path, not its contents.
  6. Emit `WORKSPACE_NETWORK_PROFILE=network-none`; never emit retired
     `WORKSPACE_NETWORK_MODE`.
- **Success criteria:** A deliberately different checkout cannot install files
  from `origin/main` while claiming another SHA; generated runtime config is
  valid, idempotent, and secret-safe.
- **Verify:** `npm test -- test/installer-runtime-env.test.ts` and the installer
  behavior suite exit 0. Tests inspect installed fixture hashes against the
  selected commit and assert no disposable secret appears in output.

### Task 1.5 — Reconcile dependency-egress policy on boot

- **Goal:** Reboot cannot silently remove the firewall while leaving workspaces
  configured for dependency access.
- **Steps:**
  1. Make `setup-dependency-firewall.sh` idempotent and explicit about its real
     guarantee: per-family restore input is validated first; prior rules are
     restored on any failed apply/attestation. Do not call the combined IPv4 and
     IPv6 operation globally atomic.
  2. Add a root-owned pre-start wrapper that reads only
     `WORKSPACE_NETWORK_PROFILE` from `runtime.env`. For `dependency-access`,
     create/inspect the managed bridge, apply policy, and attest exact jump/NAT
     rules. For `network-none`, exit without creating the bridge.
  3. Install that wrapper from the pinned release and call it through systemd
     `ExecStartPre` before Compose startup.
  4. Fail service startup with `DEPENDENCY_EGRESS_UNAVAILABLE` semantics when
     reconciliation or attestation fails; never downgrade to unrestricted
     bridge or `network-none` silently.
  5. Add tests for first boot, repeat start, reboot-equivalent empty iptables
     state, failed apply restoration, and network-none no-op.
- **Success criteria:** Clearing only managed test rules and starting the service
  recreates and attests them before the runner becomes ready; failed policy
  leaves no partially accepted dependency-access state.
- **Verify:** Run the focused shell fixture suite and syntax checks owned by CI.
  On a disposable Docker-capable host, perform a reboot-equivalent service
  restart after removing managed rules and observe successful re-attestation.

### Task 1.6 — Support coherent same-SHA rollback

- **Goal:** Every successful configuration promotion has a supported previous
  state, independent of whether source SHA changed.
- **Steps:**
  1. Before `stop_release`, validate the candidate SHA, ingress, required files,
     and rollback storage. After stop and before any new checkout/build/config
     promotion, create one immutable snapshot under `backups/` containing:
     current SHA, exact config tree, database, artifact archive, and all recorded
     image IDs.
  2. Atomically publish that complete directory as `rollback-current`; never
     overwrite it with the new configuration after success.
  3. Keep automatic rollback bound to the deployment's newly created snapshot.
     Restore config/state/artifacts before starting the previous release, then
     verify readiness, exact images, and the canary appropriate to the restored
     auth mode.
  4. Replace `rollback-release.sh`'s `release-previous` lookup with strict
     snapshot validation and direct restoration. It must work when previous and
     current SHA are equal.
  5. If restore verification fails, contain the release by stopping/disabling
     the service; never continue with mixed config/state/images.
  6. Add a retention rule that preserves `rollback-current` and a bounded number
     of older backups; cleanup is exact-path only.
- **Success criteria:** owner-bearer → Access promotion at the same SHA can be
  manually rolled back to the owner-bearer config and state. Access canary
  failure automatically restores the same snapshot. A failed restore leaves the
  service contained.
- **Verify:** Extend `test/deploy-release-runtime.test.ts` with same-SHA manual
  rollback, failed canary, restore-order, corrupt snapshot, and containment
  cases. Assert exact traces, not implementation text.

### Task 1.7 — Update contracts, docs, and release gates

- **Goal:** Operators and future releases use only the repaired paths.
- **Steps:**
  1. Update internal deployment, configuration, operations, security, and
     troubleshooting owners for ingress selection, token-file storage, dynamic
     Model Gateway, pre-start firewall, same-SHA rollback, and credential
     retirement.
  2. Update matching official docs-site installation/self-host guidance. Run
     generated reference synchronization only if environment/tool contracts
     changed.
  3. Update `.env.example` only for changed public configuration keys; do not
     duplicate generated inventories in prose.
  4. Run shell syntax checks from `.github/workflows/ci.yml`, all focused tests,
     `npm run verify:compose`, `npm run verify`, `npm run docs:build`, and
     `npm run docs:links`.
  5. Review and merge normally. Record the exact 40-character merged SHA and
     prove it is an ancestor of `origin/main`.
- **Success criteria:** All gates exit 0; docs describe one consistent lifecycle;
  no touched source-text test remains; release SHA is merged.
- **Verify:** `git merge-base --is-ancestor "$RELEASE_SHA" origin/main` exits 0
  and `printf '%s' "$RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$'` exits 0.

## Todo

- [x] Task 1.1 — Make ingress resolution fail before mutation.
- [x] Task 1.2 — Replace Tunnel token interpolation with a token file.
- [x] Task 1.3 — Make fresh Model Gateway startup secret-free.
- [x] Task 1.4 — Pin installer execution to the reviewed release.
- [x] Task 1.5 — Reconcile dependency-egress policy on boot.
- [x] Task 1.6 — Support coherent same-SHA rollback.
- [x] Task 1.7 — Update contracts, docs, and release gates.

## Risk Assessment

- Same-SHA rollback changes the release-state contract. Test restore ordering and
  containment before touching production.
- Token-file readability must be proven for the non-root cloudflared identity
  without widening host access.
- Dynamic Model Gateway must remain fail-closed for agent launch when no profile
  exists; service health alone must not imply model availability.
- Firewall reconciliation runs with host authority. Scope every rule to the
  managed bridge and restore prior rules on failure.

## Security Considerations

Never put real credentials in tests, command arguments, Compose interpolation,
process metadata, logs, reports, or source control. Use disposable sentinel
values and assert their absence from every captured output surface.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
change made, failing command, and full output. Apply its guidance and rerun the
same gate. If `kongming` is unavailable, report the evidence and do not continue.

---
phase: 3
title: "Owner-bearer Tunnel install"
status: completed
priority: P1
effort: "2h"
dependencies: [2]
---

# Phase 3: Owner-bearer Tunnel install

## Goal

Install the reviewed release through Cloudflare Tunnel in temporary
owner-bearer mode, enable reboot-safe dependency egress, and prove existing
CloudPanel sites remain unchanged before authentication cutover.

## Context Links

- [Plan](./plan.md)
- [Phase 1](./phase-01-repository-ingress-readiness.md)
- [Phase 2](./phase-02-production-preflight-and-cloudflare-control-plane.md)
- [`scripts/install.sh`](../../scripts/install.sh)
- [`docs/deployment.md`](../../docs/deployment.md)

## Requirements

- Exact Phase 1 SHA is merged and recorded.
- Tunnel/Access resources and independent recovery from Phase 2 are ready.
- Tunnel token is available as a secure local file, not a command argument.
- Baseline nginx hash, listener map, aggregate capacity, and site latency pass.
- No `bootstrap-vps.sh`, Certbot, CloudPanel site, or MCP nginx vhost is used.
- No model-provider profile or API key is needed for first startup.

## Architecture

The installer runs from the reviewed local checkout with `--ingress tunnel` and
a token-file input. `cloudflared` joins only Docker's `ingress` network and
reads the token from a direct read-only mount. Model Gateway starts dynamically
with no profiles. Workspaces remain `network-none` until the host firewall is
applied, attested, and wired into systemd pre-start.

## Files / Resources to Create or Modify

- `/opt/cloud-harness-mcp/repo` — detached exact release checkout
- `/etc/cloud-harness-mcp/runtime.env` — root `0600`
- `/etc/cloud-harness-mcp/secret-keyring.json` — root `0600`
- `/etc/cloud-harness-mcp/ingress.conf` — `INGRESS_MODE=tunnel`
- `/etc/cloud-harness-mcp/cloudflare-tunnel-token` — protected token file
- `/var/lib/cloud-harness/` — state, jobs, artifacts, backups, rollback snapshot
- Host managed dependency-egress rules through the pinned pre-start helper
- Sanitized rollout evidence

## Tasks & Steps

### Task 3.1 — Transfer inputs and run the pinned installer

- **Goal:** Start the exact reviewed release without leaking credentials or
  touching nginx.
- **Steps:**
  1. Enter the maintenance window with Hostinger console and SSH open.
  2. Clone/fetch the repository, verify the origin, set `RELEASE_SHA` to the
     Phase 1 commit, prove ancestry, and check it out detached and clean.
  3. Transfer the Tunnel token file over SFTP/SCP to a root-readable temporary
     path. Do not paste it into the shell or pass it as an argument.
  4. Run the local installer with exact non-secret flags and the secure file
     path:
     ```bash
     sudo ./scripts/install.sh \
       --ingress tunnel \
       --domain mcp.codepod.site \
       --release-sha "$RELEASE_SHA" \
       --tunnel-token-file /root/cloudflare-tunnel-token.input \
       --non-interactive
     ```
  5. Remove the temporary input after installer success. Verify only owner,
     mode, type, and path of installed secrets; never display contents.
  6. Confirm runtime has one `AUTH_MODE=owner-bearer`, one
     `WORKSPACE_NETWORK_PROFILE=network-none`, one
     `MAX_ACTIVE_WORKSPACES_PER_OWNER=1`, and no retired network key.
  7. Confirm no `/etc/cloud-harness-model-gateway` profile/key prerequisite was
     created and Model Gateway reports healthy with zero active profiles.
- **Success criteria:** Systemd and production Compose are healthy; installer
  copied files from the exact SHA; no secret appears in stdout/stderr; nginx is
  unchanged.
- **Verify:** `cloudharness status`, `systemctl is-active`, exact SHA/clean-tree
  checks, permission checks, dynamic gateway digest, and the nginx hash all
  pass. Search captured installer output for the disposable secret fingerprint;
  zero matches.

### Task 3.2 — Verify Tunnel boundary without rendering secret config

- **Goal:** Prove the running container topology and credential isolation.
- **Steps:**
  1. Use a narrow non-secret Compose projection; do not redirect full
     `docker compose config` output to `/tmp`.
  2. Confirm `cloudflared` image equals the reviewed digest, command uses
     `--token-file`, environment has no Tunnel token, no ports are published,
     and only the `ingress` network is attached.
  3. Confirm the token mount is read-only and no other service mounts it.
  4. Confirm host port 3100 listens only on `127.0.0.1`; API and runner publish
     no host ports.
  5. Inspect container command/environment and bounded logs for the exact test
     fingerprint or known token hash only; never print the actual token.
  6. Confirm Cloudflare reports the Tunnel healthy and unauthenticated public
     requests terminate at Access rather than CloudPanel.
- **Success criteria:** Credential is absent from argv/env/logs/config output;
  container topology matches the security boundary; Tunnel is healthy.
- **Verify:** Stream the narrow projection directly into assertions. Use
  `docker inspect --format` for `Config.User`, `Config.Cmd`, mounts, networks,
  and published ports. Do not assert nonexistent Compose fields.

### Task 3.3 — Enable and attest dependency access

- **Goal:** Enable bounded package access only after firewall policy is durable.
- **Steps:**
  1. Run the pinned dependency-firewall helper once and require its post-apply
     attestation.
  2. Use `sudoedit` to change only
     `WORKSPACE_NETWORK_PROFILE=network-none` to `dependency-access`; retain the
     single global rollout procedure and per-owner limit of one.
  3. Redeploy the same `RELEASE_SHA`. Require creation of a pre-mutation
     rollback snapshot before the change and the normal owner-bearer canary.
  4. Stop the service, remove only the managed test firewall rules using the
     fixture/recovery route defined in Phase 1, then start systemd. Require
     `ExecStartPre` to recreate and attest policy before readiness. This is the
     reboot-equivalent check; perform an actual reboot only inside the approved
     maintenance window if the owner chooses it.
  5. Open one disposable public repository workspace, prove allowed DNS/HTTPS
     package access and blocked non-allowlisted egress, then close it.
- **Success criteria:** Same-SHA deploy and rollback snapshot succeed; policy is
  restored on service start; dependency access is fail-closed; workspace closes.
- **Verify:** Exact runtime key counts, firewall attestation output, systemd
  pre-start status, allowed/blocked network probes, and workspace terminal state
  all pass.

### Task 3.4 — Prove same-SHA manual rollback before Access

- **Goal:** Demonstrate the repaired rollback path on production while the
  simpler owner-bearer mode is still active.
- **Steps:**
  1. Record the non-secret rollback snapshot identifier and current config hash.
  2. Make a reversible non-secret runtime change allowed by schema, redeploy the
     same SHA, and confirm a new `rollback-current` points to the prior healthy
     state.
  3. Invoke `/usr/local/sbin/cloud-harness-rollback`.
  4. Confirm prior runtime config hash, release SHA, database/artifact integrity,
     exact images, readiness, and owner-bearer canary.
  5. Redeploy the intended dependency-access config and require a fresh rollback
     snapshot before proceeding.
- **Success criteria:** Manual rollback succeeds even though both states use the
  same SHA; no mixed state remains.
- **Verify:** Compare pre/post hashes and recorded snapshot metadata without
  printing secret file contents. The rollback command and final redeploy exit 0.

### Task 3.5 — Recheck shared-host and no-touch gates

- **Goal:** Block Access cutover if installation affected existing workloads.
- **Steps:**
  1. Recompute the root-only `nginx -T` hash and compare with baseline.
  2. Re-probe all existing sites five times and compare status plus latency with
     Phase 2 thresholds.
  3. Record memory, disk, load, Docker disk use, container limits, and OOM events.
  4. Confirm no unexpected executor/workspace remains and no process owns a new
     public host listener.
  5. On any regression, stop/disable only Cloud Harness and use the proven local
     rollback; never prune Docker broadly or modify CloudPanel sites.
- **Success criteria:** Nginx hash is identical, sites stay within thresholds,
  at least 4 GiB memory and 40 GiB disk remain, no OOM occurred, and no orphan
  execution resource exists.
- **Verify:** All status-only probes and threshold commands exit 0. Listener and
  container inventory matches the accepted architecture.

## Todo

- [x] Task 3.1 — Transfer inputs and run the pinned installer.
- [x] Task 3.2 — Verify Tunnel boundary without rendering secret config.
- [x] Task 3.3 — Enable and attest dependency access.
- [x] Task 3.4 — Prove same-SHA manual rollback before Access.
- [x] Task 3.5 — Recheck shared-host and no-touch gates.

## Risk Assessment

- Image builds can saturate two CPUs despite container limits. Existing-site
  latency/status is the decisive gate.
- A temporary token upload is still a secret copy. Delete the exact upload after
  verifying the installed file and record deletion without exposing the path's
  contents.
- Local owner-bearer rollback does not make ChatGPT available through Access;
  it restores a healthy local service while Access mode is repaired.

## Security Considerations

Never run full resolved-config dumps, `env`, shell tracing, raw secret reads, or
commands that put tokens in argv. Verify fingerprints/hashes and structural
absence instead.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
failed command, output, and expected condition. Apply guidance and rerun. If
unavailable, report evidence and do not continue.

---
phase: 4
title: "Cloudflare Access cutover"
status: completed
priority: P1
effort: "2h"
dependencies: [3]
---

# Phase 4: Cloudflare Access cutover

## Goal

Promote the healthy Tunnel installation from temporary owner-bearer auth to
Cloudflare Access Managed OAuth, with a proven same-SHA local rollback target
and an explicit external Cloudflare recovery path.

## Context Links

- [Plan](./plan.md)
- [Official ChatGPT guide](https://docs.harness.agentkit.best/ai-tools/chatgpt)
- [Phase 2 control-plane recovery](./phase-02-production-preflight-and-cloudflare-control-plane.md)
- [`docs/deployment.md`](../../docs/deployment.md)
- [`docs/configuration.md`](../../docs/configuration.md)

## Requirements

- Phase 3 host, resource, Tunnel, firewall, and rollback gates pass.
- Access app has one human Allow and one dedicated Service Auth policy.
- Managed OAuth has all three exact ChatGPT callback URIs.
- Issuer, audience, and JWKS URL come from the same Access application.
- No human or canary workspace overlaps during promotion.
- Hostinger console and SSH remain open; Cloudflare rollback is manual and
  independent of release rollback.

## Architecture

Cloudflare authenticates the operator and injects a signed Access assertion.
The origin links identity only from that verified assertion; it does not treat
the opaque OAuth bearer as identity. Deployment canary enters through the
Service Auth policy. The pre-cutover owner-bearer state remains only in the
protected local rollback snapshot until final retirement.

## Files / Resources to Create or Modify

- `/etc/cloud-harness-mcp/canary-credentials` — root `0600`
- `/etc/cloud-harness-mcp/runtime.env` — Access verifier settings; no bearer
- Preserve `INGRESS_MODE=tunnel`, token file, and secret keyring
- `/var/lib/cloud-harness/rollback-current` — immutable owner-bearer recovery
  snapshot created automatically before promotion
- Sanitized rollout evidence

## Tasks & Steps

### Task 4.1 — Freeze and verify both recovery planes

- **Goal:** Enter cutover with a known local rollback target and exact
  Cloudflare state records.
- **Steps:**
  1. Reconfirm existing-site health, resource thresholds, Tunnel health, and no
     active workspace.
  2. Record current release SHA, non-secret config-tree hash, and rollback
     snapshot identifier. Do not redeploy merely to fabricate `release-previous`;
     Phase 1 snapshot semantics already support same-SHA rollback.
  3. Export or screenshot non-secret Cloudflare app/policy/callback/route state
     and record exact manual restoration order.
  4. Confirm the operator can still reach Hostinger console and SSH without
     Access.
- **Success criteria:** Local and Cloudflare recovery owners, targets, and order
  are explicit; current owner-bearer service is healthy.
- **Verify:** Snapshot validator exits 0; Cloudflare state evidence contains no
  tokens; independent access routes work.

### Task 4.2 — Install canary credentials without exposing values

- **Goal:** Give deploy automation only the Service Auth credentials needed for
  the public canary.
- **Steps:**
  1. Create `/etc/cloud-harness-mcp/canary-credentials` with root ownership and
     mode `0600` using `sudoedit` or a root-only file transfer.
  2. Enter exactly `MCP_CANARY_URL`, `MCP_CANARY_ACCESS_CLIENT_ID`, and
     `MCP_CANARY_ACCESS_CLIENT_SECRET`; URL must be
     `https://mcp.codepod.site/mcp`.
  3. Ensure none of these keys exists in `runtime.env`.
  4. Validate key names, counts, file type, owner, and mode without printing
     values.
- **Success criteria:** Three keys occur once in the dedicated file; no secret
  appears in command history, argv, output, or rollout evidence.
- **Verify:** A root key-name/count validator and `stat` exit 0 and print no
  values.

### Task 4.3 — Stage Access runtime configuration

- **Goal:** Make verified Access assertions the only public identity path.
- **Steps:**
  1. Use `sudoedit` on `runtime.env`; do not source or print it in a recorded
     shell.
  2. Set `AUTH_MODE=cloudflare-access`.
  3. Add exact issuer, audience, and JWKS URL from the same app.
  4. Keep public hosts/origins for `mcp.codepod.site`, runner token, keyring,
     ingress, dependency profile, and workspace limit unchanged.
  5. Remove `MCP_BEARER_TOKEN` from the live runtime file. Do not add legacy
     principal mapping for this fresh deployment.
  6. Validate schema/key cardinality before calling deploy. A malformed config
     must fail before service stop.
- **Success criteria:** Access keys occur once, owner bearer is absent from live
  config, and Tunnel ingress remains selected.
- **Verify:** Run a secret-safe key-name validator plus the repository config
  parser against the staged file; both exit 0.

### Task 4.4 — Promote through the same-SHA deploy path

- **Goal:** Complete Access promotion with automatic rollback bound to the exact
  pre-cutover snapshot.
- **Steps:**
  1. Run `/usr/local/sbin/cloud-harness-deploy "$RELEASE_SHA"` once.
  2. Require creation of a new pre-mutation rollback snapshot even though SHA is
     unchanged.
  3. Require the public Service Auth canary. Do not substitute a restart or
     local readiness check.
  4. Confirm local readiness, local unauthenticated MCP rejection, public OAuth
     discovery, and private-browser dashboard login.
  5. Compare nginx hash and existing-site status/latency with baseline.
  6. If deployment/canary fails, require automatic local restoration of the
     owner-bearer snapshot. Do not mutate Cloudflare while automatic rollback is
     running.
- **Success criteria:** Deploy and public canary pass; OAuth metadata is
  discoverable; dashboard is protected; rollback target remains the pre-cutover
  owner-bearer state; existing sites are unchanged.
- **Verify:** Use bounded body/header files under a root-only working directory
  and delete them afterward. Assert HTTP 200 readiness, local 401, public OAuth
  metadata, snapshot metadata, nginx hash, and site probes. Never use shared
  `/tmp` for credential-bearing artifacts.

### Task 4.5 — Rehearse local rollback and forward recovery

- **Goal:** Prove the realistic failure response without claiming local rollback
  restores ChatGPT connectivity by itself.
- **Steps:**
  1. During the maintenance window, invoke manual rollback to the exact
     owner-bearer snapshot.
  2. Verify local readiness, owner-bearer canary, state/config hashes, and
     existing-site health. Public ChatGPT is expected to remain unavailable
     while Access still fronts an owner-bearer origin.
  3. Reapply the reviewed Access runtime config and deploy the same SHA again;
     require public Service Auth canary and OAuth discovery.
  4. Confirm `rollback-current` now refers to the just-recovered owner-bearer
     state and that no mixed snapshot was produced.
  5. If the fault had been in Cloudflare rather than origin config, follow the
     Phase 2 manual Cloudflare recovery record; never add Bypass or expose port
     3100.
- **Success criteria:** Local rollback and forward recovery both pass; the
  boundary between release and Cloudflare rollback is demonstrated.
- **Verify:** Record exit status, non-secret hashes, canary result, and expected
  temporary public unavailability during owner-bearer recovery.

### Task 4.6 — Recheck ChatGPT capability immediately before acceptance

- **Goal:** Avoid diagnosing an account/surface limitation as an origin fault.
- **Steps:**
  1. Confirm Developer Mode and OAuth custom connector creation still exist.
  2. Confirm testing will use a fresh standard 1-on-1 Web chat.
  3. Keep a draft connector selected unless workspace policy requires an admin
     to publish it.
  4. Treat `FORBIDDEN: This conversation does not support developer MCPs` as a
     hard client compatibility failure.
- **Success criteria:** The intended account and conversation surface satisfy the
  current official ChatGPT guide.
- **Verify:** Sanitized screenshot of Developer Mode and OAuth connector form;
  no account ID, nonce, callback query, or secret is visible.

## Todo

- [x] Task 4.1 — Freeze and verify both recovery planes.
- [x] Task 4.2 — Install canary credentials without exposing values.
- [x] Task 4.3 — Stage Access runtime configuration.
- [x] Task 4.4 — Promote through the same-SHA deploy path.
- [x] Task 4.5 — Rehearse local rollback and forward recovery.
- [x] Task 4.6 — Recheck ChatGPT capability immediately before acceptance.

## Risk Assessment

- Automatic rollback can restore local service state but cannot reverse Access,
  OAuth, DNS, or Tunnel settings.
- Owner-bearer credentials remain in the root-only rollback snapshot until final
  acceptance retires that recovery point. Treat backup access as credential
  access.
- A public 401 with OAuth metadata proves discovery, not ChatGPT tool execution.

## Security Considerations

Do not print Access assertions, canary credentials, runtime values, or backup
contents. Do not broaden callback wildcards, add Bypass policies, or expose a
second origin during recovery.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
failed command, full output, and expected condition. Apply guidance and rerun.
If unavailable, report evidence and do not continue.

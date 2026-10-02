---
phase: 6
title: "ChatGPT and operational acceptance"
status: pending
priority: P1
effort: "2.5h"
dependencies: [5]
---

# Phase 6: ChatGPT and operational acceptance

## Goal

Authorize Cloud Harness in ChatGPT Web, prove private clone and one idempotent
transactional branch push, exercise a request lasting beyond Cloudflare's nominal
read-timeout window, rotate the Tunnel credential, and close rollout with
existing sites unchanged and temporary credentials/artifacts retired.

## Context Links

- [Plan](./plan.md)
- [Official ChatGPT guide](https://docs.harness.agentkit.best/ai-tools/chatgpt)
- [`docs-site/ai-tools/chatgpt.md`](../../docs-site/ai-tools/chatgpt.md)
- [`docs/mcp-api.md`](../../docs/mcp-api.md)
- [`docs/operations.md`](../../docs/operations.md)

## Requirements

- Developer Mode and OAuth custom MCP creation are visible.
- Managed OAuth callbacks match the official guide exactly.
- Tests run in a fresh standard 1-on-1 ChatGPT Web chat.
- GitHub App binding authorizes only `cloud-harness-acceptance`.
- Canary and human workspaces are serialized; every opened workspace is closed.
- Push uses `workspace_finalize`, not separate commit/push calls.
- Unknown remote state is reconciled by exact idempotent replay before any new
  mutation.

## Architecture

ChatGPT authenticates through Access Managed OAuth and calls the Streamable HTTP
MCP endpoint through Tunnel. GitHub credentials remain in runner-owned transfer
helpers. `workspace_finalize` stages only the named path, commits, and pushes a
new explicit branch under one durable idempotency record.

## Files / Resources to Create or Modify

- ChatGPT connector `CloudHarness` at `https://mcp.codepod.site/mcp`
- New branch `acceptance/chatgpt-<UTC timestamp>` in
  `cloud-harness-acceptance`
- One file `acceptance/chatgpt-smoke.txt` with a non-secret timestamp/purpose
- Updated Tunnel token file during rotation
- Final sanitized rollout evidence

## Tasks & Steps

### Task 6.1 — Create and authorize the ChatGPT connector

- **Goal:** ChatGPT discovers the exact Cloud Harness tool catalog through
  Managed OAuth.
- **Steps:**
  1. Confirm Developer Mode in the current ChatGPT settings UI.
  2. Create connector `CloudHarness` with server URL exactly
     `https://mcp.codepod.site/mcp` and Authentication `OAuth`.
  3. If DCR rejects a redirect URI, read the exact URI from Advanced OAuth
     settings and compare it with the three Access callbacks; never broaden to
     `https://chatgpt.com/*`.
  4. Complete Access login with the principal bound in Phase 5.
  5. Keep Draft/Dev for single-user acceptance unless an admin must publish it.
  6. Start a fresh 1-on-1 Web chat and confirm tools are listed.
- **Success criteria:** Connector is connected/allowed, OAuth succeeds, and
  Cloud Harness tools are visible in a supported chat.
- **Verify:** Sanitized screenshot shows connector name, custom/dev state,
  connected status, OAuth method, and hostname only.

### Task 6.2 — Open the private repository and establish mutation preconditions

- **Goal:** Prove private clone and define an unambiguous new-branch transaction.
- **Steps:**
  1. Generate and retain one workspace-open idempotency key in the active
     session. Call `workspace_open` with the credential-free HTTPS repository
     URL and default branch.
  2. Confirm Active state and effective `dependency-access` profile.
  3. Choose `acceptance/chatgpt-<UTC timestamp>` and query GitHub/remote refs to
     prove the destination branch does not exist. Record expected remote state
     as **absent**; do not use force or force-with-lease for a new branch.
  4. Write only `acceptance/chatgpt-smoke.txt` with a non-secret UTC timestamp
     and purpose line.
  5. Inspect `git_status` and `git_diff`; require exactly that path and no
     unrelated changes.
- **Success criteria:** Private clone succeeds without interactive credentials;
  target branch is absent; one intended file is dirty.
- **Verify:** Tool results show Active workspace, expected network profile,
  credential-free remote URL, absent destination ref, and exact one-file diff.

### Task 6.3 — Finalize one idempotent branch push

- **Goal:** Commit and push through one crash-durable mutation.
- **Steps:**
  1. Generate one stable finalize idempotency key and retain it until remote
     confirmation.
  2. Call `workspace_finalize` once with:
     - `all: false`
     - `paths: ["acceptance/chatgpt-smoke.txt"]`
     - `commitMessage: "test: verify ChatGPT Cloud Harness push"`
     - explicit `branch: "acceptance/chatgpt-<UTC timestamp>"`
     - `push: true`
     - preflight diff checking enabled
     - the stable idempotency key
  3. Do not call `git_commit` or `git_push` separately and do not use force.
  4. If the result is `UNKNOWN_REMOTE_STATE`, send the identical
     `workspace_finalize` request with the same key and payload. Accept only a
     reconciled success such as `alreadyFinalized: true`; never mint a new key or
     issue a second mutation before reconciliation.
  5. Confirm GitHub shows the exact branch, commit, and one changed file.
  6. Close the workspace and confirm terminal state.
- **Success criteria:** One commit reaches one previously absent branch exactly
  once; idempotent replay is safe; no workspace remains active.
- **Verify:** GitHub branch OID equals the finalized commit OID and contains only
  the intended path. Workspace status is terminal closed.

### Task 6.4 — Prove a long MCP request through Cloudflare

- **Goal:** Detect Cloudflare/Tunnel timeout incompatibility before operational
  acceptance.
- **Steps:**
  1. Open a second disposable public-repository workspace with a fresh
     idempotency key while no canary/human workspace is active.
  2. Through ChatGPT, run a bounded `exec_run` that emits no output for at least
     140 seconds and then prints a fixed non-secret sentinel; set tool timeout
     above 140 seconds but within the schema maximum.
  3. Require the original tool call to return the sentinel without reconnecting,
     repeating the command, or weakening Access/Tunnel.
  4. Close the workspace immediately.
- **Success criteria:** The authenticated Streamable HTTP path survives the
  >125-second quiet operation and returns exactly one sentinel; workspace
  closes.
- **Verify:** Record start/end timestamps, tool result, and terminal workspace
  state. If Cloudflare terminates the call, mark rollout blocked; do not hide it
  with retries or an exposed origin.

### Task 6.5 — Rotate the Tunnel token and verify no leakage

- **Goal:** Prove the credential replacement/revocation runbook while the route
  is healthy.
- **Steps:**
  1. Generate a replacement token through Cloudflare's supported Tunnel token
     rotation flow and save it to a new secure local file.
  2. Transfer/install it through the same token-file path as Phase 3, preserving
     exact owner/mode/type. Never use argv or environment.
  3. Restart only the Cloud Harness service and require Tunnel health, Access
     canary, OAuth discovery, and existing-site health.
  4. Revoke the old Tunnel credential after the new connector is healthy.
  5. Delete the temporary local/VPS replacement files and search bounded
     command/log/config surfaces for the old and new secret fingerprints; zero
     matches.
- **Success criteria:** New token works, old token is revoked, no value is
  exposed, and unrelated sites remain green.
- **Verify:** Cloudflare shows the expected healthy connector after revocation;
  service canary passes; exact temporary paths are absent; fingerprint checks
  return no matches.

### Task 6.6 — Rehearse upgrade and retire temporary owner-bearer recovery

- **Goal:** Leave a clean Access-mode rollback point and complete operational
  evidence.
- **Steps:**
  1. With no active workspace, redeploy the same SHA in Access+tunnel mode.
     Require pre-mutation snapshot, public canary, exact images, dynamic gateway
     health, and dependency-firewall attestation.
  2. This deploy makes the previous healthy Access state the current rollback
     target. Validate it before deleting any older snapshot.
  3. Identify the exact owner-bearer snapshot retained from Phase 4. After the
     agreed rollback window and only when it is not `rollback-current`, remove
     that exact snapshot and any retired owner client-config file. Do not use
     globbed or root-level recursive deletion.
  4. Confirm live runtime and retained Access rollback snapshot contain no
     `MCP_BEARER_TOKEN`. Preserve required runner/keyring/canary/GitHub secrets.
  5. Recheck nginx hash, existing-site latency/status, memory, disk, OOM events,
     listeners, active containers, and workspace inventory.
  6. Record exact release SHA, non-secret Cloudflare/GitHub identifiers,
     successful gates, local and external rollback routes, credential owners,
     rotation dates, and residual risks.
- **Success criteria:** Same-SHA upgrade succeeds; rollback target is Access mode;
  temporary owner bearer is retired; no orphan, secret-bearing output, resource
  regression, or nginx/site change remains.
- **Verify:** Deploy and all health/resource gates exit 0. A secret-safe key-name
  scan finds no bearer key in live or retained Access config. `workspace_list`
  has no counted test workspace and no unexpected executor exists.

### Task 6.7 — Classify ChatGPT failures without unsafe workarounds

- **Goal:** Keep client limitations from eroding the ingress/auth boundary.
- **Steps:**
  1. For `FORBIDDEN: This conversation does not support developer MCPs`, check
     fresh 1-on-1 Web chat, Developer Mode, connector selection, draft/published
     policy, plan support, and stale thread state.
  2. For Reconnect, reauthorize through Access.
  3. For DCR callback rejection, correct only the exact callback list.
  4. Never disable Access, add Bypass, publish port 3100, add a bearer header to
     ChatGPT, or route around Tunnel.
- **Success criteria:** Failure is either corrected through documented controls
  or remains an explicit blocker with security boundaries intact.
- **Verify:** Repeat Task 6.1 in a new chat after correction; pass only when OAuth
  and tool listing both succeed.

## Todo

- [ ] Task 6.1 — Create and authorize the ChatGPT connector.
- [ ] Task 6.2 — Open the private repository and establish mutation preconditions.
- [ ] Task 6.3 — Finalize one idempotent branch push.
- [ ] Task 6.4 — Prove a long MCP request through Cloudflare.
- [ ] Task 6.5 — Rotate the Tunnel token and verify no leakage.
- [ ] Task 6.6 — Rehearse upgrade and retire temporary owner-bearer recovery.
- [ ] Task 6.7 — Classify ChatGPT failures without unsafe workarounds.

## Risk Assessment

- ChatGPT capability and UI are external and volatile; live execution is the
  acceptance gate.
- The >125-second quiet call may expose a Cloudflare plan limit. Failure blocks
  acceptance and requires architecture review, not retries.
- Credential cleanup must never remove `rollback-current` or required Access,
  runner, keyring, canary, or GitHub App secrets.

## Security Considerations

Acceptance data contains no production repository URL, environment value,
identity, or user data. No force push, default-branch mutation, workflow change,
broad GitHub installation, Access Bypass, or public origin is allowed.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
failed command/tool result, full output, and expected condition. Apply guidance
and rerun. If unavailable, report evidence and do not continue.

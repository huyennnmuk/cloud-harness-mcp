---
phase: 2
title: "Production preflight and Cloudflare control plane"
status: completed
priority: P1
effort: "2h"
dependencies: [1]
---

# Phase 2: Production preflight and Cloudflare control plane

## Goal

Prove the shared VPS can absorb one bounded executor without affecting existing
sites, establish independent host and Cloudflare recovery, and prepare Tunnel,
Access, and Managed OAuth without routing through CloudPanel nginx.

## Context Links

- [Plan](./plan.md)
- [Ingress research](./reports/ingress-research.md)
- [Red-team adjudication](./reports/red-team-adjudication.md)
- [`docs/security-model.md`](../../docs/security-model.md)
- [`docs/deployment.md`](../../docs/deployment.md)

## Requirements

- Phase 1 SHA is merged, exact, and on `origin/main`.
- A maintenance window allows MCP downtime but not production/staging downtime.
- Hostinger console and SSH work independently of Cloudflare.
- A current Hostinger snapshot has a known restore target.
- ChatGPT Web visibly offers Developer Mode and OAuth custom MCP creation.
- Cloudflare human Allow and canary Service Auth are separate policies; no
  Bypass policy is used.
- Cloudflare changes have a manual recovery sequence because VPS rollback cannot
  undo them.

## Architecture

Cloudflare owns `codepod.site`, `mcp.codepod.site`, Access, Managed OAuth, and
the Tunnel route. CloudPanel remains the sole nginx/SSL owner for the existing
sites and is not modified. `mcp.codepod.site` routes to `http://ingress:3100`
inside Docker; no origin A/AAAA record points it at `72.62.171.12`.

## Files / Resources to Create or Modify

- Create during execution:
  `plans/261002-selfhost-chatgpt-setup/reports/rollout-evidence.md` containing
  sanitized identifiers, hashes, commands, exit status, and pass/fail only.
- Modify only nameserver authority for `codepod.site`.
- Create Cloudflare zone, remotely managed Tunnel, published route, Access app,
  human Allow policy, Service Auth policy/token, and Managed OAuth settings.
- Read-only capture of nginx, listeners, Docker/resource state, and existing-site
  health.

## Tasks & Steps

### Task 2.1 — Establish independent recovery and immutable baseline

- **Goal:** Detect and recover any shared-host regression without relying on the
  new hostname or Cloudflare.
- **Steps:**
  1. Confirm a current Hostinger snapshot and record only identifier/timestamp.
  2. Keep Hostinger web console and a separate SSH session open and tested.
  3. Capture `sudo nginx -T` into a root-only file and record its SHA-256; do not
     copy the body into the plan report.
  4. Capture `sudo ss -ltnp`, `docker system df`, `free -h`,
     `df -h /var/lib`, `uptime`, and current container resource limits.
  5. Probe `https://yourfitnature.com`, `https://www.yourfitnature.com`, and
     `https://srv1281807.hstgr.cloud`; record status and latency only.
  6. Confirm no process binds host port 3100 and no MCP vhost exists in
     CloudPanel/nginx.
  7. Write an exact host recovery card: stop/disable only Cloud Harness, restore
     the Hostinger snapshot if necessary, and never run broad Docker cleanup.
- **Success criteria:** Both independent access routes work, nginx validates,
  existing sites are healthy, and rollback targets are identified.
- **Verify:** `sudo nginx -t`; exact listener query for port 3100; all three
  status-only probes; and snapshot/console evidence pass. Any failure is a hard
  stop.

### Task 2.2 — Prove aggregate capacity, not only workspace count

- **Goal:** Ensure one Cloud Harness workspace fits beside production and staging
  under worst configured limits.
- **Steps:**
  1. Resolve effective Compose limits for API, runner, Model Gateway, ingress,
     cloudflared, keepalives, and one executor from the Phase 1 SHA using a
     non-secret Compose projection.
  2. Add the maximum concurrent executor budget (1 CPU, 1 GiB, 256 pids) to
     control-plane limits and compare it with host capacity and current peak
     usage. `MAX_ACTIVE_WORKSPACES_PER_OWNER=1` is only a principal quota; during
     rollout, operational procedure must also serialize canary and human work.
  3. Require at least 4 GiB `MemAvailable`, 40 GiB free under `/var/lib`, and no
     recent OOM. Record current 1/5/15-minute load and site p95-like repeated
     latency baseline.
  4. Define abort thresholds: any existing-site status regression, repeated
     latency above twice baseline, `MemAvailable < 4 GiB`, free disk `< 40 GiB`,
     or OOM evidence.
- **Success criteria:** Worst configured single-workspace aggregate fits within
  2 CPU/8 GiB without overcommitting memory; all abort thresholds are green.
- **Verify:** A checked calculation is included in rollout evidence with each
  service limit and total. Run at least five status-only probes per existing
  hostname and record min/median/max latency.

### Task 2.3 — Move only `codepod.site` authority to Cloudflare

- **Goal:** Cloudflare becomes authoritative for the new isolated zone while
  `yourfitnature.com` remains unchanged at Hostinger.
- **Steps:**
  1. Export/screenshot current `codepod.site` records and confirm no active
     service uses them.
  2. Add `codepod.site` to Cloudflare and record the assigned nameservers.
  3. Change only this domain's registrar nameservers at Hostinger.
  4. Wait for Cloudflare zone status `Active`; re-probe all existing sites.
  5. Do not create an A/AAAA record for `mcp.codepod.site`.
  6. Record the reverse operation: restore the exact prior nameservers. This is
     manual and may be delayed by DNS TTL; it is not part of app rollback.
- **Success criteria:** Public NS authority matches Cloudflare, yourfitnature NS
  and health remain unchanged, and no MCP origin record exists.
- **Verify:** Compare public NS answers with Cloudflare dashboard/API zone state.
  Do not infer Tunnel correctness from CNAME output.

### Task 2.4 — Create the Tunnel and secret handoff

- **Goal:** Prepare a reproducible Tunnel route without exposing its credential.
- **Steps:**
  1. Confirm outbound TCP 7844 from the VPS. UDP 7844 is preferred but TCP
     fallback is acceptable.
  2. Create remotely managed Tunnel `cloud-harness-codepod`.
  3. Add public hostname `mcp.codepod.site` → `http://ingress:3100` and let
     Cloudflare create the proxied Tunnel DNS route.
  4. Save the token directly to an operator-local `0600` file or password
     manager attachment for Phase 3. Do not place it in clipboard history,
     shell arguments, chat, screenshots, or rollout evidence.
  5. Record the Tunnel UUID and published route only. Record how to rotate the
     token and how to revoke the old token after a successful replacement.
- **Success criteria:** Cloudflare API/dashboard shows the route bound to the
  intended Tunnel; outbound connectivity passes; secret transfer path is ready.
- **Verify:** Use Cloudflare route/Tunnel state plus a TCP 7844 probe. A flattened
  A/AAAA response at the public hostname is acceptable; an origin A/AAAA record
  to the VPS is not.

### Task 2.5 — Configure Access, Managed OAuth, and recovery order

- **Goal:** Separate human OAuth from automated canary access and make external
  recovery explicit.
- **Steps:**
  1. Create one hostname-wide Self-hosted Access application for
     `mcp.codepod.site` with no path restriction.
  2. Add an Allow policy limited to the operator identity and configured IdP.
  3. Create a dedicated Access service token and a separate Service Auth policy
     limited to it. Never use Bypass.
  4. Enable Managed OAuth and allow exactly:
     - `https://chatgpt.com/connector/oauth/*`
     - `https://chatgpt.com/connector_platform_oauth_redirect`
     - `https://chatgpt.com/api/aip/p/oauth/callback`
  5. Record issuer/team domain and application audience as non-secret values;
     store service-token values only in the approved secret route.
  6. Confirm Developer Mode and the OAuth custom connector form in ChatGPT; do
     not create the connector yet.
  7. Write the Cloudflare recovery sequence: pause connector testing; preserve
     the Tunnel route while local rollback runs; restore the prior Access/OAuth
     configuration from dashboard/API records if the fault is external; never
     create an unprotected origin or Bypass rule. State explicitly that local
     rollback to owner-bearer restores service state but not ChatGPT public
     availability until Access mode is repaired and redeployed.
- **Success criteria:** One Access app has one human Allow and one Service Auth
  policy, all callbacks match, and both local and external recovery owners are
  named.
- **Verify:** Sanitized dashboard/API evidence shows app hostname, policy types,
  callback list, issuer, audience, and recovery identifiers without any secret.

## Todo

- [x] Task 2.1 — Establish independent recovery and immutable baseline.
- [x] Task 2.2 — Prove aggregate capacity, not only workspace count.
- [x] Task 2.3 — Move only `codepod.site` authority to Cloudflare.
- [x] Task 2.4 — Create the Tunnel and secret handoff.
- [x] Task 2.5 — Configure Access, Managed OAuth, and recovery order.

## Risk Assessment

- DNS/Access/Tunnel are external state. Local release automation cannot revert
  them; recovery evidence is mandatory before routing traffic.
- Cloudflare may flatten proxied DNS responses. Dashboard/API route ownership
  and end-to-end HTTPS behavior are authoritative.
- One principal quota does not prevent concurrent canary and human work. The
  rollout must serialize all workspace creation until capacity acceptance ends.

## Security Considerations

Tunnel and service-token values are write-only operational secrets. The plan may
name their destination files but never request or record their values.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
failed command, full output, and expected condition. Apply its guidance and
rerun. If unavailable, report evidence and do not continue.

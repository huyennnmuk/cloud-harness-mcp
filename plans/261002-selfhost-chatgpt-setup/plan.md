---
title: "Self-host Cloud Harness MCP with ChatGPT Web"
description: "Deploy Cloud Harness MCP through Cloudflare Tunnel beside the existing yourfitnature production and staging workloads, with Access Managed OAuth and private GitHub push."
status: pending
priority: P1
effort: 20h
branch: main
tags: [infra, auth, security, critical]
blockedBy: []
blocks: []
created: 2026-10-02
---

# Self-host Cloud Harness MCP + ChatGPT Web

## Overview

Deploy `mcp.codepod.site` on Hostinger VPS `72.62.171.12` through Cloudflare
Tunnel. CloudPanel remains the sole nginx/SSL owner for `yourfitnature.com`,
`www.yourfitnature.com`, and `srv1281807.hstgr.cloud`; Cloud Harness never
modifies those vhosts. The rollout includes Access Managed OAuth, ChatGPT custom
MCP acceptance, a GitHub App binding, and a private-repository push.

## Scope Challenge

- **Existing code:** Tunnel/installer paths exist, but the reviewed baseline leaks
  the Tunnel token through Compose interpolation, requires unprovisioned static
  Model Gateway files, loses dependency firewall policy after reboot, and cannot
  manually roll back same-SHA configuration promotions.
- **Requested scope:** shared-VPS deployment, `codepod.site`, ChatGPT OAuth, and
  private GitHub clone/finalize/push.
- **Complexity:** six ordered phases; Phase 1 is a release-blocking repository
  repair covering all accepted red-team findings, not optional platform expansion.
- **Selected mode:** HOLD SCOPE; hard planning with `--advice` supervision.

## Architecture Decision

```text
ChatGPT/browser -> Cloudflare Access + Managed OAuth -> Cloudflare Tunnel
  -> cloudflared -> http://ingress:3100 -> API -> runner -> executor
```

`mcp.codepod.site` uses a Tunnel-managed DNS route, not an A record to the VPS.
No Certbot or CloudPanel site is created. Tunnel credentials use a mounted token
file and a digest-pinned cloudflared image. Model Gateway starts dynamically
without a provider secret. Every deploy creates a pre-mutation rollback snapshot
even when the SHA is unchanged. Explicit external ingress skips repo-owned nginx
mutation while retaining public Access canary and rollback.

## Constraints and Safety Contract

- Shared host: 2 CPU, 8 GiB RAM, 100 GiB disk; production and staging already run.
- Maintenance window permits brief MCP downtime, never production/staging downtime.
- Abort if existing-site health changes, repeated latency exceeds twice baseline,
  `MemAvailable < 4 GiB`, free disk `< 40 GiB`, or independent recovery is unavailable.
- `MAX_ACTIVE_WORKSPACES_PER_OWNER=1` is not a global cap; all canary and human
  workspace activity is serialized through rollout acceptance.
- Tunnel, Access, canary, keyring, and GitHub App secrets stay in separate
  protected files and never enter chat, argv, environment interpolation, logs,
  source control, full Compose output, or plan artifacts.
- Local release rollback and Cloudflare DNS/Tunnel/Access rollback are separate
  control planes with separate evidence and recovery order.

## Phases

| Phase | Name | Status | Depends on |
|---|---|---|---|
| 1 | [Repository release and ingress readiness](./phase-01-repository-ingress-readiness.md) | Completed | — |
| 2 | [Production preflight and Cloudflare control plane](./phase-02-production-preflight-and-cloudflare-control-plane.md) | Completed | 1 |
| 3 | [Owner-bearer Tunnel install](./phase-03-owner-bearer-tunnel-install.md) | Pending | 2 |
| 4 | [Cloudflare Access cutover](./phase-04-cloudflare-access-cutover.md) | Pending | 3 |
| 5 | [GitHub App private-repository binding](./phase-05-github-app-private-push.md) | Pending | 4 |
| 6 | [ChatGPT and operational acceptance](./phase-06-chatgpt-and-operational-acceptance.md) | Pending | 5 |

## Acceptance Criteria

- Fresh install starts from the exact merged SHA with an empty dynamic Model
  Gateway and no provider secret prerequisite.
- Tunnel credentials are absent from argv, environment, Compose output, logs,
  and process metadata; cloudflared is pinned by digest.
- Dependency egress is re-attested before service start after a reboot-equivalent
  rule loss; failure is closed.
- Same-SHA owner-bearer → Access promotion supports automatic and manual rollback
  to one coherent config/state/artifact/image snapshot.
- Access+tunnel deploy never invokes nginx; CloudPanel config and existing sites
  remain unchanged and no new public host listener appears.
- Managed OAuth, dashboard login, a >125-second quiet MCP operation, private clone,
  one idempotent `workspace_finalize` branch push, and workspace close pass.
- Tunnel credential rotation/revocation and owner-bearer backup retirement pass;
  no orphan or secret-bearing output remains.

## Evidence

- [Ingress research](./reports/ingress-research.md)
- [Advisory decision](./reports/advisory-decision.md)
- [Red-team adjudication](./reports/red-team-adjudication.md)
- [`docs/deployment.md`](../../docs/deployment.md)
- [`docs/security-model.md`](../../docs/security-model.md)
- [`docs/github-app-private-repositories.md`](../../docs/github-app-private-repositories.md)

## Validation Log

### Session 1 — 2026-10-02

- Ingress: Cloudflare Tunnel plus ingress-aware release patch.
- Downtime: brief scheduled MCP outage accepted.
- Safety: conservative resource gates and independent recovery accepted.
- ChatGPT: custom MCP capability exists and will be verified before cutover.
- GitHub: initial rollout includes GitHub App and private push.

### Advisory Supervision

Kongming recommended Tunnel because it isolates Cloud Harness ingress ownership
from CloudPanel. The recommendation stops if outbound Tunnel connectivity,
Managed OAuth, shared-host resource gates, or automatic canary/rollback cannot
be proven.

### Red-team decision

The user accepted all 13 evidence-backed findings. Phase 1 must close every
Critical and High item before VPS or Cloudflare mutation. Scope expansions into
static API-key ingress, multi-tenant isolation, CloudPanel/nginx changes, and
production-repository writes remain rejected.

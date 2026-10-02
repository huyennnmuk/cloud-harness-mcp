# Red-team adjudication

Date: 2026-10-02
Decision: apply all evidence-backed findings before rollout.

## Accepted findings

1. **Tunnel credential exposure (Critical).** `deploy/cloudflare-tunnel/compose.tunnel.yaml` interpolates the token into the container command, while `service-compose.sh` and `release-runtime.sh` source and export it. Resolved Compose output and process metadata can expose it. The plan requires a mounted token file, no token environment interpolation, and secret-safe verification.
2. **Fresh-install model gateway failure (Critical).** Production Compose requires host profile and credential files that the installer does not provision. The plan requires dynamic model-gateway startup with an empty initial snapshot and no provider credential until an operator configures a model profile through the dashboard.
3. **Same-SHA rollback gap (Critical).** `deploy-release.sh` records `release-previous` only when the SHA changes, while configuration promotions intentionally reuse the SHA. The plan requires an immutable pre-mutation rollback snapshot containing SHA, config, state, artifacts, and image identities for every deployment.
4. **Installer release drift (Critical).** `checkout_repository` fetches `origin/main` but installs operational files before checking out `RELEASE_SHA`. The plan requires ancestry validation and detached checkout before any repository-owned file is copied or executed.
5. **Firewall lifecycle is not reboot-safe (High).** Dependency-egress rules are installed manually and are not reconciled by systemd after reboot. The plan requires idempotent pre-start reconciliation, post-apply attestation, and restore-on-failure semantics without claiming a cross-family atomic transaction.
6. **Mutable cloudflared runtime (High).** `cloudflare/cloudflared:latest` makes deploy and rollback non-reproducible. The plan requires a reviewed version pinned by digest and a controlled update procedure.
7. **Installer invocation ambiguity (High).** Interactive and curl-to-shell routes do not prove the same release/input behavior. The rollout uses a local reviewed checkout, exact flags, TTY/file-based secret input, and behavioral tests for both TTY and non-interactive failure paths.
8. **Two independent rollback planes (High).** VPS automation cannot undo Cloudflare DNS, Tunnel, Access, or Managed OAuth changes. The plan separates local release rollback from a documented Cloudflare control-plane recovery sequence and keeps Hostinger console/SSH independent.
9. **Proxied DNS false checks (High).** Public DNS may flatten the Tunnel CNAME. Cloudflare route/API state and HTTPS behavior are authoritative; record-type output is not.
10. **Shared-host capacity proof is incomplete (High).** `MAX_ACTIVE_WORKSPACES_PER_OWNER=1` is not a host-global resource limit. The plan serializes all principals during rollout, checks aggregate Compose/executor budgets against the 2-vCPU/8-GiB host, and makes existing-site latency plus OOM evidence decisive.
11. **Private push mutation is underspecified (High).** The plan requires one `workspace_finalize` mutation with an explicit new branch, path allowlist, commit message, and stable idempotency key. The destination ref must be proven absent before the first call; `UNKNOWN_REMOTE_STATE` must be reconciled by replaying the identical request before any new mutation. `expectedRemoteOid` is not supplied for this non-force new-branch flow because the public schema permits it only with force-with-lease.
12. **Credential retirement is incomplete (High).** The plan adds temporary-upload deletion, old Tunnel credential revocation, owner-bearer rollback-window retirement, bounded backup retention, and exact-path leak checks.
13. **Acceptance checks can report false success (High).** Verification must inspect only non-secret projections and the actual Docker/Compose fields, and must include reboot recovery plus a streamed operation lasting beyond Cloudflare's nominal HTTP read-timeout window.

## Rejected scope expansions

- Static API-key ingress lane.
- Multi-tenant or hostile-tenant isolation.
- CloudPanel/nginx/Certbot mutation for the MCP hostname.
- Migration of `yourfitnature.com` or its staging hostname.
- Workflow permission or production-repository push.
- New monitoring or governance systems unrelated to this rollout.
## Resulting direction

Phase 1 becomes a release-readiness change set covering ingress resolution, credential transport, dynamic model-gateway startup, exact release checkout, reboot-safe dependency egress, and same-SHA rollback. The remaining phases may execute only against the merged SHA that passes focused tests, `verify:compose`, and `verify`.

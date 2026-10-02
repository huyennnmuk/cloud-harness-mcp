# Advisory decision: shared-VPS ingress

## Recommendation

Use Cloudflare Tunnel and patch the release flow before deployment. The target ownership model is:

```text
ChatGPT/browser
  -> Cloudflare Access + Managed OAuth
  -> Cloudflare Tunnel published route
  -> cloudflared container
  -> http://ingress:3100 on the Docker ingress network
  -> API -> runner -> executor
```

CloudPanel remains the sole nginx/SSL owner for the existing production and staging sites. Cloud Harness does not create or mutate a CloudPanel vhost.

## User decisions (2026-10-02)

- Ingress: Cloudflare Tunnel plus an ingress-aware release patch.
- Upgrades: brief scheduled MCP downtime is acceptable.
- Shared-VPS safety: conservative resource gates and independent SSH/Hostinger-console recovery.
- ChatGPT: Developer Mode/custom MCP capability exists and will be verified before Access cutover.
- GitHub: include GitHub App binding and private-repository push in the initial rollout.

## Required patch contract

- Resolve `INGRESS_MODE` before deployment mutation.
- No `ingress.conf` preserves legacy managed-nginx behavior.
- `tunnel`, `caddy`, and `custom` skip the canonical nginx upgrader but still require the public Access canary.
- Unknown, duplicate, or malformed ingress configuration fails before downtime.
- Fix the installer to emit `WORKSPACE_NETWORK_PROFILE`, not retired `WORKSPACE_NETWORK_MODE`.
- Keep tunnel token, Access canary credentials, application runtime config, and GitHub App private key in separate root-owned files.

## Residual risks

- Shared Docker daemon/kernel and shared 2-vCPU host remain a blast-radius boundary.
- `MAX_ACTIVE_WORKSPACES_PER_OWNER=1` is per principal, not a global host cap.
- Image builds and helper containers can exceed the executor's 1 CPU/1 GiB envelope.
- Current release orchestration stops the tunnel during deployment; this plan accepts scheduled MCP downtime but not production/staging downtime.

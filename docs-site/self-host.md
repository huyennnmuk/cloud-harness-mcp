---
title: Self-Hosting & Deployment
description: Deploying a private Cloud Harness MCP server on your own infrastructure.
---

# Self-Hosting & Deployment

Cloud Harness MCP is designed for straightforward self-hosting on any modern Linux VPS or cloud instance.

## Deployment Architectures

### 1. Reviewed-release deployment (Caddy / Cloudflare Tunnel)

Use a local checkout so the installer, Compose files, systemd unit, and first
deployment all come from the same reviewed commit:

```bash
git clone https://github.com/bestagentkits/cloud-harness-mcp.git
cd cloud-harness-mcp
git fetch origin main
RELEASE_SHA="$(git rev-parse origin/main)"
git checkout --detach "$RELEASE_SHA"
sudo ./scripts/install.sh --release-sha "$RELEASE_SHA" --ingress caddy
```

- **Caddy Ingress:** Automatically requests and renews Let's Encrypt TLS certificates, proxying traffic to the loopback ingress `127.0.0.1:3100`.
- **Cloudflare Tunnel:** Uses `--tunnel-token-file` and a direct read-only container mount; the token never enters Compose interpolation, environment, or argv.
- **Management:** Uses the `cloudharness` CLI (`cloudharness status`, `cloudharness logs`, `cloudharness token`).

### 2. Traditional NGINX Reverse Proxy Runbook

For custom infrastructure with existing NGINX setups:

1. **Bootstrap VPS:** Run `deploy/scripts/bootstrap-vps.sh` to install Docker, systemd unit, and permissions.
2. **Deploy Release:** Run `deploy/scripts/deploy-release.sh <git-sha>` to build and start production containers.
3. **Canary Verification:** Run `scripts/deploy-canary.mjs` to execute an automated end-to-end workspace test against the newly deployed instance.

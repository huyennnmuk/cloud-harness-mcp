# Ingress research

## Decision evidence

CloudPanel is the existing owner of nginx, vhosts, and certificates for the shared VPS. Its supported integration route is a panel-managed Reverse Proxy site and Vhost Editor, not external `certbot --nginx` mutation.

Cloud Harness currently exposes a cleaner route for this host:

- `deploy/cloudflare-tunnel/compose.tunnel.yaml` runs `cloudflared` without host ports or mounts and attaches it only to the Docker `ingress` network.
- `deploy/scripts/release-runtime.sh` includes the tunnel Compose file when `/etc/cloud-harness-mcp/ingress.conf` sets `INGRESS_MODE=tunnel`.
- `scripts/install.sh` supports `--ingress tunnel` and stores the tunnel token separately under `/etc/cloud-harness-mcp/tunnel.env`.

Two repository defects block a production-safe rollout:

1. `deploy/scripts/deploy-release.sh` unconditionally invokes `deploy/scripts/upgrade-nginx-dashboard.sh` in `cloudflare-access` mode, even when ingress is Tunnel/Caddy/custom. The upgrader requires `/etc/nginx/sites-available/cloud-harness-mcp.conf` and an exact symlink under `sites-enabled`.
2. `scripts/install.sh` writes retired `WORKSPACE_NETWORK_MODE=none`; `apps/runner/src/config.ts` rejects that variable and requires `WORKSPACE_NETWORK_PROFILE=network-none|dependency-access`.

## Recommended architecture

Use Cloudflare Tunnel after an ingress-aware release patch is merged. Keep CloudPanel as sole nginx owner for `yourfitnature.com`, `www.yourfitnature.com`, and `srv1281807.hstgr.cloud`. Publish `mcp.codepod.site` through Tunnel to `http://ingress:3100`; do not create an A record to the VPS and do not configure Certbot/CloudPanel TLS for the MCP hostname.

## Stop conditions

- Outbound Cloudflare Tunnel connectivity cannot be established.
- Access+tunnel deploy still invokes the nginx upgrader.
- ChatGPT custom MCP capability cannot be demonstrated before cutover.
- Production/staging health changes, available RAM drops below 4 GiB, or free disk drops below 40 GiB during the maintenance gate.
- Independent SSH/Hostinger console rollback is unavailable.

## Primary sources

- `scripts/install.sh`
- `deploy/cloudflare-tunnel/compose.tunnel.yaml`
- `deploy/scripts/deploy-release.sh`
- `deploy/scripts/release-runtime.sh`
- `deploy/scripts/upgrade-nginx-dashboard.sh`
- `apps/runner/src/config.ts`
- `docs/deployment.md`
- `docs-site/installation.md`
- https://www.cloudpanel.io/docs/v2/frontend-area/add-site/#create-a-reverse-proxy
- https://www.cloudpanel.io/docs/v2/frontend-area/vhost/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- https://docs.harness.agentkit.best/ai-tools/chatgpt — exact Managed OAuth callbacks, Draft/Dev versus Published connector behavior, supported 1-on-1 Web surface, and `FORBIDDEN`/DCR troubleshooting.

---
title: Installation & Prerequisites
description: System requirements and setup instructions for Cloud Harness MCP server.
---

# Installation & Prerequisites

## System Requirements

- **Linux OS:** Ubuntu 24.04 LTS (recommended) or Debian 12
- **Docker Engine:** 26.0+ with Docker Compose v2
- **Node.js:** 24.x LTS (for local CLI/development)
- **RAM:** Minimum 4GB (8GB recommended for concurrent workspaces). Each counted workspace can use up to 1 GiB of container memory, one CPU, and 256 pids, so size host memory for `MAX_ACTIVE_WORKSPACES_PER_OWNER` (default 3) multiplied by the expected number of simultaneous builds.
- **Disk:** Minimum 40GB SSD for container images, jobs, and build caches

## Reviewed-release server installer (recommended)

Production installation is local-checkout based. Clone the repository, select
the exact 40-character commit already merged to `origin/main`, review it, and
run that checkout's installer. Do not pipe the installer from the network into
a root shell.

```bash
git clone https://github.com/bestagentkits/cloud-harness-mcp.git
cd cloud-harness-mcp
git fetch origin main
RELEASE_SHA="$(git rev-parse origin/main)"
git checkout --detach "$RELEASE_SHA"

# Caddy-managed HTTPS
sudo ./scripts/install.sh \
  --release-sha "$RELEASE_SHA" \
  --domain mcp.example.com \
  --email admin@example.com \
  --ingress caddy \
  --non-interactive
```

For Cloudflare Tunnel, first place the Tunnel token in a root-readable,
single-line regular file without putting the token in shell arguments:

```bash
sudo ./scripts/install.sh \
  --release-sha "$RELEASE_SHA" \
  --ingress tunnel \
  --domain mcp.example.com \
  --tunnel-token-file /root/cloudflare-tunnel-token \
  --non-interactive
```

The installer:

1. validates the selected commit and proves it is on `origin/main`;
2. checks out that commit before copying or executing deployment assets;
3. generates independent application secrets under `/etc/cloud-harness-mcp`;
4. installs the Tunnel credential as a direct `0640` token file, never as an
   environment variable or container command value;
5. starts Model Gateway in dynamic mode with no provider profile or key;
6. installs systemd dependency-egress reconciliation and the release/rollback
   commands; and
7. writes the owner client configuration to a root-only file and prints only
   its path.

### Managing the Server (`cloudharness` CLI)

Once installed, use the `cloudharness` utility to manage your instance:

```bash
# Check service, container, and ingress health status
cloudharness status

# View service logs
cloudharness logs api -f
cloudharness logs runner -f

# View or safely rotate MCP bearer token
sudo cloudharness token view
sudo cloudharness token rotate

# Upgrade to the latest release
sudo cloudharness upgrade
```

---

## Installing the Companion Agent Skill

You can install the self-contained `cloudharness` agent skill directly from this repository using the [Skills CLI](https://www.npmjs.com/package/skills):

```bash
# Project scope
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness

# Or global user scope
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness --global
```

### Claude Code Plugin Marketplace

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness@bestagentkits
```

### OpenAI Codex Plugin

```bash
codex plugin marketplace add bestagentkits/cloud-harness-mcp
codex plugin add cloud-harness@bestagentkits
```

---

## Manual Setup with Docker Compose (Alternative)

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/bestagentkits/cloud-harness-mcp.git
   cd cloud-harness-mcp
   ```

2. **Configure Environment:**
   ```bash
   cp .env.example .env
   # Edit .env and supply your secrets (MCP_BEARER_TOKEN, RUNNER_TOKEN, etc.)
   ```

3. **Build Images and Start Containers:**
   ```bash
   docker compose --profile images build executor-image api runner
   docker compose up -d
   ```

4. **Verify Health:**
   ```bash
   curl http://127.0.0.1:3100/readyz
   # Returns: {"status":"healthy"}
   ```

# Rollout Evidence — Phase 2: Production Preflight and Cloudflare Control Plane

Generated: 2026-10-02
Scope: Shared VPS `72.62.171.12` | Domain `codepod.site` | Hostinger / Cloudflare
Release SHA: `483391f0e8c98d566bf63097406919e12bc3ecf4` (verified ancestor of `origin/main`; behavior-identical base `ed72f26` with plan/evidence additions)
Repository Origin: `git@github.com:huyennnmuk/cloud-harness-mcp.git`

---

## 1. External Baseline Probes (Automated Local Capture)

Probed: 2026-10-02 (5 samples per hostname, no redirect follow)

| Target URL | HTTP Status | Min Latency (ms) | Median Latency (ms) | Max Latency (ms) | Remote IP |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `https://yourfitnature.com` | 200 | 1099.39 | 1185.35 | 1215.01 | `72.62.171.12` |
| `https://www.yourfitnature.com` | 301 | 818.69 | 900.16 | 1446.10 | `72.62.171.12` |
| `https://srv1281807.hstgr.cloud` | 200 | 1099.25 | 1146.96 | 1168.36 | `72.62.171.12` |

**Abort threshold:** Any status regression or sustained latency exceeding 2× baseline (~2400 ms for yourfitnature).

---

## 2. DNS Pre-Cutover Baseline (Automated Local Capture)

| Query | Record Type | Current Value | Target / Notes |
| :--- | :--- | :--- | :--- |
| `codepod.site` | A | `['2.57.91.91']` | Hostinger parked IP |
| `codepod.site` | NS | `['pixel.dns-parking.com.', 'byte.dns-parking.com.']` | Hostinger default parking NS |
| `codepod.site` | DS | None (Empty, Status 0) | Clean: no stale DNSSEC to cause SERVFAIL |
| `mcp.codepod.site` | A / CNAME | NXDOMAIN | Clean: no pre-existing origin or CNAME |
| `yourfitnature.com` | NS | `['ns1.dns-parking.com.', 'ns2.dns-parking.com.']` | MUST REMAIN UNTOUCHED |
| `yourfitnature.com` | A | `['72.62.171.12']` | MUST REMAIN UNTOUCHED |

---

## 3. Aggregate Capacity Calculation (Task 2.2)

### Compose Static Ceilings (from `compose.production.yaml` and `compose.tunnel.yaml`)

| Service | CPU Limit | Memory Limit | PID Limit | Source |
| :--- | :--- | :--- | :--- | :--- |
| `api` | 0.50 | 512 MiB | 128 | `compose.production.yaml:9` |
| `ingress` | 0.25 | 128 MiB | 64 | `compose.production.yaml:17` |
| `provisioning-proxy` | 0.25 | 128 MiB | 64 | `compose.production.yaml:26` |
| `runner` | 1.00 | 1024 MiB | 256 | `compose.production.yaml:34` |
| `model-gateway` | 0.50 | 512 MiB | 128 | `compose.production.yaml:53` |
| `executor-image-keepalive` | 0.01 | 32 MiB | 8 | `compose.production.yaml:69` |
| `agent-image-keepalive` | 0.01 | 32 MiB | 8 | `compose.production.yaml:86` |
| `cloudflared` | 0.25 | 128 MiB | 64 | `compose.tunnel.yaml:26-28` |
| **Control Plane Subtotal** | **2.77 CPU** | **2496 MiB (~2.44 GiB)** | **720 PIDs** | — |
| One workspace executor | 1.00 CPU | 1024 MiB (1.00 GiB) | 256 PIDs | `workspace-service.ts:714-724` |
| **Combined Single-Workspace Total** | **3.77 CPU** | **3520 MiB (~3.44 GiB)** | **976 PIDs** | Worst-case ceiling |

### Host Budget & Oversubscription Analysis

- **VPS Spec:** 2 vCPU, 8 GiB RAM, 100 GiB Disk.
- **Memory:** 3520 MiB worst-case ceiling leaves ~4.5 GiB available for host OS and existing workloads. Target `MemAvailable >= 4 GiB` is feasible provided host baseline usage is `< 3.5 GiB`.
- **CPU & Concurrency Safeguard:** The arithmetic total (3.77 vCPU ceiling) on a 2-vCPU host represents an operational oversubscription model. Because Docker CPU limits define scheduling quotas rather than pinned core reservations, oversubscription is accepted under the hard invariant that workspace admission is strictly serialized (`MAX_ACTIVE_WORKSPACES_PER_OWNER=1` in `runtime.env`), Model Gateway has zero active profiles, no agent containers are launched, and existing-site health/latency abort thresholds remain active throughout rollout.

---

## 4. Operator Verification Card (Completed & Verified)

### Step 2.1 — Independent Recovery & Host Baseline (VERIFIED)
- [x] **VPS Nginx Configuration:**
  - Baseline backup: `/root/nginx-baseline-20261002.conf`
  - SHA-256: `7fe1da8ae5b4ba7875bd0cfbfcfec40eedec3eedf0338b2a986a8a1aa4d78515`
  - Validation: `sudo nginx -t` (syntax ok, test successful) — PASS
- [x] **Host Port 3100:**
  - Command: `ss -ltnp | grep -w 3100` -> Empty / PASS (Port 3100 is completely free)
- [x] **Host Resource Check:**
  - `free -h`: Total 7.8 GiB, Used 2.5 GiB, Free 813 MiB, Buff/Cache 4.8 GiB, `MemAvailable: 5.2 GiB` (Threshold `>= 4.0 GiB`: PASS)
  - `df -h /var/lib`: `/dev/sda1` Size 96 GiB, Used 46 GiB, `Avail: 51 GiB (48%)` (Threshold `>= 40 GiB`: PASS)
  - `uptime`: Load average `0.00, 0.00, 0.00` (87 days uptime) — PASS
  - OOM Check: `dmesg -T | grep -i oom` -> Clean / No recent OOM events found — PASS
  - Docker daemon: Not currently installed (`command not found`); clean host; installation handled automatically by `scripts/install.sh` in Phase 3.
- [x] **Cloudflare Edge Connectivity:**
  - TCP 7844 to `region1.v2.argotunnel.com`: Reachable / PASS
### Step 2.3 — Nameserver Delegation (VERIFIED)
- [x] Nameservers for `codepod.site` delegated at registrar to Cloudflare:
  - RDAP registry authoritative NS: `kristina.ns.cloudflare.com`, `zahir.ns.cloudflare.com` — PASS
- [x] `yourfitnature.com` nameservers verified 100% untouched (`ns1.dns-parking.com`, `ns2.dns-parking.com`) — PASS
- [x] Existing site health re-probed and healthy (200 / 301 / 200) — PASS
- [x] No origin A/AAAA record exists for `mcp.codepod.site` (NXDOMAIN preserved) — PASS

### Step 2.4 — Cloudflare Tunnel Creation (VERIFIED)
- [x] Remotely managed tunnel created: `cloud-harness-codepod`
- [x] Tunnel UUID: `8497f1d0-2cf0-4782-99ef-30b69343a724`
- [x] Public hostname route: `mcp.codepod.site` -> `http://ingress:3100` (service type HTTP) — PASS
- [x] DNS route verified via DoH: proxied to Cloudflare Edge (`172.67.158.1`, `104.21.66.87`), VPS origin IP unexposed — PASS
- [x] Tunnel token securely stored locally by operator in protected file (never committed or exposed) — PASS
- [x] Outbound TCP 7844 connectivity from VPS to Cloudflare edge: verified in Step 2.1 — PASS

### Step 2.5 — Cloudflare Access & Managed OAuth (VERIFIED)
- [x] Access Application created: `Cloud Harness MCP`
  - App ID: `1edeaa1d-91b5-4be0-865b-81724cf7d423`
  - Protected destination: `mcp.codepod.site` (hostname-wide, no path restrictions)
  - Application Audience (AUD) Tag: `1f5dcc6e9bcd015dc39f19c2496cd1f7f000bdc281df05da9ea439f73fdbf664`
  - Team domain / Issuer: `https://floral-hall-4041.cloudflareaccess.com`
- [x] Policy 1 (Human): Action `Allow`, ID `af80b321-33e9-4606-92d3-90d7d763ea75`
  - Rule: restricted to operator identity (`Emails: huyennnm.uk@gmail.com`)
- [x] Policy 2 (Canary): Action `Service Auth`, ID `8d52837e-d42f-4c33-adb6-594795e258e0`
  - Rule: restricted to service token `cloud-harness-canary` (Token ID: `b505e266-513f-484d-b489-36268cff30cf`)
  - No Bypass policy used (default-deny preserved)
- [x] Managed OAuth enabled:
  - Verified via public endpoint probe: `curl -I https://mcp.codepod.site` returns HTTP 401 Bearer challenge pointing to resource metadata
  - Protected resource metadata verified: `https://mcp.codepod.site/.well-known/cloudflare-access-protected-resource/` advertises team domain `floral-hall-4041.cloudflareaccess.com` and OAuth 2.0 authentication method
- [x] Host recovery sequence documented below.
---

## 5. Host Recovery Sequence Card

1. **Immediate containment:** If any existing site regresses, stop Cloud Harness only:
   ```bash
   sudo systemctl stop cloud-harness-mcp || docker compose -p cloud-harness-mcp down
   ```
2. **Never** run `docker system prune -a` or modify CloudPanel nginx configs.
3. **Rollback local release:** Run `sudo /opt/cloud-harness-mcp/deploy/scripts/rollback-release.sh`.
4. **Cloudflare recovery:** Preserve Tunnel route; rollback Access/OAuth rules via Cloudflare Dashboard.
5. **Full host recovery (last resort):** Restore Hostinger snapshot with operator authorization if OS filesystem is corrupted.

---

## 6. Phase 3 Installation & Operational Acceptance (VERIFIED)

- **Deployed Commit SHA**: `ae2a1e25d8df72b849804258f3e3356c4ca2a107` (verified on host detached HEAD)
- **Image Builds (6/6)**:
  - `cloud-harness-executor:local`: Built
  - `cloud-harness-runner:local`: Built
  - `cloud-harness-model-gateway:local`: Built
  - `cloud-harness-network-guard:local`: Built
  - `cloud-harness-agent:local`: Built
  - `cloud-harness-api:local`: Built
- **Canary Test**:
  - `deploy-canary-network-profile=instance-default`
  - `deploy-canary-posture=profile:network-none default:network-none`
  - `deploy-canary=pass`
- **Docker Services Status**: All 7 containers up & healthy:
  - `cloud-harness-mcp-ingress-1`: Up (healthy), bound to `127.0.0.1:3100->3100/tcp` (loopback only)
  - `cloud-harness-mcp-api-1`: Up (healthy)
  - `cloud-harness-mcp-runner-1`: Up (healthy)
  - `cloud-harness-mcp-provisioning-proxy-1`: Up
  - `cloud-harness-mcp-model-gateway-1`: Up (healthy)
  - `cloud-harness-mcp-cloudflared-1`: Up, connected via QUIC & HTTP/2 to Cloudflare Edge
  - Keepalive containers: Up
- **Cloudflare Zero Trust Connector Status**:
  - Tunnel `cloud-harness-codepod`: **Healthy** (Uptime: 2+ minutes)
- **Zero Regression on Existing Sites**:
  - `yourfitnature.com`: HTTP 200 (1266 ms, stable)
  - `www.yourfitnature.com`: HTTP 301 (912 ms, stable)
  - `srv1281807.hstgr.cloud`: HTTP 200 (1400 ms, stable)
  - Public `https://mcp.codepod.site`: HTTP 401 (protected by Access Managed OAuth)

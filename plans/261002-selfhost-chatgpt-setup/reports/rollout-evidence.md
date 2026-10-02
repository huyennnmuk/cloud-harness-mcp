# Rollout Evidence — Phase 2: Production Preflight and Cloudflare Control Plane

Generated: 2026-10-02
Scope: Shared VPS `72.62.171.12` | Domain `codepod.site` | Hostinger / Cloudflare
Release SHA: `ed72f263bbcb163b0a9083b6aa53480ad3188706` (verified ancestor of `origin/main`)
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
- **CPU:** The arithmetic total (3.77 vCPU) exceeds physical 2.0 vCPU. Because Docker CPU limits represent scheduling quotas rather than pinned reservations, operational oversubscription is acceptable only if workloads are serialized and existing-site latency thresholds are enforced.
- **Agent Concurrency Safeguard:** Default `MAX_ACTIVE_AGENTS_PER_WORKSPACE=4` would add up to 4 CPU / 4 GiB. For this shared host, agent containers should be explicitly disabled or serialized (`MAX_ACTIVE_AGENTS_PER_WORKSPACE=0` or restricted).

---

## 4. Operator Verification Card (Pending Operator Execution on VPS & Cloudflare)

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
### Step 2.3 — Nameserver Delegation
- [ ] Change nameservers for `codepod.site` at Hostinger registrar to assigned Cloudflare nameservers.
- [ ] Verify `yourfitnature.com` nameservers are **NOT** changed.
- [ ] Cloudflare zone status: `Active`.

### Step 2.4 — Cloudflare Tunnel Creation
- [ ] Remotely managed tunnel created: `cloud-harness-codepod`
- [ ] Tunnel UUID: `________________________`
- [ ] Public hostname route: `mcp.codepod.site` -> `http://ingress:3100`
- [ ] Tunnel token stored securely in operator 0600 file (never committed or exposed).
- [ ] Outbound VPS probe: `nc -zv -w 5 region1.v2.argotunnel.com 7844` or equivalent exit 0.

### Step 2.5 — Cloudflare Access & Managed OAuth
- [ ] Access Application: Self-hosted, domain `mcp.codepod.site`
- [ ] Policy 1 (Human): Action `Allow`, rule restricted to operator email/IdP.
- [ ] Policy 2 (Canary): Action `Service Auth`, rule restricted to dedicated service token.
- [ ] Managed OAuth enabled with exact redirect URIs:
  - `https://chatgpt.com/connector/oauth/*`
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `https://chatgpt.com/api/aip/p/oauth/callback`
- [ ] ChatGPT Web: Developer Mode toggle and custom connector OAuth form verified.

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

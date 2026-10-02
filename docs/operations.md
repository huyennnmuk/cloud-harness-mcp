# Operations

## Health and service state

- `/healthz` proves the API process is serving HTTP.
- `/readyz` also checks runner reachability and returns 503 when the runner is
  unavailable.

On the VPS, inspect the service and the exact production Compose topology with:

```bash
sudo systemctl status cloud-harness-mcp.service
sudo journalctl -u cloud-harness-mcp.service --since "30 minutes ago"
sudo docker compose \
  -f /opt/cloud-harness-mcp/repo/compose.yaml \
  -f /opt/cloud-harness-mcp/repo/compose.production.yaml ps
curl --fail http://127.0.0.1:3100/readyz
```

The systemd and Compose owners are
[`deploy/systemd/cloud-harness-mcp.service`](../deploy/systemd/cloud-harness-mcp.service),
[`compose.yaml`](../compose.yaml), and
[`compose.production.yaml`](../compose.production.yaml).

## Persistent and ephemeral data

The production defaults place:

- SQLite workspace, principal, dashboard, GitHub binding, artifact metadata,
  and audit state at
  `/var/lib/cloud-harness/state/cloud-harness.db`;
- active workspace clones below `/var/lib/cloud-harness/jobs`;
- retained artifact payloads below `/var/lib/cloud-harness/artifacts`;
- release-time recovery sets below `/var/lib/cloud-harness/backups`; and
- runtime configuration, GitHub App key, and secret keyring below
  `/etc/cloud-harness-mcp`.

The database persists workspace and task metadata across runner restarts.
Interactive shell and session streams remain in-memory, while background tasks
and dependency graphs are durable in SQLite. Startup reconciles in-flight tasks
from prior process boots to `FAILED` with `error_code: "RUNNER_RESTARTED"` while
preserving completed task metadata and file logs.
Workspace clones are operational, TTL-bound data and are deleted on
close/expiry; they are not a durable source control remote or a backup.
The same state database also owns the stable random runner-instance identity
used to scope Docker reconciliation.

Metadata schema v2 adds principal-bound API-key hashes and safe lifecycle
metadata. A database backup therefore does not recover plaintext keys; clients
must keep their one-time value in a private credential store.

## Backup and restore

Every deployment validates the candidate SHA, ingress data, required files,
canary prerequisites, rollback storage, and recorded image IDs before stopping
the service. After quiescence and before checkout, build, or configuration
promotion, [`deploy/scripts/deploy-release.sh`](../deploy/scripts/deploy-release.sh)
creates one immutable versioned snapshot under
`/var/lib/cloud-harness/backups/`. Its checksummed manifest binds:

- the exact prior SHA, or an explicit `absent` first-install state;
- the complete `/etc/cloud-harness-mcp` configuration tree;
- the stopped state directory, including SQLite sidecars;
- the artifact payload archive; and
- every recorded local service image ID.

The first deployment that introduces this snapshot format seeds the
last-known-good configuration and complete image records from the still-running
release, then verifies their identity before downtime. Run that transition
before editing authentication or ingress configuration; later same-SHA
promotions snapshot the previously recorded healthy configuration rather than
the candidate files already staged under `/etc/cloud-harness-mcp`.

Only after archive and image validation succeeds is the snapshot published
atomically through `/var/lib/cloud-harness/rollback-current`. A successful
deployment does not rewrite that pointer to the new state. Retention preserves
the current rollback target plus five older exact snapshot directories.

Automatic rollback retains the snapshot created by that deployment and never
consults the mutable pointer. Manual
`/usr/local/sbin/cloud-harness-rollback` validates `rollback-current` and
restores it directly, including when its SHA equals the current SHA. Restore
replaces configuration, state, and artifacts while stopped, retags the exact
recorded image IDs, installs service assets from the snapshot SHA, starts the
unit, and requires readiness, image identity, and the restored authentication
canary. A failed validation or restore disables and stops the service instead
of serving mixed generations.

Treat each snapshot as one recovery unit. Do not combine its database, artifact
archive, configuration, keyring, or image records with another snapshot.
Active workspace checkouts remain TTL-bound and are excluded; close or finalize
them before a planned deployment when their contents matter.

If workspace content must be retained, commit changes and use `git_push` only
when the configured GitHub App has repository write access; verify the remote
result before closing. Otherwise export the required files before close. The
executor itself never receives a repository credential. Host-side archival
should be exceptional, performed only after stopping the exact verified
executor, and scoped to its opaque job directory.

## Secret key rotation

The keyring is versioned so encryption can move to a new active key without
losing decrypt access to older secret versions. Back up the coherent recovery
unit first. Add a new unique key version, make it active, retain every old key,
and restart with the complete runner-only keyring. Quiesce secret mutations,
keep the service or all write paths quiesced for the operation, then invoke the
one-off runner re-encryption entry point owned by
[`apps/runner/src/rekey-secrets.ts`](../apps/runner/src/rekey-secrets.ts) through
the `secrets:rekey` package script or its compiled runner command.

The command is interruptible and safe to resume; verify that it completes,
take a new coherent backup, and keep old decrypt keys through the release and
rollback window. Remove an old key only after source, database inspection, and
a restore rehearsal prove no retained ciphertext or rollback snapshot needs
that version. Do not run re-encryption from the API or expose key material in
command output.

## Cleanup

Normal cleanup is `workspace_close` or TTL expiry. It stops known
shell/session/task children, removes the named executor, deletes only the
verified job directory, and records the workspace as closed. Startup also
reconciles database, filesystem, and Docker inventories, scoped to the
configured runner instance.

Inspect managed containers before any manual action:

```bash
sudo docker ps -a --filter label=cloud-harness.managed=true \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "cloud-harness.workspace"}}'
```

Call `workspace_close` when the runner still owns the record. After a damaged
or unavailable runner, reconcile the container label and opaque workspace ID
against SQLite before removing an exact container or directory. Never delete
the jobs root recursively and never apply broad Docker cleanup on a shared
host.

Monitor free space because the workspace size setting is not a hard quota:

```bash
df -h /var/lib/cloud-harness
sudo du -sh /var/lib/cloud-harness/jobs/*
```

## Managed API-key lifecycle

Create, list, and revoke keys through the Access-authenticated dashboard. A key
cannot be recovered after its creation response. For planned replacement,
create a new key, update and canary the client against
`https://api.harness.zuey.me/mcp`, then revoke the old key and verify the next
request is rejected. For suspected disclosure, revoke first and inspect only
redacted audit/log metadata. Do not copy a key into shell history, URLs,
tickets, or shared logs.

### API-key schema rollback

Downgrading from metadata schema v2 to a binary that supports only v1 destroys
all managed API-key records by design. Quiesce dashboard and MCP writes, stop
the service, and take a coherent recovery backup before running the runner's
compiled migration command from the exact release checkout:

```bash
npm run metadata:down:v1 -w @cloud-harness/runner -- /path/to/db
```

Keep the database offline for the command. It requires version 2, drops only
the API-key table, and resets the metadata version to 1. Then deploy the prior
binary, keep `API_KEY_AUTH_ENABLED=false`, and canary readiness, OAuth,
dashboard, unrelated metadata, and the absence of the hidden route. Restore
the backup instead of retrying manually if the downgrade does not complete.

## MCP gateway schema rollback

A pre-v6 runner cannot start on a v6 ledger. Downgrading from metadata schema v6
to a pre-v6 runner destroys the MCP gateway registry by design. Quiesce dashboard
and MCP writes, stop the service, and take a coherent recovery backup before
running the runner's bounded downgrade from the exact release checkout:

```bash
npm run metadata:down:v5 -w @cloud-harness/runner -- /path/to/db
```

Keep the database offline for the command. It requires version 6, drops only the
four `mcp_gateway_*` tables (servers, cached tools, tool permissions, and
traces), and resets the metadata version to 5. Unlike `metadata:down:v1`, it does
not chain further down, so `api_keys`, `global_secret_references`,
`global_secret_versions`, and `secret_references.description` are preserved.
Then deploy the prior runner and canary readiness, the dashboard, unrelated
metadata, and the absence of the `/mcp-gateway` route. Restore-from-backup
remains the fallback instead of retrying a downgrade that does not complete.

## Release rollback

The automatic GitHub Actions deploy skips the semantic-release version commit
(`chore(release): … [skip ci]`) because the merged code is already live, so one
merge opens a single container-recreation window instead of two. Run **Deploy
production** manually (`workflow_dispatch`, optionally with an explicit
40-character commit SHA) to force a deploy.

An automatic deployment failure restores the deployment's newly created
pre-mutation snapshot: exact commit, configuration, stopped state, artifacts,
recorded images, readiness, and the canary selected by the restored auth mode.
The snapshot exists even for a same-SHA configuration promotion, so an
owner-bearer to Access change can return to the prior owner-bearer state without
inventing a different commit.

Recovery is fail-closed. If snapshot validation, restore, exact-image startup,
readiness, or canary verification fails, `contain_failed_release` disables and
stops `cloud-harness-mcp.service` and removes the managed Compose services.
Never start selected pieces manually after that outcome; preserve the failed
and rollback snapshots for diagnosis.

The shell `ERR` trap cannot recover an interrupted process after every signal.
If SSH or the deploy process disappears, inspect the service and snapshot
pointer, then run:

```bash
sudo /usr/local/sbin/cloud-harness-rollback
```

That command restores `/var/lib/cloud-harness/rollback-current` directly. It
does not run a new deployment, create another snapshot, or derive a target from
`release-previous`. To deploy a different known-good commit instead, use its
exact 40-character SHA with `/usr/local/sbin/cloud-harness-deploy`; this is a
new deployment and therefore creates a new pre-mutation snapshot.

Always verify loopback readiness, the public authentication canary, dashboard
secret readiness, artifacts, and managed-container cleanup after rollback.

## Owner-Authorized Real-Provider Canary Runbook (Subagents)

To verify live provider connectivity and obtain the operational receipts required for closing Issue #19, execute a bounded canary on isolated staging before general use.

### 1. Preflight and authorization

- Verify exact release SHA, image digests, and staging deployment status.
- Prepare a disposable test repository (no private secrets, PII, or customer data).
- Ensure the workspace uses `networkProfile: "network-none"`.
- Create an encrypted provider credential and activate a dashboard-managed
  profile with `maxCostMicros: 500000` (approximately $0.50 maximum). Confirm
  Model Gateway acknowledges the dynamic snapshot; do not add a static profile
  or provider-key mount.

### 2. Execution protocol

1. **Spawn & Idempotency:** Call `agent_spawn` with the disposable workspace and curated test prompt. Replay the same idempotency key 3 times; verify identical `agentId` returned, `replayed: true` on subsequent calls, and exactly 1 container/lease created.
2. **Live Execution & Paging:** Call `agent_status` by `agentId` and `idempotencyKey`. Stream and page `agent_logs` via byte cursors. Verify all sensitive tokens/canaries are redacted.
3. **Steering & Cancellation:** Send an `agent_message` (`steer` or `followUp`). Test `agent_cancel`; verify post-order cascading cancellation of any child subagents and exact `Revoke -> Drain -> TERM/KILL -> Remove` order.
4. **Failure & Restart Resilience:** Exercise a controlled runner restart with an active agent; confirm status reconciles to `INTERRUPTED` with `outcomeUnknown: true` without auto-replaying unverified side effects.
5. **Closure & Zero Residual:** Call `workspace_close`. Confirm `docker ps -a` and `docker network ls` show 0 residual agent containers and networks, Model Gateway shows 0 active leases, and workspace directories are deleted only after barrier completion.

### 3. Sign-off and receipts

Record the test evidence (image digests, execution trace, token/cost reconciliation, and zero-residual confirmation) in the tracking issue before signing off on full operational readiness.

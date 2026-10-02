---
phase: 5
title: "GitHub App private-repository binding"
status: pending
priority: P1
effort: "1.5h"
dependencies: [4]
---

# Phase 5: GitHub App private-repository binding

## Goal

Bind a least-privilege GitHub App to a disposable private repository so Phase 6
can prove credential-isolated clone and transactional push without touching
production source.

## Context Links

- [Plan](./plan.md)
- [`docs/github-app-private-repositories.md`](../../docs/github-app-private-repositories.md)
- [`docs-site/dashboard/github.md`](../../docs-site/dashboard/github.md)
- [`docs/security-model.md`](../../docs/security-model.md)

## Requirements

- Access dashboard login and same-SHA deploy/rollback pass.
- Use a dedicated private repository, `cloud-harness-acceptance`, with an initial
  default branch.
- GitHub App permission is only repository Contents: Read and write.
- Workflows, Administration, organization, and user permissions remain off.
- The installation selects only the disposable repository.
- Private key travels through secure file transfer and is mounted only to runner.

## Architecture

The runner holds the App private key and mints short-lived repository-scoped
tokens. Git transfer helpers consume them over stdin. Executor, checkout, remote
URL, ChatGPT, logs, and evidence remain credential-free. In Access mode the
installation binding is qualified by the authenticated principal.

## Files / Resources to Create or Modify

- GitHub private repository `cloud-harness-acceptance`
- GitHub App and installation restricted to that repository
- `/etc/cloud-harness-mcp/github-app-private-key.pem`, root `0600`
- `runtime.env`: App ID, slug, and runner mount path; no installation ID
- Principal binding in dashboard Integrations
- Sanitized rollout evidence

## Tasks & Steps

### Task 5.1 — Create disposable repository and least-privilege App

- **Goal:** Bound every acceptance mutation to a repository with no production
  consequence.
- **Steps:**
  1. Create private repository `cloud-harness-acceptance` with an initial README
     and default branch.
  2. Create a GitHub App with Setup URL
     `https://mcp.codepod.site/dashboard/github`; enable Redirect on update.
  3. Disable webhook delivery.
  4. Grant only Repository permissions → Contents: Read and write.
  5. Install with **Only select repositories** and select exactly the disposable
     repository.
  6. Generate/download one private key. Do not display or paste it.
  7. Record non-secret App ID, slug, account, installation ID, and repository
     name for reconciliation; never record the key.
- **Success criteria:** Installation can mutate only the disposable repository
  and has no workflow/default-branch administration authority.
- **Verify:** GitHub settings show exact permission and one selected repository;
  webhook is inactive. Save only sanitized evidence.

### Task 5.2 — Install runner-only key material

- **Goal:** Configure the App without exposing its key to API, executor, logs,
  repository, or temporary storage after installation.
- **Steps:**
  1. Transfer the PEM over SFTP/SCP to a root-readable temporary path.
  2. Install it as root `0600` at
     `/etc/cloud-harness-mcp/github-app-private-key.pem`.
  3. Validate private-key type using a no-output OpenSSL check; never print PEM
     content or fingerprint unless the operator explicitly records a safe
     public-key fingerprint.
  4. Delete the exact temporary upload and verify it no longer exists.
  5. Add `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and
     `GITHUB_APP_PRIVATE_KEY_FILE=/run/cloud-harness-secrets/github-app-private-key.pem`
     with `sudoedit`.
  6. Ensure `GITHUB_APP_INSTALLATION_ID` is absent in Access mode.
- **Success criteria:** One root-only installed key exists, temporary copy is
  gone, runtime keys occur once, and no secret output is produced.
- **Verify:** `stat`, no-output OpenSSL validation, exact key-name/count checks,
  and absence of the temporary path all pass.

### Task 5.3 — Deploy App configuration through protected same-SHA path

- **Goal:** Preserve rollback and canary guarantees for this configuration-only
  promotion.
- **Steps:**
  1. Confirm no active workspace and all shared-host gates are green.
  2. Deploy the same `RELEASE_SHA` once.
  3. Require a pre-mutation rollback snapshot, public Service Auth canary, exact
     image verification, and unchanged nginx hash.
  4. Inspect mounts structurally: runner receives the secret directory; API,
     ingress, model gateway, cloudflared, and executor do not receive the PEM.
- **Success criteria:** Runner is healthy with App config; Access canary passes;
  key mount remains runner-only; existing sites are unchanged.
- **Verify:** Same-SHA deploy exits 0. A non-secret container-mount projection
  proves the boundary; do not run `docker inspect` formats that print environment
  values.

### Task 5.4 — Bind installation to the Access principal

- **Goal:** Authorize the exact human principal used by ChatGPT.
- **Steps:**
  1. Sign in to the dashboard with the same Access identity intended for
     ChatGPT.
  2. Open Integrations and select Connect GitHub App.
  3. Leave Expected account ID empty unless an exact restriction is intended;
     complete GitHub authorization.
  4. Run dashboard installation/repository reconciliation.
  5. Confirm status `ACTIVE` and exactly `cloud-harness-acceptance` is authorized.
  6. Do not claim MCP `workspace_capabilities` evidence before the ChatGPT
     connector exists. Phase 6 proves actual private clone/push behavior.
- **Success criteria:** One principal-qualified active binding resolves to the
  one disposable repository.
- **Verify:** Dashboard reconciliation shows `ACTIVE`, expected account, and the
  exact repository list. No token or key is returned or recorded.

## Todo

- [ ] Task 5.1 — Create disposable repository and least-privilege App.
- [ ] Task 5.2 — Install runner-only key material.
- [ ] Task 5.3 — Deploy App configuration through protected same-SHA path.
- [ ] Task 5.4 — Bind installation to the Access principal.

## Risk Assessment

- Selecting all repositories or granting Workflows expands blast radius; stop
  and correct before key installation.
- A leaked App key requires revocation, a new key, replacement of the installed
  file, and a same-SHA deploy before testing resumes.
- Principal mismatch makes the binding unavailable to ChatGPT even when the App
  installation itself is healthy.

## Security Considerations

Never inspect PEM content. Verification is limited to file metadata, no-output
cryptographic parsing, runtime key names, runner-only mounts, and GitHub
installation metadata.

## Failure Protocol

If any Verify step fails, STOP the phase. Spawn `kongming` with the phase/task,
failed command, output, and expected condition. Apply guidance and rerun. If
unavailable, report evidence and do not continue.

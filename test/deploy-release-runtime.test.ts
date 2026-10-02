import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runtime = join(process.cwd(), 'deploy/scripts/release-runtime.sh');
const deployScript = join(process.cwd(), 'deploy/scripts/deploy-release.sh');
const releaseSha = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;
const imageNames = ['api', 'runner', 'executor', 'network-guard', 'agent', 'model-gateway'];

function runRuntime(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\nshift\n${body}`, 'bash', runtime, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function resolveFixture(content?: string, symlink = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ingress-'));
  const path = join(directory, 'ingress.conf');
  if (content !== undefined) {
    const target = join(directory, 'target');
    writeFileSync(target, content);
    if (symlink) symlinkSync(target, path);
    else writeFileSync(path, content);
  }
  return runRuntime('resolve_ingress_mode "$1"', [path]);
}

function runQuiescence(functionName: 'stop_release' | 'contain_failed_release', options: {
  stopFails?: boolean;
  composeDownFails?: boolean;
  unitActive?: boolean;
  activeQueryFails?: boolean;
  containersRemain?: boolean;
  composePsFails?: boolean;
}) {
  const script = `
source "$1"
systemctl() {
  if [[ $1 == stop || $1 == disable ]]; then ${options.stopFails ? 'return 1' : 'return 0'}; fi
  ${options.activeQueryFails ? 'return 4' : options.unitActive ? 'return 0' : 'return 3'}
}
compose() {
  if [[ $1 == down ]]; then ${options.composeDownFails ? 'return 1' : 'return 0'}; fi
  ${options.composePsFails ? 'return 1' : ':'}
  ${options.containersRemain ? 'echo live-container' : ':'}
}
${functionName}
`;
  return spawnSync('bash', ['-c', script, 'bash', runtime], { encoding: 'utf8' }).status;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

describe.skipIf(process.platform === 'win32')('release deployment safety', () => {
  it('strictly resolves missing and explicit ingress modes as data', () => {
    expect(resolveFixture().stdout.trim()).toBe('legacy-managed-nginx');
    for (const mode of ['tunnel', 'caddy', 'custom']) {
      const result = resolveFixture(`# owner-selected ingress\nINGRESS_MODE=${mode}\n`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(mode);
    }
  });

  it.each([
    ['duplicate assignment', 'INGRESS_MODE=tunnel\nINGRESS_MODE=custom\n'],
    ['unknown key', 'OTHER=value\n'],
    ['shell syntax', 'INGRESS_MODE=$(touch /tmp/never)\n'],
    ['unknown mode', 'INGRESS_MODE=nginx\n'],
    ['missing assignment', '# comments only\n']
  ])('rejects malformed ingress: %s', (_label, content) => {
    expect(resolveFixture(content).status).not.toBe(0);
  });

  it('rejects a symlinked ingress configuration', () => {
    expect(resolveFixture('INGRESS_MODE=tunnel\n', true).status).not.toBe(0);
  });

  it('runs the nginx upgrader only for legacy managed nginx', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-ingress-prepare-'));
    mkdirSync(join(directory, 'deploy/scripts'), { recursive: true });
    writeExecutable(join(directory, 'deploy/scripts/upgrade-nginx-dashboard.sh'), '#!/usr/bin/env bash\nprintf "upgrade\\n" >> "$TRACE"\n');
    const script = `
set -euo pipefail
cd "$2"
source "$1"
prepare_access_ingress legacy-managed-nginx
prepare_access_ingress tunnel
prepare_access_ingress caddy
prepare_access_ingress custom
`;
    const trace = join(directory, 'trace');
    const result = spawnSync('bash', ['-c', script, 'bash', runtime, directory], {
      encoding: 'utf8', env: { ...process.env, TRACE: trace }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8')).toBe('upgrade\n');
  });

  it('passes a Tunnel token only by protected file path and emits no token bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-tunnel-wrapper-'));
    const config = join(directory, 'config');
    const state = join(directory, 'state');
    const bin = join(directory, 'bin');
    const trace = join(directory, 'trace');
    const token = 'disposable-tunnel-token-sentinel';
    mkdirSync(config);
    mkdirSync(state);
    mkdirSync(bin);
    writeFileSync(join(config, 'ingress.conf'), 'INGRESS_MODE=tunnel\n');
    writeFileSync(join(config, 'cloudflare-tunnel-token'), `${token}\n`, { mode: 0o640 });
    writeFileSync(join(config, 'runtime.env'), 'AUTH_MODE=owner-bearer\n');
    writeExecutable(join(bin, 'stat'), `#!/usr/bin/env bash
format=$2
path="\${!#}"
if [[ $format == '%u:%g:%a' ]]; then printf '0:0:700\\n'; exit 0; fi
size=$(/usr/bin/stat -c %s -- "$path")
printf '0:65534:640:%s\\n' "$size"
`);
    writeExecutable(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s|%s\\n' "$CLOUD_HARNESS_CONFIG_DIR" "$*" >> "$TRACE"
printf '{"services":{"cloudflared":{"command":["tunnel","--no-autoupdate","run","--token-file","/run/secrets/cloudflare-tunnel-token"]}}}\\n'
`);
    const result = runRuntime(`
config_root="$1"
state="$2"
env_file="$config_root/runtime.env"
resolved_ingress_mode=tunnel
compose config --format json
`, [config, state], { PATH: `${bin}:${process.env.PATH}`, TRACE: trace });
    const captured = `${result.stdout}${result.stderr}${readFileSync(trace, 'utf8')}`;
    expect(result.status, result.stderr).toBe(0);
    expect(captured).not.toContain(token);
    expect(readFileSync(trace, 'utf8')).toContain(`${config}|compose -f compose.yaml -f compose.production.yaml -f deploy/cloudflare-tunnel/compose.tunnel.yaml config --format json`);
  });

  it('runs the Access canary for Tunnel ingress without loading the Tunnel overlay or nginx tooling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-tunnel-canary-'));
    const config = join(directory, 'config');
    const state = join(directory, 'state');
    const bin = join(directory, 'bin');
    const trace = join(directory, 'trace');
    mkdirSync(config);
    mkdirSync(state);
    mkdirSync(bin);
    writeFileSync(join(config, 'runtime.env'), 'AUTH_MODE=cloudflare-access\n');
    writeFileSync(join(config, 'canary-credentials'), [
      'MCP_CANARY_URL=https://mcp.example.test/mcp',
      'MCP_CANARY_ACCESS_CLIENT_ID=disposable-client-id',
      'MCP_CANARY_ACCESS_CLIENT_SECRET=disposable-client-secret',
      ''
    ].join('\n'));
    writeExecutable(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TRACE"\n');
    const result = runRuntime(`
config_root="$1"
state="$2"
env_file="$config_root/runtime.env"
canary_credentials_file="$config_root/canary-credentials"
run_release_canary tunnel
`, [config, state], { PATH: `${bin}:${process.env.PATH}`, TRACE: trace });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8')).toContain('compose -f compose.yaml -f compose.production.yaml run --rm --no-deps');
    expect(readFileSync(trace, 'utf8')).not.toContain('compose.tunnel.yaml');
    expect(`${result.stdout}${result.stderr}${readFileSync(trace, 'utf8')}`).not.toContain('disposable-client-secret');
  });

  it('fails malformed ingress before stop, backup, build, or service mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-preflight-'));
    const bin = join(directory, 'bin');
    const config = join(directory, 'config');
    const state = join(directory, 'state');
    const trace = join(directory, 'trace');
    mkdirSync(bin);
    mkdirSync(config);
    writeFileSync(join(config, 'runtime.env'), 'AUTH_MODE=owner-bearer\nMCP_BEARER_TOKEN=disposable-owner-token\n', { mode: 0o600 });
    writeFileSync(join(config, 'ingress.conf'), 'INGRESS_MODE=$(false)\n', { mode: 0o600 });
    writeExecutable(join(bin, 'git'), `#!/usr/bin/env bash
if [[ $1 == remote && $2 == get-url ]]; then echo https://github.com/bestagentkits/cloud-harness-mcp.git; exit 0; fi
if [[ $1 == archive ]]; then exec /usr/bin/tar -C "$SOURCE" -cf - compose.yaml compose.production.yaml deploy/cloudflare-tunnel/compose.tunnel.yaml deploy/scripts/deploy-release.sh deploy/scripts/release-runtime.sh deploy/scripts/rollback-release.sh deploy/scripts/service-compose.sh deploy/scripts/setup-dependency-firewall.sh deploy/scripts/reconcile-dependency-egress.sh deploy/systemd/cloud-harness-mcp.service; fi
exit 0
`);
    writeExecutable(join(bin, 'install'), `#!/usr/bin/env bash
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|-g|-m) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"
`);
    for (const command of ['docker', 'systemctl']) {
      writeExecutable(join(bin, command), `#!/usr/bin/env bash\nprintf '${command}:%s\\n' "$*" >> "$TRACE"\nexit 0\n`);
    }
    const result = spawnSync('bash', [deployScript, releaseSha], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TRACE: trace,
        SOURCE: process.cwd(),
        CLOUD_HARNESS_STATE_DIR: state,
        CLOUD_HARNESS_CONFIG_DIR: config,
        CLOUD_HARNESS_REPO_DIR: process.cwd()
      }
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(trace) ? readFileSync(trace, 'utf8') : '').toBe('');
    expect(existsSync(join(state, 'rollback-current'))).toBe(false);
  });

  it.each([
    ['systemd stop', { stopFails: true }],
    ['Compose down', { composeDownFails: true }],
    ['still-active systemd unit', { unitActive: true }],
    ['systemd state query', { activeQueryFails: true }],
    ['remaining managed container', { containersRemain: true }],
    ['Compose state query', { composePsFails: true }]
  ])('fails quiescence when %s fails', (_name, options) => {
    expect(runQuiescence('stop_release', options)).toBe(1);
    expect(runQuiescence('contain_failed_release', options)).toBe(1);
  });

  it('accepts quiescence only when the unit is inactive and no container remains', () => {
    expect(runQuiescence('stop_release', {})).toBe(0);
    expect(runQuiescence('contain_failed_release', {})).toBe(0);
  });

  it('creates, atomically publishes, validates, and restores a same-SHA coherent snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-snapshot-'));
    const state = join(directory, 'state-root');
    const config = join(directory, 'config');
    const bin = join(directory, 'bin');
    mkdirSync(join(state, 'state'), { recursive: true });
    mkdirSync(join(state, 'artifacts'), { recursive: true });
    mkdirSync(join(state, 'backups'), { recursive: true });
    mkdirSync(config);
    mkdirSync(join(state, 'release-config-current'));
    mkdirSync(bin);
    writeFileSync(join(config, 'mode'), 'owner-bearer');
    writeFileSync(join(state, 'state/database'), 'state-before');
    writeFileSync(join(state, 'artifacts/payload'), 'artifact-before');
    writeFileSync(join(state, 'release-config-current/mode'), 'owner-bearer');
    for (const name of imageNames) writeFileSync(join(state, `release-${name}-image`), `${imageId}\n`);
    writeExecutable(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n');

    const result = runRuntime(`
state="$1"
config_root="$2"
snapshot="$state/backups/cloud-harness-test"
create_snapshot "$snapshot" "$3"
publish_rollback_snapshot "$snapshot"
printf changed > "$config_root/mode"
printf changed > "$state/state/database"
printf changed > "$state/artifacts/payload"
restore_snapshot "$snapshot"
printf '%s|%s|%s|%s' "$(cat "$config_root/mode")" "$(cat "$state/state/database")" "$(cat "$state/artifacts/payload")" "$(resolve_rollback_snapshot)"
`, [state, config, releaseSha], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`owner-bearer|state-before|artifact-before|${state}/backups/cloud-harness-test`);
  });

  it('rejects a corrupt rollback snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-corrupt-snapshot-'));
    const state = join(directory, 'state-root');
    const config = join(directory, 'config');
    const bin = join(directory, 'bin');
    mkdirSync(join(state, 'state'), { recursive: true });
    mkdirSync(join(state, 'artifacts'), { recursive: true });
    mkdirSync(join(state, 'backups'), { recursive: true });
    mkdirSync(join(state, 'release-config-current'));
    mkdirSync(config);
    mkdirSync(bin);
    writeFileSync(join(config, 'mode'), 'owner-bearer');
    writeFileSync(join(state, 'release-config-current/mode'), 'owner-bearer');
    for (const name of imageNames) writeFileSync(join(state, `release-${name}-image`), `${imageId}\n`);
    writeExecutable(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
    const result = runRuntime(`
state="$1"
config_root="$2"
snapshot="$state/backups/cloud-harness-test"
create_snapshot "$snapshot" "$3"
printf corrupt >> "$snapshot/config.tar"
if validate_snapshot "$snapshot"; then exit 9; fi
`, [state, config, releaseSha], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status, result.stderr).toBe(0);
  });

  it('restores snapshot state and exact images before start, readiness, and canary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-rollback-order-'));
    const trace = join(directory, 'trace');
    const script = `
set -euo pipefail
source "$1"
CLOUD_HARNESS_ROLLBACK_RELOAD_RUNTIME=false
state="$2"
config_root=/config
env_file=/config/runtime.env
canary_credentials_file=/config/canary
trace="$3"
prior_sha="$4"
validate_snapshot() { echo validate >> "$trace"; }
snapshot_manifest_value() { [[ $2 == kind ]] && echo release || echo "$prior_sha"; }
stop_release() { echo stop >> "$trace"; }
git() { echo "git:$*" >> "$trace"; }
install_release_service_files() { echo service-files >> "$trace"; }
restore_snapshot() { echo restore >> "$trace"; }
restore_snapshot_images() { echo images >> "$trace"; }
resolve_ingress_mode() { echo custom; }
systemctl() { echo "systemctl:$*" >> "$trace"; }
wait_ready() { echo ready >> "$trace"; }
verify_running_images() { echo verify >> "$trace"; }
run_release_canary() { echo "canary:$1" >> "$trace"; }
record_release_generation() { echo "generation:$1" >> "$trace"; }
rollback_to_snapshot /snapshot
`;
    mkdirSync(directory, { recursive: true });
    const result = spawnSync('bash', ['-c', script, 'bash', runtime, directory, trace, releaseSha], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      'validate',
      'stop',
      `git:checkout --detach --force ${releaseSha}`,
      'git:status --porcelain --untracked-files=all',
      'service-files',
      'restore',
      'images',
      'systemctl:enable --now cloud-harness-mcp.service',
      'ready',
      'verify',
      'canary:custom',
      `generation:${releaseSha}`
    ]);
  });

  it('automatically restores the deployment snapshot when the Access canary fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-canary-rollback-'));
    const trace = join(directory, 'trace');
    const script = `
set -u
source "$1"
trace="$3"
backup_dir=/snapshot
previous_sha="$2"
run_release_canary() { echo canary >> "$trace"; return 17; }
rollback_to_snapshot() { echo "restore:$1" >> "$trace"; }
contain_failed_release() { echo contain >> "$trace"; }
trap rollback ERR
run_release_canary tunnel
`;
    const result = spawnSync('bash', ['-c', script, 'bash', runtime, releaseSha, trace], { encoding: 'utf8' });
    expect(result.status).toBe(17);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['canary', 'restore:/snapshot']);
  });

  it('contains the service when automatic snapshot restoration fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-rollback-contain-'));
    const trace = join(directory, 'trace');
    const script = `
set -u
source "$1"
trace="$3"
backup_dir=/snapshot
previous_sha="$2"
rollback_to_snapshot() { echo restore >> "$trace"; return 1; }
contain_failed_release() { echo contain >> "$trace"; }
(false; rollback)
`;
    const result = spawnSync('bash', ['-c', script, 'bash', runtime, releaseSha, trace], { encoding: 'utf8' });
    expect(result.status).toBe(70);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['restore', 'contain']);
  });
});

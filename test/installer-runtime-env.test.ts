import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installer = join(process.cwd(), 'scripts/install.sh');

function runLibrary(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nexport CLOUD_HARNESS_INSTALLER_LIBRARY_ONLY=true\nsource "$1"\nshift\n${body}`, 'bash', installer, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe.skipIf(process.platform === 'win32')('installer release and secret safety', () => {
  it('accepts only a regular, absolute, single-line Tunnel token source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-token-source-'));
    const valid = join(directory, 'valid');
    const multiline = join(directory, 'multiline');
    const symlink = join(directory, 'link');
    writeFileSync(valid, 'disposable-token-value\n', { mode: 0o600 });
    writeFileSync(multiline, 'first\nsecond\n', { mode: 0o600 });
    symlinkSync(valid, symlink);

    expect(runLibrary('validate_tunnel_token_source "$1"', [valid]).status).toBe(0);
    expect(runLibrary('validate_tunnel_token_source "$1"', [multiline]).status).not.toBe(0);
    expect(runLibrary('validate_tunnel_token_source "$1"', [symlink]).status).not.toBe(0);
    expect(runLibrary('validate_tunnel_token_source relative-token', []).status).not.toBe(0);
  });

  it('rejects token values in argv and validates a supplied release SHA before mutation', () => {
    const rejectedToken = runLibrary('parse_args "$@"', ['--tunnel-token', 'disposable-token-value']);
    expect(rejectedToken.status).not.toBe(0);
    expect(`${rejectedToken.stdout}${rejectedToken.stderr}`).not.toContain('disposable-token-value');

    const rejectedSha = runLibrary('parse_args "$@"', ['--release-sha', 'abc']);
    expect(rejectedSha.status).not.toBe(0);
    expect(rejectedSha.stderr).toContain('40 lowercase hexadecimal');
  });

  it('requires a Tunnel token source in non-interactive mode', () => {
    const result = runLibrary(`
INGRESS_MODE=tunnel
DOMAIN=mcp.example.test
NON_INTERACTIVE=true
TUNNEL_TOKEN_FILE=''
TUNNEL_TOKEN=''
resolve_ingress_inputs
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--tunnel-token-file');
  });

  it('installs the Tunnel token with mode 0640 without exposing its bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-token-install-'));
    const config = join(directory, 'config');
    const bin = join(directory, 'bin');
    const source = join(directory, 'token-source');
    const trace = join(directory, 'trace');
    const sentinel = 'disposable-tunnel-secret-value';
    mkdirSync(config);
    mkdirSync(bin);
    writeFileSync(source, `${sentinel}\n`, { mode: 0o600 });
    writeFileSync(join(bin, 'install'), `#!/usr/bin/env bash
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"
`, { mode: 0o755 });
    writeFileSync(join(bin, 'chown'), '#!/usr/bin/env bash\nprintf "chown:%s\\n" "$*" >> "$TRACE"\n', { mode: 0o755 });

    const result = runLibrary(`
CONFIG_DIR="$1"
INGRESS_MODE=tunnel
TUNNEL_TOKEN_FILE="$2"
TUNNEL_TOKEN=''
configure_ingress
`, [config, source], { PATH: `${bin}:${process.env.PATH}`, TRACE: trace });
    const installed = join(config, 'cloudflare-tunnel-token');
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}${readFileSync(trace, 'utf8')}`).not.toContain(sentinel);
    expect(readFileSync(installed, 'utf8')).toBe(`${sentinel}\n`);
    expect(statSync(installed).mode & 0o777).toBe(0o640);
    expect(readFileSync(trace, 'utf8')).toContain(`chown:0:65534 ${installed}`);
  });

  it('generates and migrates runtime configuration to WORKSPACE_NETWORK_PROFILE', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-runtime-env-'));
    const generated = runLibrary(`
CONFIG_DIR="$1/generated"
DOMAIN=''
mkdir -p "$CONFIG_DIR"
bootstrap_secrets
cat "$CONFIG_DIR/runtime.env"
`, [directory]);
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stdout).toContain('WORKSPACE_NETWORK_PROFILE=network-none');
    expect(generated.stdout).not.toContain('WORKSPACE_NETWORK_MODE=');

    const existing = join(directory, 'existing');
    execFileSync('mkdir', ['-p', existing]);
    writeFileSync(join(existing, 'runtime.env'), 'AUTH_MODE=owner-bearer\nWORKSPACE_NETWORK_MODE=none\n', { mode: 0o600 });
    writeFileSync(join(existing, 'secret-keyring.json'), '{}\n', { mode: 0o600 });
    const migrated = runLibrary(`
CONFIG_DIR="$1/existing"
DOMAIN=''
bootstrap_secrets
cat "$CONFIG_DIR/runtime.env"
`, [directory]);
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain('WORKSPACE_NETWORK_PROFILE=network-none');
    expect(migrated.stdout).not.toContain('WORKSPACE_NETWORK_MODE=');
  });

  it('installs bytes from the exact selected commit, not the newer main checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-installer-sha-'));
    const source = join(directory, 'source');
    const remote = join(directory, 'remote.git');
    const checkout = join(directory, 'checkout');
    execFileSync('mkdir', ['-p', source]);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Installer Test');
    git(source, 'config', 'user.email', 'installer@example.invalid');
    writeFileSync(join(source, 'selected.txt'), 'reviewed\n');
    git(source, 'add', 'selected.txt');
    git(source, 'commit', '-m', 'reviewed');
    const selected = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'selected.txt'), 'newer-main\n');
    git(source, 'commit', '-am', 'newer');
    execFileSync('git', ['clone', '--bare', source, remote], { encoding: 'utf8' });

    const result = runLibrary(`
PROJECT_ORIGIN="$1"
REPO_DIR="$2"
RELEASE_SHA="$3"
checkout_repository
printf '%s|' "$(git rev-parse HEAD)"
cat selected.txt
`, [remote, checkout, selected]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${selected}|reviewed`);
    expect(readFileSync(join(checkout, 'selected.txt'), 'utf8')).toBe('reviewed\n');
  });

  it('stores owner credentials only in the root client file and prints only its path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-client-config-'));
    const sentinel = 'disposable-owner-secret-value';
    writeFileSync(join(directory, 'runtime.env'), `MCP_BEARER_TOKEN=${sentinel}\n`, { mode: 0o600 });
    const result = runLibrary(`
CONFIG_DIR="$1"
DOMAIN='mcp.example.com'
output_client_configuration
`, [directory]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stdout).toContain(join(directory, 'client-config.json'));
    expect(readFileSync(join(directory, 'client-config.json'), 'utf8')).toContain(sentinel);
  });
});

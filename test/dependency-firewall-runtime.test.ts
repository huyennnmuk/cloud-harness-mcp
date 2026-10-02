import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const reconcile = join(process.cwd(), 'deploy/scripts/reconcile-dependency-egress.sh');
const setup = join(process.cwd(), 'deploy/scripts/setup-dependency-firewall.sh');

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('dependency egress service lifecycle', () => {
  it('performs no Docker or firewall mutation for network-none', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-network-none-'));
    const envFile = join(directory, 'runtime.env');
    const bin = join(directory, 'bin');
    const trace = join(directory, 'trace');
    mkdirSync(bin);
    writeFileSync(envFile, 'AUTH_MODE=owner-bearer\nWORKSPACE_NETWORK_PROFILE=network-none\n');
    for (const command of ['docker', 'iptables', 'iptables-restore', 'iptables-save']) {
      executable(join(bin, command), `#!/usr/bin/env bash\nprintf '${command}:%s\\n' "$*" >> "$TRACE"\nexit 99\n`);
    }
    const result = spawnSync('bash', [reconcile, envFile], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(trace) ? readFileSync(trace, 'utf8') : '').toBe('');
  });

  it('rejects retired or duplicate profile keys before calling the helper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-network-config-'));
    const helper = join(directory, 'helper');
    const trace = join(directory, 'trace');
    executable(helper, '#!/usr/bin/env bash\nprintf called >> "$TRACE"\n');
    for (const [name, content] of [
      ['retired', 'WORKSPACE_NETWORK_MODE=none\nWORKSPACE_NETWORK_PROFILE=network-none\n'],
      ['duplicate', 'WORKSPACE_NETWORK_PROFILE=network-none\nWORKSPACE_NETWORK_PROFILE=dependency-access\n']
    ]) {
      const envFile = join(directory, name);
      writeFileSync(envFile, content);
      const result = spawnSync('bash', [reconcile, envFile], {
        encoding: 'utf8', env: { ...process.env, CLOUD_HARNESS_FIREWALL_HELPER: helper, TRACE: trace }
      });
      expect(result.status).not.toBe(0);
    }
    expect(existsSync(trace) ? readFileSync(trace, 'utf8') : '').toBe('');
  });

  it('exports customized DEPENDENCY_* variables to the firewall helper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-network-custom-'));
    const envFile = join(directory, 'runtime.env');
    const helper = join(directory, 'helper');
    const trace = join(directory, 'trace');
    writeFileSync(envFile, [
      'WORKSPACE_NETWORK_PROFILE=dependency-access',
      'DEPENDENCY_NETWORK_NAME=custom-chm-net',
      'DEPENDENCY_BRIDGE_INTERFACE=chmcustom0',
      'DEPENDENCY_BRIDGE_SUBNET=172.30.250.0/24',
      'DEPENDENCY_DNS_RESOLVERS=9.9.9.9 149.112.112.112',
      ''
    ].join('\n'));
    executable(helper, '#!/usr/bin/env bash\nprintf "%s|%s|%s|%s\\n" "$DEPENDENCY_NETWORK_NAME" "$DEPENDENCY_BRIDGE_INTERFACE" "$DEPENDENCY_BRIDGE_SUBNET" "$DEPENDENCY_DNS_RESOLVERS" >> "$TRACE"\nexit 0\n');
    const result = spawnSync('bash', [reconcile, envFile], {
      encoding: 'utf8', env: { ...process.env, CLOUD_HARNESS_FIREWALL_HELPER: helper, TRACE: trace }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim()).toBe('custom-chm-net|chmcustom0|172.30.250.0/24|9.9.9.9 149.112.112.112');
  });

  it('fails service pre-start closed when reconciliation fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-network-failure-'));
    const envFile = join(directory, 'runtime.env');
    const helper = join(directory, 'helper');
    writeFileSync(envFile, 'WORKSPACE_NETWORK_PROFILE=dependency-access\n');
    executable(helper, '#!/usr/bin/env bash\nexit 23\n');
    const result = spawnSync('bash', [reconcile, envFile], {
      encoding: 'utf8', env: { ...process.env, CLOUD_HARNESS_FIREWALL_HELPER: helper }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEPENDENCY_EGRESS_UNAVAILABLE');
  });

  it('removes a newly created managed bridge when firewall application fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-firewall-restore-'));
    const bin = join(directory, 'bin');
    const trace = join(directory, 'trace');
    const network = join(directory, 'network-created');
    const failed = join(directory, 'failed-once');
    mkdirSync(bin);
    executable(join(bin, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n');
    executable(join(bin, 'docker'), `#!/usr/bin/env bash
if [[ $1 == network && $2 == inspect ]]; then [[ -f "$NETWORK" ]]; exit; fi
if [[ $1 == network && $2 == create ]]; then touch "$NETWORK"; echo create >> "$TRACE"; exit 0; fi
if [[ $1 == network && $2 == rm ]]; then rm -f "$NETWORK"; echo remove >> "$TRACE"; exit 0; fi
exit 1
`);
    executable(join(bin, 'iptables-save'), '#!/usr/bin/env bash\nexit 0\n');
    executable(join(bin, 'iptables'), '#!/usr/bin/env bash\nexit 0\n');
    executable(join(bin, 'iptables-restore'), `#!/usr/bin/env bash
cat >/dev/null
if [[ "$*" == *--noflush* && ! -f "$FAILED" ]]; then touch "$FAILED"; exit 41; fi
exit 0
`);
    const result = spawnSync('bash', [setup], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TRACE: trace,
        NETWORK: network,
        FAILED: failed,
        DEPENDENCY_NETWORK_NAME: 'cloud-harness-test-egress',
        DEPENDENCY_BRIDGE_INTERFACE: 'chmtest0',
        DEPENDENCY_BRIDGE_SUBNET: '172.30.241.0/24'
      }
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['create', 'remove']);
    expect(existsSync(network)).toBe(false);
    expect(result.stderr).toContain('prior managed policy restored');
  });
});

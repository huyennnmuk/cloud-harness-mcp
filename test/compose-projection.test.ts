import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projector = join(process.cwd(), 'scripts/project-compose-config.mjs');

describe('Compose diagnostic projection', () => {
  it('retains boundary metadata while structurally omitting credential values', () => {
    const sentinel = 'disposable-compose-secret-value';
    const source = {
      services: {
        gateway: {
          image: 'example/gateway@sha256:abc',
          command: ['run', '--token-file', '/run/secrets/token', `--credential=${sentinel}`],
          environment: {
            MODEL_GATEWAY_MODE: 'production',
            MODEL_GATEWAY_DYNAMIC_MODE: 'true',
            PROVIDER_API_KEY: sentinel
          },
          networks: { egress: null },
          ports: [{ host_ip: '127.0.0.1', target: 3100, published: '3100', protocol: 'tcp' }],
          volumes: [{ type: 'bind', source: '/etc/example/token', target: '/run/secrets/token', read_only: true }]
        }
      },
      networks: { egress: { internal: false } }
    };
    const result = spawnSync(process.execPath, [projector], {
      input: JSON.stringify(source),
      encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(sentinel);
    expect(JSON.parse(result.stdout)).toMatchObject({
      services: {
        gateway: {
          commandArgumentCount: 4,
          commandFlags: ['--token-file', '--credential'],
          environmentNames: ['MODEL_GATEWAY_DYNAMIC_MODE', 'MODEL_GATEWAY_MODE', 'PROVIDER_API_KEY'],
          environmentValues: {
            MODEL_GATEWAY_DYNAMIC_MODE: 'true',
            MODEL_GATEWAY_MODE: 'production'
          },
          networks: ['egress'],
          volumes: [{ target: '/run/secrets/token', read_only: true }]
        }
      },
      networks: { egress: { internal: false } }
    });
  });
});

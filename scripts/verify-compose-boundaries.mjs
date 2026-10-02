import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

async function projectedComposeConfig(args) {
  const compose = spawn('docker', ['compose', ...args, 'config', '--format', 'json'], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_HARNESS_ENV_FILE: '.env.example' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const projector = spawn(process.execPath, ['scripts/project-compose-config.mjs'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  compose.stdout.pipe(projector.stdin);
  let composeError = '';
  let projection = '';
  let projectionError = '';
  compose.stderr.setEncoding('utf8').on('data', (chunk) => { composeError += chunk; });
  projector.stdout.setEncoding('utf8').on('data', (chunk) => { projection += chunk; });
  projector.stderr.setEncoding('utf8').on('data', (chunk) => { projectionError += chunk; });
  const exit = (child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const [composeStatus, projectorStatus] = await Promise.all([exit(compose), exit(projector)]);
  if (composeStatus !== 0 || projectorStatus !== 0) {
    throw new Error(composeError || projectionError || 'Compose projection failed');
  }
  return JSON.parse(projection);
}

const config = await projectedComposeConfig([
  '--profile', 'gateway-test', '-f', 'compose.yaml', '-f', 'compose.production.yaml'
]);
const services = config.services;
const networks = config.networks;
const requireBoundary = (condition, message) => {
  if (!condition) throw new Error(message);
};
const networkNames = (service) => service.networks ?? [];
const mountTargets = (service) => (service.volumes ?? []).map((mount) => mount.target).sort();
const environmentNames = (service) => service.environmentNames ?? [];
const sameNames = (actual, expected) => JSON.stringify(actual) === JSON.stringify([...expected].sort());
requireBoundary(!services.api.ports?.length, 'API must not publish a host port');
requireBoundary(!services.runner.ports?.length, 'runner must not publish a host port');
requireBoundary(!services.api.volumes?.length, 'API must not receive host mounts');
requireBoundary(!services.ingress.volumes?.length, 'ingress must not receive host mounts');
requireBoundary(JSON.stringify(networkNames(services.api)) === JSON.stringify(['api-egress', 'control', 'frontend']), 'API network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.runner)) === JSON.stringify(['control', 'runner-egress']), 'runner network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.ingress)) === JSON.stringify(['frontend', 'ingress']), 'ingress network boundary changed');
requireBoundary(JSON.stringify(networkNames(services['provisioning-proxy'])) === JSON.stringify(['provisioning', 'runner-egress']), 'provisioning-proxy network boundary changed');
requireBoundary(networks.control.internal === true && networks.frontend.internal === true && networks.provisioning.internal === true, 'private networks must remain internal');
requireBoundary(networks.ingress.internal !== true && networks['api-egress'].internal !== true && networks['runner-egress'].internal !== true && networks['provider-egress'].internal !== true, 'gateway networks must remain routable');

const gateway = services['model-gateway'];
requireBoundary(gateway.read_only === true, 'model gateway filesystem must be read-only');
requireBoundary(sameNames(networkNames(gateway), ['provider-egress']), 'model gateway may join only provider-egress statically');
requireBoundary(Object.entries(services).every(([name, service]) => name === 'model-gateway' || !networkNames(service).includes('provider-egress')), 'only model gateway may join provider-egress');
requireBoundary(sameNames(mountTargets(gateway), []), 'dynamic model gateway must not receive static profile or credential mounts');
requireBoundary(!(gateway.volumes ?? []).some((mount) => /docker\.sock|jobs|state|github|runner|control/u.test(`${mount.source}:${mount.target}`)), 'model gateway must not receive Docker, repository, job, state, runner, or control mounts');
requireBoundary(sameNames(environmentNames(gateway), [
  'MODEL_GATEWAY_CONTROL_SOCKET',
  'MODEL_GATEWAY_DYNAMIC_MODE',
  'MODEL_GATEWAY_HOST',
  'MODEL_GATEWAY_MODE',
  'MODEL_GATEWAY_PORT',
  'MODEL_GATEWAY_SESSION_HEADER'
]), 'model gateway environment allowlist changed');
requireBoundary(gateway.environmentValues.MODEL_GATEWAY_MODE === 'production', 'production gateway must force production profile validation');
requireBoundary(gateway.environmentValues.MODEL_GATEWAY_DYNAMIC_MODE === 'true', 'production gateway must start from an empty dynamic snapshot');

const staticAgentNetworks = Object.keys(networks).filter((name) => /agent/u.test(name) && name !== 'model-gateway-test-agent');
requireBoundary(staticAgentNetworks.length === 0, 'production agent workers require dynamic per-agent networks, not a shared static network');
const testGateway = services['model-gateway-test'];
const fakeProvider = services['fake-provider'];
requireBoundary(testGateway.profiles?.includes('gateway-test') && fakeProvider.profiles?.includes('gateway-test'), 'fake provider topology must remain behind the gateway-test profile');
requireBoundary(testGateway.environmentValues.MODEL_GATEWAY_MODE === 'test', 'test gateway must not masquerade as production');
requireBoundary(sameNames(networkNames(testGateway), ['model-gateway-test-agent', 'provider-egress-test']), 'test gateway topology changed');
requireBoundary(sameNames(networkNames(fakeProvider), ['provider-egress-test']), 'fake provider must be reachable only on test egress');
requireBoundary(networks['model-gateway-test-agent'].internal === true && networks['provider-egress-test'].internal === true, 'test topology networks must remain internal');
requireBoundary(!testGateway.ports?.length && !fakeProvider.ports?.length, 'test topology must not publish host ports');
requireBoundary(!(testGateway.volumes ?? []).some((mount) => mount.target.includes('/run/model-gateway-secrets/provider-api-key')), 'test topology must not mount the production provider secret');

const published = services.ingress.ports ?? [];
requireBoundary(published.length === 1, 'ingress must publish exactly one port');
requireBoundary(published[0].host_ip === '127.0.0.1' && Number(published[0].target) === 3100, 'ingress must bind only loopback port 3100');
requireBoundary(!services['provisioning-proxy'].ports?.length, 'provisioning-proxy must not publish a host port');
const ingressEnvironment = environmentNames(services.ingress);
requireBoundary(!ingressEnvironment.some((name) => /TOKEN|SECRET|PASSWORD|GITHUB_APP/.test(name)), 'ingress must not receive secret variables');

const runnerMounts = services.runner.volumes ?? [];
requireBoundary(runnerMounts.some((mount) => mount.source === '/var/run/docker.sock' && mount.target === '/var/run/docker.sock'), 'runner Docker socket mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/artifacts'), 'runner artifact persistence mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/cache/repos'), 'runner repo cache persistence mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/cache/toolkits'), 'runner toolkit cache persistence mount is missing');
requireBoundary(!runnerMounts.some((mount) => /model-gateway|provider-api-key/u.test(`${mount.source}:${mount.target}`)), 'runner must not receive model gateway secrets');
requireBoundary(!runnerMounts.some((mount) => mount.source.includes('cloud-harness-model-gateway')), 'runner must not mount model gateway secret directory');
for (const name of ['SECRET_KEYRING', 'SECRET_KEYRING_FILE', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE']) {
  requireBoundary(!environmentNames(services.api).includes(name), `API must not receive ${name}`);
}
for (const service of ['api', 'runner', 'ingress']) {
  for (const name of ['MCP_CANARY_URL', 'MCP_CANARY_ACCESS_CLIENT_ID', 'MCP_CANARY_ACCESS_CLIENT_SECRET']) {
    requireBoundary(!environmentNames(services[service]).includes(name), `${service} must not receive ${name}`);
  }
}

const tunnelConfig = await projectedComposeConfig([
  '-f', 'compose.yaml',
  '-f', 'compose.production.yaml',
  '-f', 'deploy/cloudflare-tunnel/compose.tunnel.yaml'
]);
const tunnelServices = tunnelConfig.services;
const cloudflared = tunnelServices.cloudflared;
requireBoundary(Boolean(cloudflared), 'tunnel Compose must declare cloudflared service');
requireBoundary(!cloudflared.ports?.length, 'cloudflared must not publish host ports');
requireBoundary(sameNames(mountTargets(cloudflared), ['/run/secrets/cloudflare-tunnel-token']), 'cloudflared must receive only the tunnel token file');
requireBoundary((cloudflared.volumes ?? []).every((mount) => mount.read_only === true), 'cloudflared token mount must be read-only');
requireBoundary(cloudflared.volumes?.[0]?.source === '/etc/cloud-harness-mcp/cloudflare-tunnel-token', 'cloudflared token source path changed');
requireBoundary(sameNames(environmentNames(cloudflared), []), 'cloudflared must not receive environment values');
requireBoundary(cloudflared.image === 'cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c', 'cloudflared image must remain immutable');
requireBoundary(cloudflared.commandArgumentCount === 5 && JSON.stringify(cloudflared.commandFlags) === JSON.stringify(['--no-autoupdate', '--token-file']), 'cloudflared command must use only the mounted token-file credential path');
requireBoundary(!JSON.stringify(tunnelConfig).includes('CLOUDFLARE_TUNNEL_TOKEN'), 'tunnel Compose must not interpolate the token');
requireBoundary(JSON.stringify(networkNames(cloudflared)) === JSON.stringify(['ingress']), 'cloudflared must attach only to the ingress network');
requireBoundary(tunnelConfig.networks.ingress.internal !== true, 'ingress network must remain routable for tunnel');

const nginx = readFileSync('deploy/nginx/cloud-harness-mcp.conf', 'utf8');
const locationBlock = (pattern) => nginx.match(pattern)?.[0] ?? '';
const dashboardEntry = locationBlock(/location = \/dashboard \{[^}]+\}/s);
const dashboardPrefix = locationBlock(/location \^~ \/dashboard\/ \{[^}]+\}/s);
const mcp = locationBlock(/location = \/mcp \{[^}]+\}/s);
const gatewayMcp = locationBlock(/location = \/mcp-gateway \{[^}]+\}/s);
const apiKeyMcp = locationBlock(/location = \/mcp-api-key \{[^}]+\}/s);
requireBoundary(dashboardEntry.includes('proxy_pass http://127.0.0.1:3100/dashboard;'), 'nginx dashboard entry point must preserve its upstream path');
requireBoundary(dashboardPrefix.includes('proxy_pass http://127.0.0.1:3100/dashboard/;'), 'nginx dashboard prefix must preserve asset and BFF paths');
for (const directive of ['proxy_http_version 1.1;', 'proxy_buffering off;', 'proxy_request_buffering off;', 'proxy_read_timeout 3600s;']) {
  requireBoundary(mcp.includes(directive), `nginx MCP streaming directive is missing: ${directive}`);
  requireBoundary(gatewayMcp.includes(directive), `nginx MCP gateway streaming directive is missing: ${directive}`);
  requireBoundary(apiKeyMcp.includes(directive), `nginx API-key MCP streaming directive is missing: ${directive}`);
}
requireBoundary(gatewayMcp.includes('proxy_pass http://127.0.0.1:3100/mcp-gateway;'), 'nginx MCP gateway route must preserve its upstream path');
requireBoundary(apiKeyMcp.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key;'), 'nginx API-key MCP route must preserve its hidden upstream path');

const nginxUpgrade = readFileSync('deploy/scripts/upgrade-nginx-dashboard.sh', 'utf8');
requireBoundary(
  nginxUpgrade.includes('dashboard_installed -eq 1 && $api_key_installed -eq 1 && $gateway_installed -eq 1'),
  'nginx upgrade must not return early until dashboard, API-key, and gateway routes are installed'
);
requireBoundary(
  nginxUpgrade.includes('location = /mcp-api-key {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key;') &&
    nginxUpgrade.includes('add_api_key="$((1 - api_key_installed))"'),
  'nginx upgrade must install the hidden API-key route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location = /mcp-gateway {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp-gateway;') &&
    nginxUpgrade.includes('add_gateway="$((1 - gateway_installed))"') &&
    nginxUpgrade.includes('gateway_installed -eq 0'),
  'nginx upgrade must install the MCP gateway route when it is absent'
);
console.log('compose-boundaries=pass');

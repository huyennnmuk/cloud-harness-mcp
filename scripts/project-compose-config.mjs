const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const safeEnvironmentValues = new Set([
  'MODEL_GATEWAY_DYNAMIC_MODE',
  'MODEL_GATEWAY_MODE'
]);

const services = Object.fromEntries(Object.entries(config.services ?? {}).map(([name, service]) => {
  const command = Array.isArray(service.command) ? service.command : [];
  const environment = service.environment ?? {};
  return [name, {
    image: service.image,
    commandArgumentCount: command.length,
    commandFlags: command
      .filter((argument) => typeof argument === 'string' && argument.startsWith('-'))
      .map((argument) => argument.split('=', 1)[0]),
    profiles: service.profiles,
    read_only: service.read_only,
    environmentNames: Object.keys(environment).sort(),
    environmentValues: Object.fromEntries(
      Object.entries(environment).filter(([key]) => safeEnvironmentValues.has(key))
    ),
    networks: Object.keys(service.networks ?? {}).sort(),
    ports: (service.ports ?? []).map(({ host_ip, protocol, published, target }) => ({
      host_ip,
      protocol,
      published,
      target
    })),
    volumes: (service.volumes ?? []).map(({ read_only, source, target, type }) => ({
      read_only,
      source,
      target,
      type
    }))
  }];
}));

const networks = Object.fromEntries(Object.entries(config.networks ?? {}).map(([name, network]) => [
  name,
  { internal: network.internal === true }
]));

process.stdout.write(`${JSON.stringify({ services, networks })}\n`);

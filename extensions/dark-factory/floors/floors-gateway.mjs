// Loopback hosting entrypoint. Reads never launch stopped floor capacity.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtime, ensureController, serveFloors } from './wiring.mjs';

export async function startGateway(env = process.env) {
  const path = env.FACTORY_HOSTING_CONFIG;
  if (!path) throw Error('FACTORY_HOSTING_CONFIG must name private owned configuration');
  const stat = statSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('private owned configuration required');
  const { token } = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('invalid room capability');
  const port = Number(env.FACTORY_GATEWAY_PORT ?? 64375);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid gateway port');
  const pin = env.FACTORY_SOURCE_MANIFEST ? createHash('sha256').update(readFileSync(env.FACTORY_SOURCE_MANIFEST)).digest('hex') : null;
  const room = await serveFloors({ root: env.FACTORY_ROOT, port, token, runtime, ensureController });
  console.log(`Factory floors loopback gateway ready; native controller recovery${pin ? `; manifest ${pin}` : ''}`);
  return room;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const room = await startGateway();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => room.server.close());
}

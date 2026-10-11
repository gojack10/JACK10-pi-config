import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieName = '__Host-factory';
const ttl = 24 * 60 * 60 * 1000;

// Separate authenticated ingress. The room remains loopback-only and still checks
// its run capability. Never inject an API bearer or trust proxy identity headers.
export async function serveHosting({ origin, upstream, run, token, basic, mode = 'legacy', port = 0, now = Date.now }) {
  const publicURL = new URL(origin), local = new URL(upstream);
  if (publicURL.protocol !== 'https:' || publicURL.origin !== origin ||
      local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.origin !== upstream ||
      !['legacy','floors'].includes(mode) || (mode === 'legacy' && !/^[a-zA-Z0-9_-]+$/.test(run)) || !/^[a-f0-9]{64}$/.test(token) ||
      !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(basic)) throw new Error('invalid private hosting configuration');
  const sessions = new Map();
  const prefix = `/api/${encodeURIComponent(run)}/`;
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json', headers = {}) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        ...headers });
      response.end(type === 'application/json' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
    };
    try {
      // Allow user-clicked top-level entry links, not cross-site scripts or API requests.
      const entryNavigation = request.method === 'GET' && ['/', '/login'].includes(request.url) &&
        request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' &&
        request.headers['sec-fetch-user'] === '?1' && !request.headers.origin;
      // Validate BEFORE translating the authenticated browser origin to loopback.
      if (request.headers.host !== publicURL.host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) && !entryNavigation)) return send(403, { error: 'factory origin required' });
      // Cloudflare overwrites X-Forwarded-Proto. Only the private tunnel reaches
      // this listener; never issue a Basic challenge over a plaintext edge hop.
      if (request.headers['x-forwarded-proto'] !== 'https') return send(403, { error: 'HTTPS required' });
      if (!request.url.startsWith('/') || request.url.startsWith('//')) return send(400, { error: 'invalid path' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/login' && !url.search) {
        if (!equal(request.headers.authorization, basic)) return send(401, { error: 'login required' }, 'application/json', { 'WWW-Authenticate': 'Basic realm="Factory", charset="UTF-8"' });
        for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
        // ponytail: one owner, at most 64 browser sessions; oldest login expires at capacity.
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        const session = randomBytes(32).toString('hex'); sessions.set(session, now() + ttl);
        return send(303, {}, 'application/json', { Location: '/', 'Set-Cookie': `${cookieName}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ttl / 1000}` });
      }
      const cookies = (request.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
      const session = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
      if ((sessions.get(session) ?? 0) <= now()) {
        sessions.delete(session);
        return request.method === 'GET' && url.pathname === '/' && !url.search
          ? send(303, {}, 'application/json', { Location: '/login' }) : send(401, { error: 'login required' });
      }
      if (request.method === 'GET' && url.pathname === '/hosting-bootstrap.js' && !url.search) {
        // Even a sibling-site script in a browser without Fetch Metadata must
        // never receive a capability-bearing classic script.
        if (request.headers['sec-fetch-site'] !== 'same-origin') return send(403, { error: 'same-origin bootstrap required' });
        return send(200, `sessionStorage.setItem('bf2-room', ${JSON.stringify(JSON.stringify({ run: mode === 'floors' ? 'floors' : run, token, multi: mode === 'floors' }))});`, 'text/javascript');
      }
      if (url.pathname.startsWith('/api/')) {
        const floorPath = /^\/api\/floors\/([a-zA-Z0-9_-]+)\/([a-z]+)$/.exec(url.pathname);
        if (mode === 'legacy' ? !url.pathname.startsWith(prefix) : url.pathname !== '/api/floors' && !floorPath) return send(404, { error: 'another run' });
        if (!equal(request.headers.authorization, `Bearer ${token}`)) return send(403, { error: 'room capability required' });
        const action = mode === 'floors' ? floorPath?.[2] : url.pathname.slice(prefix.length);
        if (!(request.method === 'GET' && (action === 'state' || mode === 'floors' && url.pathname === '/api/floors' && !url.search)) &&
            !(request.method === 'POST' && (mode === 'floors' ? ['message','start','stop','configuration','condition','oss'] : ['message','start','stop','close']).includes(action))) return send(404, { error: 'unknown operation' });
      } else if (request.method !== 'GET' || url.search || !['/', '/room.js', '/markup.mjs', '/colors_and_type.css',
          ...['Light', 'Medium', 'SemiBold', 'Italic'].map(f => `/fonts/JetBrainsMono-${f}.woff2`)].includes(url.pathname)) return send(404, { error: 'not found' });
      if (request.method === 'POST' && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')) return send(403, { error: 'same-origin JSON required' });
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > (mode === 'floors' ? 256 * 1024 : 16384 * 6 + 1024)) { send(413, { error: 'body too large' }); request.resume(); return; }
        chunks.push(chunk);
      }
      const headers = {};
      if (request.headers.authorization?.startsWith('Bearer ')) headers.Authorization = request.headers.authorization;
      if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type'];
      if (request.headers.origin) headers.Origin = upstream;
      const result = await fetch(upstream + url.pathname + url.search, { method: request.method, headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), redirect: 'error', signal: AbortSignal.timeout(10000) });
      let body = Buffer.from(await result.arrayBuffer());
      if (url.pathname === '/' && result.ok) body = Buffer.from(body.toString('utf8').replace('<script type="module"', '<script src="/hosting-bootstrap.js"></script>\n<script type="module"'));
      send(result.status, body, result.headers.get('content-type') ?? 'application/octet-stream');
    } catch { if (!response.headersSent) send(502, { error: 'room unavailable' }); else response.end(); }
  });
  server.requestTimeout = server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const path = process.argv[2], stat = statSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('private owned configuration required');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const check = await fetch(config.mode === 'floors' ? `${config.upstream}/api/floors` : `${config.upstream}/api/${encodeURIComponent(config.run)}/state?after=0`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10000) });
    if (!check.ok) throw new Error('saved room unavailable');
    const server = await serveHosting(config);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
    console.log('Factory authenticated ingress ready'); // No URLs, capabilities or request logs.
  } catch { console.error('Factory ingress startup refused; inspect private configuration and room availability'); process.exitCode = 1; }
}

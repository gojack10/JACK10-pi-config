import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { missingFloorLaunchSettings } from '../../bf2-swarm/lifecycle-store.mjs';
import { pathfinderAddress } from '../../bf2-swarm/pathfinder.mjs';

const assets = new URL('../room/', import.meta.url);
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/room.js': ['room.js', 'text/javascript'],
  '/markup.mjs': ['markup.mjs', 'text/javascript'], '/colors_and_type.css': ['colors_and_type.css', 'text/css'],
  ...Object.fromEntries(['Light','Medium','SemiBold','Italic'].map(f => [`/fonts/JetBrainsMono-${f}.woff2`, [`fonts/JetBrainsMono-${f}.woff2`, 'font/woff2']])) };
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fields = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const slot = s => ({ ...fields(s, ['id','provider','model','thinking','role']), contextWarningPercent: s.contextWarning });
export function publicSnapshot(snapshot) {
  return { ...fields(snapshot, ['status','draining','pending','known','members','posts','vote']),
    settings: { name: snapshot.floor.name, voteCondition: snapshot.floor.voteCondition, slots: snapshot.slots.map(slot),
      pathfinder: snapshot.floor.pathfinder ?? null,
      missingLaunchSettings: missingFloorLaunchSettings(snapshot.floor) },
    workers: snapshot.workers.map(w => ({ ...fields(w, ['cleaned']), sender: pathfinderAddress(w), slotId: w.slot,
      ...fields(w.launch_config, ['provider','model','thinking','role']), contextWarningPercent: w.launch_config?.contextWarning,
      phase: w.retire_requested ? 'retirement requested' : w.state, contextPercent: w.context_percent ?? null })) };
}
const validObject = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => keys.includes(k));
const operations = { message: ['key','text'], start: ['key'], stop: ['key'], configuration: ['slots','pathfinder'], condition: ['condition'], oss: [] };

// Runtime is the only discovery/store/lifecycle owner. Imports are deferred so this
// adapter can be checked with a fake runtime without starting a worker or database.
export async function serveFloors({ root, token = randomBytes(32).toString('hex'), port = 0, runtime, ensureController } = {}) {
  runtime ??= await import('./runtime.mjs');
  ensureController ??= (await import('./supervisor.mjs')).ensureFloorController;
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('invalid room capability');
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    let floor;
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) ||
          ['cross-site','same-site'].includes(request.headers['sec-fetch-site'])) return send(403, { error: 'local origin required' });
      if (!request.url.startsWith('/') || request.url.startsWith('//')) return send(400, { error: 'invalid path' });
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith('/api/')) {
        const file = files[url.pathname];
        if (request.method !== 'GET' || url.search || !file) return send(404, { error: 'not found' });
        return send(200, readFileSync(new URL(file[0], assets)), file[1]);
      }
      if (!equal(request.headers.authorization, `Bearer ${token}`)) return send(403, { error: 'room capability required' });
      if (request.method === 'GET' && url.pathname === '/api/floors' && !url.search) {
        return send(200, { floors: runtime.listFloors({ root }).map(f => fields(f, ['id','name','status'])),
          routes: runtime.ROUTES.map(r => fields(r, ['provider','model','thinking'])), pathfinderDefaults: runtime.PATHFINDER_DEFAULTS,
          oss: publicOss(runtime.ossStatus({ root })) });
      }
      const match = /^\/api\/floors\/([a-zA-Z0-9_-]+)\/([a-z]+)$/.exec(url.pathname);
      if (!match) return send(404, { error: 'unknown operation' });
      const [, id, action] = match;
      if (request.method === 'GET' && action === 'state') {
        const before = url.searchParams.has('before'), key = before ? 'before' : 'after';
        const cursor = Number(url.searchParams.get(key) ?? 0);
        if ([...url.searchParams.keys()].some(k => k !== key) || url.searchParams.getAll(key).length > 1 ||
            !/^\d+$/.test(url.searchParams.get(key) ?? '0') || !Number.isSafeInteger(cursor) || (before && cursor < 1)) return send(400, { error: 'invalid cursor' });
        floor = runtime.openFloor(id, { root });
        if (before) {
          const history = floor.board.history({ before: cursor, limit: 100 });
          return send(200, { ...publicSnapshot(floor.snapshot(history.highwater)), posts: history.posts });
        }
        return send(200, publicSnapshot(floor.snapshot(cursor)));
      }
      if (request.method !== 'POST' || !Object.hasOwn(operations, action) || url.search) return send(404, { error: 'unknown operation' });
      if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(403, { error: 'same-origin JSON required' });
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { send(413, { error: 'body too large' }); request.resume(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validObject(body, operations[action]) || (action === 'configuration' ? !Object.keys(body).length : operations[action].some(k => body[k] === undefined))) return send(400, { error: 'unexpected input' });
      if (action === 'configuration' && Object.hasOwn(body, 'slots') && (!Array.isArray(body.slots) || body.slots.length < 2 || body.slots.length > 10 ||
          body.slots.some(s => !validObject(s, ['id','provider','model','thinking','role','contextWarningPercent'])))) return send(400, { error: 'invalid slots' });
      if (action === 'oss') {
        // Selection names a discovered floor, never a path/executable. Runtime owns
        // the global drain-before-claim constraint and chooses its OSS slot.
        runtime.selectOssFloor(id, { root });
        return send(200, { oss: publicOss(runtime.ossStatus({ root })) });
      }
      floor = runtime.openFloor(id, { root });
      if (action === 'configuration') floor.configure({
        ...(Object.hasOwn(body, 'slots') ? { slots: body.slots.map(s => ({ ...fields(s, ['id','provider','model','thinking','role']), contextWarning: s.contextWarningPercent })) } : {}),
        ...(Object.hasOwn(body, 'pathfinder') ? { pathfinder: body.pathfinder } : {}) });
      else if (action === 'condition') floor.configure({ voteCondition: body.condition });
      else {
        floor.command(body.key, action, action === 'message' ? body.text : null);
        const saved = floor.snapshot();
        try { if (saved.status !== 'stopped' || saved.pending) ensureController(floor); }
        catch { return send(503, { error: 'Saved, controller recovery pending' }); }
      }
      return send(200, { saved: true });
    } catch (error) {
      const message = error.message?.startsWith('floor start requires launch settings:') ? error.message :
        error.message?.includes('approved provider/model/thinking') ? 'Choose an approved model and thinking route' :
        error.message?.startsWith('Pathfinder ') || error.message === 'unknown Pathfinder setting' || error.message?.startsWith('at most one OSS occupant') ? error.message :
        error.message?.includes('needs an OSS slot') ? 'Configure one local Qwen slot on this floor first' : 'Operation refused; check floor settings and availability';
      if (!response.headersSent) send(400, { error: message }); else response.end();
    }
    finally { floor?.close(); }
  });
  server.requestTimeout = server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // Native claim/health gates own capacity. This only retries recovery of floors
  // already running/pending, including Start racing an old controller's exit.
  const recovery = setInterval(() => {
    try {
      for (const entry of runtime.listFloors({ root })) {
        let floor;
        try {
          floor = runtime.openFloor(entry.id, { root });
          const state = floor.snapshot();
          if (state.status !== 'stopped' || state.pending) ensureController(floor);
        } catch { console.error('Floor controller recovery pending'); }
        finally { floor?.close(); }
      }
    } catch { console.error('Floor discovery unavailable'); }
  }, 2000);
  server.on('close', () => clearInterval(recovery));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#floors/${token}` };
}
function publicOss(value) {
  const moving = !!value.session && value.floor !== value.selected;
  return { selectedFloor: value.selected, floorId: value.floor, moving,
    status: moving ? 'moving, waiting for actual exit' : value.session ? 'occupied' : value.selected ? 'selected, waiting for spawn' : 'unassigned' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const room = await serveFloors({ root: process.argv[2] });
  console.log(`Room: ${room.url}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => room.server.close());
}

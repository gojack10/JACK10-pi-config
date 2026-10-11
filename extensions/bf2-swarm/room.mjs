import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { openRun, ensureController } from './controller.mjs';
import { MAX_TEXT_BYTES } from './board.mjs';

const assets = join(dirname(fileURLToPath(import.meta.url)), 'room');
const sameToken = (actual, expected) => typeof actual === 'string' && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const roomURL = (run, port, token) => `http://127.0.0.1:${port}/#${run}/${token}`;

// No browser-supplied identity, database, route or executable enters this server.
export async function serveRoom(board, config, { port = 0, controller = () => ensureController(board, config), onClose = () => {} } = {}) {
  const token = board.lifecycle.status().room_token;
  const prefix = `/api/${encodeURIComponent(config.run)}/`;
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: 'local origin required' });
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith(prefix)) return send(404, { error: 'another run' });
        if (!sameToken(request.headers.authorization, `Bearer ${token}`)) return send(403, { error: 'room capability required' });
        const action = url.pathname.slice(prefix.length);
        if (request.method === 'GET' && action === 'state') {
          if ([...url.searchParams.keys()].some(k => k !== 'after') || !/^\d+$/.test(url.searchParams.get('after') ?? '0')) return send(400, { error: 'invalid cursor' });
          return send(200, board.roomSnapshot(Number(url.searchParams.get('after') ?? 0)));
        }
        if (request.method !== 'POST' || !['message','start','stop','close'].includes(action)) return send(404, { error: 'unknown operation' });
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(403, { error: 'JSON from local room origin required' });
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > MAX_TEXT_BYTES * 6 + 1024) { send(413, { error: 'body too large' }); request.resume(); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || Object.keys(body).some(k => !['key', ...(action === 'message' ? ['text'] : [])].includes(k))) return send(400, { error: 'unexpected input' });
        if (action === 'close') { send(200, { closed: true }); server.close(); return; }
        const result = board.lifecycle.ownerCommand(body.key, action, action === 'message' ? body.text : null);
        // Persistence precedes recovery. Failure leaves the saved command/reconvene
        // intact; same-key retry can recover without double-posting or undoing Stop.
        const state = board.lifecycle.status();
        if (state.status !== 'stopped' || state.reconvene) {
          try { controller(); }
          catch (error) { console.error(`Room controller recovery: ${error.message}`); return send(503, { error: 'Saved, controller recovery pending. Inspect room.log' }); }
        }
        return send(200, { number: result.number, status: state.status, pending: !!state.reconvene });
      }
      if (request.method !== 'GET' || url.search) return send(404, { error: 'not found' });
      const files = { '/': ['index.html','text/html; charset=utf-8'], '/colors_and_type.css': ['colors_and_type.css','text/css'],
        '/room.js': ['room.js','text/javascript'], '/markup.mjs': ['markup.mjs','text/javascript'] };
      for (const font of ['Light','Medium','SemiBold','Italic']) files[`/fonts/JetBrainsMono-${font}.woff2`] = [`fonts/JetBrainsMono-${font}.woff2`,'font/woff2'];
      const file = files[url.pathname];
      if (!file) return send(404, { error: 'not found' });
      send(200, readFileSync(join(assets, file[0])), file[1]);
    } catch (error) { if (!response.headersSent) send(400, { error: error.message }); else response.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('close', onClose);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: roomURL(config.run, server.address().port, token) };
}

export async function ensureRoom(runDir, open = true) {
  const { board, config } = openRun(runDir);
  let child;
  try {
    const descriptor = board.lifecycle.roomSetup(() => {
      const log = openSync(join(runDir, 'room.log'), 'a', 0o600);
      try {
        child = fork(fileURLToPath(import.meta.url), [runDir], { detached: true, stdio: ['ignore',log,log,'ipc'] });
        return child.pid;
      } finally { closeSync(log); }
    });
    if (child) {
      await new Promise((resolve, reject) => {
        child.once('message', message => message.ready ? resolve() : reject(new Error(message.error ?? 'room failed')));
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`room exited ${code} before ready`)));
      });
      child.disconnect(); child.unref();
    } else if (descriptor.port === null) {
      // A concurrent explicit opener owns startup. Internal service readiness wait,
      // not peer work or a vote timer. Do not create another room process.
      const deadline = Date.now() + 10000;
      while (board.lifecycle.status().room_port === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    }
    const state = board.lifecycle.status();
    if (!state.room_port) throw new Error('room startup incomplete; inspect room.log');
    const url = roomURL(config.run, state.room_port, state.room_token);
    const check = await fetch(`http://127.0.0.1:${state.room_port}/api/${encodeURIComponent(config.run)}/state`, { headers: { Authorization: `Bearer ${state.room_token}` } });
    if (!check.ok) throw new Error('saved room is not reachable; inspect room.log');
    if (open) {
      const result = spawnSync('open', ['-a','Google Chrome',url], { encoding: 'utf8' });
      if (result.error || result.status !== 0) console.error('Chrome did not open; use the printed room URL');
    }
    console.log(`Room: ${url}`);
    return url;
  } finally { board.close(); }
}

export async function closeRoom(runDir) {
  const { board, config } = openRun(runDir);
  try {
    const state = board.lifecycle.status();
    if (!state.room_port) return;
    const origin = `http://127.0.0.1:${state.room_port}`;
    const response = await fetch(`${origin}/api/${encodeURIComponent(config.run)}/close`, { method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${state.room_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: randomUUID() }) });
    if (!response.ok) throw new Error('room refused close');
  } finally { board.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let board, server, recovery;
  try {
    const run = openRun(process.argv[2]); board = run.board;
    const room = await serveRoom(board, run.config, { onClose: () => { clearInterval(recovery); board.lifecycle.roomRelease(process.pid); board.close(); } });
    server = room.server;
    if (!board.lifecycle.roomPublish(process.pid, room.server.address().port)) throw new Error('room startup ownership changed');
    // Also covers Start racing the old controller's natural stop exit. Recovery
    // uses the existing native health/claim gates, not a second factory loop.
    recovery = setInterval(() => {
      try { if (board.lifecycle.status().status !== 'stopped') ensureController(board, run.config); }
      catch (error) { console.error(`Room controller recovery: ${error.message}`); }
    }, 2000);
    const shutdown = () => room.server.close();
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    process.send?.({ ready: true });
  } catch (error) {
    process.send?.({ error: error.message });
    if (server) server.close();
    else { board?.lifecycle.roomRelease(process.pid); board?.close(); }
    console.error(error.message); process.exitCode = 1;
  }
}

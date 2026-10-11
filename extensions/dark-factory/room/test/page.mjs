import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { esc, avatar, textMarkup, messageMarkup } from '../markup.mjs';

export function page({ multi = false, snapshots = {}, shared = new Map(), saved = new Map(), permission = 'granted' } = {}) {
  const elements = new Map(), requests = [], notices = [], played = [], contexts = [], timers = [];
  let permissionRequests = 0, rejectAudio = false, rejectSynthesis = false;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', hidden: false, events: {}, attrs: {}, dataset: {}, children: [], scrollHeight: 0, clientHeight: 0, scrollTop: 0,
      addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attrs[name] = value; }, focus() {}, insertAdjacentHTML(_where, html) { this.innerHTML += html; } });
    return elements.get(selector);
  };
  const store = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    constructor() { contexts.push(this); }
    async resume() { if (rejectAudio) throw Error('unavailable'); this.state = 'running'; }
    createOscillator() {
      if (rejectSynthesis) throw Error('unavailable');
      return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start(at) { played.push(at); }, stop() { this.onended(); } };
    }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  class Notification {
    static permission = permission;
    static async requestPermission() { permissionRequests++; this.permission = 'granted'; return 'granted'; }
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; }
  }
  saved.set('bf2-room', JSON.stringify({ run: multi ? 'floors' : 'legacy', token: 'synthetic', multi }));
  const scope = { document: { querySelector: element, addEventListener() {} }, location: { hash: '' }, sessionStorage: store(saved), localStorage: store(shared), AudioContext, Notification,
    esc, avatar, textMarkup, messageMarkup, crypto: { randomUUID: () => 'fixture-key' }, window: { focus() {} }, setInterval: (fn, ms) => timers.push([fn, ms]),
    fetch: async (path, options) => {
      requests.push([path, options]);
      if (path === '/api/floors') return { ok: true, json: async () => ({ floors: Object.keys(snapshots).map(id => ({ id, name: id })),
        routes: [{ provider: 'openai-codex-test', model: 'gpt-6.1-sol', thinking: 'high' }, { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' }], oss: { status: 'draining' } }) };
      const id = multi ? path.split('/')[3] : 'legacy', after = Number(new URL(path, 'http://fixture.test').searchParams.get('after'));
      return { ok: true, json: async () => options.method === 'POST' ? { saved: true } : { ...snapshots[id], posts: snapshots[id].posts.filter(p => p.number > after) } };
    } };
  const source = readFileSync(new URL('../room.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
  runInNewContext(source + '\nglobalThis.check = {poll,selectFloor,notify,openSettings,room,active,alerts,unlockAudio,selected:()=>selected};', scope);
  return { ...scope.check, element, requests, notices, played, contexts, timers, saved, shared, Notification, permissionRequests: () => permissionRequests,
    click: selector => element(selector).events.click(), failAudio: () => { rejectAudio = true; }, failSynthesis: () => { rejectSynthesis = true; } };
}
export const snapshot = (name = 'fixture') => ({ status: 'running', posts: [], members: ['aaaaaaaa'], known: ['aaaaaaaa'], workers: [],
  settings: { name, voteCondition: 'Owner chosen condition', slots: [1,2].map(id => ({ id: String(id), provider: 'openai-codex-test', model: 'gpt-6.1-sol', thinking: 'high', role: '', contextWarningPercent: 80 })) } });
export const flushed = () => new Promise(resolve => setImmediate(resolve));

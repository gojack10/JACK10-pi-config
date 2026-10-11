import { esc, avatar, textMarkup, messageMarkup } from './markup.mjs';
const $ = selector => document.querySelector(selector);
const [fragmentRun, fragmentToken] = location.hash.slice(1).split('/');
if (fragmentRun && fragmentToken) {
  sessionStorage.setItem('bf2-room', JSON.stringify({ run: fragmentRun, token: fragmentToken, multi: fragmentRun === 'floors' }));
  history.replaceState(null, '', '/');
}
const { run, token, multi = false } = JSON.parse(sessionStorage.getItem('bf2-room') ?? '{}');
const rooms = new Map();
let selected = multi ? sessionStorage.getItem('factory-selected') : run;
let state, busy = false, polling = false, routes = [], oss, audio, panelFloor, selectedLoaded = false, queuedFloor;
const storage = (store, key, fallback = null) => { try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (store, key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* Storage-disabled browsers still work for this page. */ } };
const scoped = (kind, id) => `${multi ? 'factory' : 'bf2'}-${kind}:${id}`;
function room(id, name = id) {
  if (!rooms.has(id)) rooms.set(id, { id, name, posts: [], after: 0, loaded: false, prefs: storage(localStorage, scoped('alerts', id), { sound: true, desktop: true }) });
  const value = rooms.get(id); value.name = name; return value;
}
const active = () => rooms.get(selected);
const api = async (action, body, id = selected) => {
  const path = multi ? (action === 'floors' ? '/api/floors' : `/api/floors/${encodeURIComponent(id)}/${action}`) : `/api/${encodeURIComponent(run)}/${action}`;
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'room unavailable');
  return result;
};
function alerts() {
  const prefs = active()?.prefs ?? { sound: true, desktop: true };
  const speaker = $('#sound-toggle'), desktop = $('#notification-toggle');
  speaker.setAttribute('aria-pressed', String(prefs.sound));
  speaker.title = speaker.ariaLabel = prefs.sound ? 'Mute sounds (audio starts after a click)' : 'Enable message sounds';
  desktop.setAttribute('aria-pressed', String(prefs.desktop));
  desktop.textContent = !prefs.desktop ? 'alerts off' : typeof Notification === 'undefined' ? 'alerts unavailable' : Notification.permission === 'granted' ? 'alerts on' : Notification.permission === 'denied' ? 'alerts blocked' : 'enable alerts';
  desktop.title = 'Desktop @JACK notifications for this floor. Permission requires a click; the site must remain open.';
}
async function unlockAudio() {
  if (!active()?.prefs.sound) return;
  try { audio ??= new AudioContext(); await audio.resume(); }
  catch { $('#sound-toggle').title = 'Audio unavailable; click to retry'; }
}
$('#sound-toggle').addEventListener('click', async () => {
  if (!active()) return;
  active().prefs.sound = !active().prefs.sound;
  save(localStorage, scoped('alerts', selected), active().prefs);
  await unlockAudio(); alerts();
});
$('#notification-toggle').addEventListener('click', async () => {
  const current = active(); if (!current) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    current.prefs.desktop = true;
    try { await Notification.requestPermission(); } catch { /* Show actual permission, never pretend approval. */ }
  } else current.prefs.desktop = !current.prefs.desktop;
  save(localStorage, scoped('alerts', current.id), current.prefs); alerts();
});
function handshake() {
  if (audio?.state !== 'running') return;
  try {
    const start = audio.currentTime + .015;
    for (const [offset, duration, from, to, level] of [[0, .09, 620, 620, .06], [.13, .14, 930, 950, .055]]) {
      const at = start + offset, tone = audio.createOscillator(), volume = audio.createGain();
      tone.type = 'sine'; tone.frequency.setValueAtTime(from, at); tone.frequency.exponentialRampToValueAtTime(to, at + duration);
      volume.gain.setValueAtTime(0, at); volume.gain.linearRampToValueAtTime(level, at + .006);
      volume.gain.exponentialRampToValueAtTime(.0001, at + duration - .006); volume.gain.linearRampToValueAtTime(0, at + duration);
      tone.connect(volume); volume.connect(audio.destination);
      tone.onended = () => { tone.disconnect(); volume.disconnect(); }; tone.start(at); tone.stop(at + duration);
    }
  } catch { $('#sound-toggle').title = 'Audio unavailable; click to retry'; }
}
function notify(current, next) {
  current.prefs = storage(localStorage, scoped('alerts', current.id), current.prefs);
  if (current.loaded) {
    const peers = next.filter(p => p.role === 'peer');
    if (current.prefs.sound && peers.length) handshake();
    if (current.prefs.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const post of peers.filter(p => textMarkup(p.text.toUpperCase(), new Set(['JACK'])).includes('>@JACK</button>'))) {
        // Origin-scoped claim prevents repeated polling/reload and ordinary sibling-tab duplicates.
        const key = scoped('notified', current.id);
        const deliver = () => {
          if (post.number <= storage(localStorage, key, 0)) return;
          save(localStorage, key, post.number);
          try {
            const notice = new Notification(`${current.name} · ${post.sender}`, { body: post.text.slice(0, 240), tag: `${current.id}:${post.number}` });
            notice.onclick = () => { window.focus(); selectFloor(current.id); notice.close(); };
          } catch { /* A notification failure must not interrupt chat. */ }
        };
        // Native cross-tab lock where supported; notification tags/storage provide
        // best-effort deduplication when Web Locks or persistent storage is absent.
        if (typeof navigator !== 'undefined' && navigator.locks) void navigator.locks.request(key, deliver).catch(() => {});
        else deliver();
      }
    }
  }
  // All initial history pages stay silent, including a newly discovered floor.
  current.loaded ||= next.length < 100;
}
function controls() {
  const missing = state?.settings?.missingLaunchSettings ?? [];
  const starting = state?.status === 'stopped' || (state?.status === 'waiting' && !state.draining);
  $('#factory-control').disabled = busy || !state || (starting && missing.length > 0);
  $('#factory-control').textContent = starting ? 'start factory' : 'stop factory';
  $('#launch-readiness').hidden = !missing.length;
  $('#launch-readiness').textContent = missing.length ? `Not configured for Start: ${missing.join(', ')}. Set the vote condition in settings; set instruction entry and launch text with factory config. Messages are saved without starting.` : '';
  $('#send').textContent = missing.length ? 'send (no start)' : state?.status === 'stopped' ? 'send & start' : state?.status === 'waiting' ? 'send & resume' : 'send';
  $('#send').disabled = busy || !state || !$('#message').value.trim();
  $('#settings-toggle').hidden = !multi;
  $('#settings-toggle').disabled = busy || !state;
}
function render() {
  const current = active(); state = current?.state;
  if (!state) { $('#transcript').innerHTML = ''; $('#members').innerHTML = ''; $('#request').hidden = true; $('#status').textContent = 'connecting'; controls(); alerts(); return; }
  const known = new Set([...(state.known ?? []), 'JACK']), log = $('#transcript');
  const near = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
  const signature = JSON.stringify([current.after, state.known]);
  // ponytail: rebuild loaded scrollback; append/index if long runs make this slow.
  if (current.signature !== signature) {
    const top = log.scrollTop; log.innerHTML = current.posts.map(p => messageMarkup(p, known)).join('');
    log.scrollTop = near ? log.scrollHeight : top;
    if (current.signature && !near) $('#new-messages').hidden = false;
    current.signature = signature;
  }
  $('#floor-name').textContent = multi ? current.name : '';
  $('#members').innerHTML = [...(state.members ?? []), 'JACK'].map(id => {
    const worker = multi ? state.workers?.find(w => w.sender === id && !w.cleaned) : undefined;
    const role = id === 'JACK' ? 'factory owner' : worker ? `current: ${worker.model ?? 'unknown'} · ${worker.phase ?? 'unknown'}${state.settings.slots.some(s => s.id === worker.slotId) ? '' : ' · removed slot, draining'}` : 'swarm agent';
    return `<div class="member">${avatar(id === 'JACK')}<div><div class="name ${id === 'JACK' ? 'jack' : ''}">${esc(id)}</div><div class="role">${esc(role)}</div></div></div>`;
  }).join('');
  const vote = state.vote, condition = state.settings?.voteCondition;
  $('#request').hidden = !vote && !condition;
  if (vote || condition) $('#request').innerHTML = `<h2>${multi ? 'Owner vote condition' : 'Current request'}</h2><h3>Pause for factory owner</h3><p class="reason">${textMarkup(condition ?? vote.reason, known)}</p>${!multi && vote ? `<div class="called-by">Called by ${textMarkup(vote.electorate.find(v => v.session === vote.proposer)?.sender ?? vote.proposer, known)}</div>` : ''}${vote ? `<div class="ballots">${vote.electorate.map(v => `<div class="ballot"><span>${esc(v.sender)}</span><span class="answer ${v.answer ? '' : 'pending'}">${esc(v.answer ?? 'pending')}</span></div>`).join('')}</div><div class="vote-footer"><span>${vote.electorate.filter(v => v.answer === 'yes').length} / ${vote.electorate.length} yes</span><span>${esc(vote.result ?? 'No timeout')}</span></div>` : '<p class="muted">No active ballots</p>'}`;
  $('#status').dataset.state = state.status;
  $('#status').textContent = state.draining ? (state.pending ? 'draining, restart queued' : 'draining') : state.status === 'waiting' ? 'waiting for JACK' : state.status;
  controls(); alerts();
}
function persistDraft() { if (selected && (!multi || selectedLoaded)) save(sessionStorage, scoped('draft', selected), $('#message').value); }
function selectFloor(id) {
  if (!rooms.has(id)) return;
  if (busy) { queuedFloor = id; return; }
  persistDraft(); selected = id;
  if (multi) sessionStorage.setItem('factory-selected', id);
  $('#settings-panel').hidden = true; panelFloor = undefined;
  $('#message').value = storage(sessionStorage, scoped('draft', id), null) ?? storage(sessionStorage, scoped('pending', id), {})?.text ?? '';
  $('#new-messages').hidden = true;
  active().signature = undefined; $('#transcript').scrollTop = 0;
  tabs(); render();
}
function tabs() {
  $('#floor-tabs').hidden = !multi;
  if (multi) $('#floor-tabs').innerHTML = [...rooms.values()].map(r => `<button type="button" role="tab" aria-selected="${r.id === selected}" data-floor="${esc(r.id)}">${esc(r.name)}${r.error ? ' · unavailable' : ''}</button>`).join('');
}
async function poll() {
  if (polling || !run || !token) return;
  polling = true;
  try {
    if (multi) {
      const discovery = await api('floors'); routes = discovery.routes; oss = discovery.oss;
      const ids = new Set(discovery.floors.map(f => f.id));
      for (const f of discovery.floors) room(f.id, f.name);
      for (const id of rooms.keys()) if (!ids.has(id)) rooms.delete(id);
      if (!selectedLoaded || !rooms.has(selected)) { selectFloor(rooms.has(selected) ? selected : rooms.keys().next().value); selectedLoaded = true; }
      tabs();
    } else room(run);
    await Promise.all([...rooms.values()].map(async current => {
      try {
        const next = await api(`state?after=${current.after}`, undefined, current.id);
        notify(current, next.posts); current.posts.push(...next.posts);
        current.after = current.posts.at(-1)?.number ?? 0; current.state = next; current.error = undefined;
      } catch (error) { current.error = error.message; current.state = undefined; }
    }));
    if (multi) {
      // Preserve already-validated operator provider aliases from configured slots.
      // Canonical runtime route templates may use a generic Codex provider.
      for (const current of rooms.values()) for (const slot of current.state?.settings.slots ?? []) {
        if (!routes.some(r => routeValue(r) === routeValue(slot))) routes.push({ provider: slot.provider, model: slot.model, thinking: slot.thinking });
      }
    }
    render();
    if (multi && rooms.size === 0) $('#status').textContent = 'No floors found; create a stopped floor with the CLI';
    if (active()?.error) $('#status').textContent = active().error;
  } catch (error) { $('#status').textContent = error.message; state = undefined; controls(); }
  finally { polling = false; }
}
async function mutate(action, body, id = selected) {
  if (busy) return false;
  busy = true; controls();
  try { await api(action, body, id); await poll(); return true; }
  catch (error) { $('#status').textContent = error.message; if (!$('#settings-panel').hidden) $('#settings-error').textContent = error.message; return false; }
  finally { busy = false; controls(); if (queuedFloor) { const id = queuedFloor; queuedFloor = undefined; selectFloor(id); } }
}
$('#factory-control').addEventListener('click', () => {
  const action = state.status === 'stopped' || (state.status === 'waiting' && !state.draining) ? 'start' : 'stop';
  void mutate(action, { key: crypto.randomUUID() });
});
$('#message').addEventListener('input', () => { persistDraft(); controls(); });
$('#message').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', async e => {
  e.preventDefault(); const text = $('#message').value, id = selected;
  if (!text.trim() || busy) return;
  const saved = storage(sessionStorage, scoped('pending', id));
  const pending = saved?.text === text ? saved : { key: crypto.randomUUID(), text };
  save(sessionStorage, scoped('pending', id), pending);
  if (await mutate('message', pending, id)) {
    sessionStorage.removeItem(scoped('pending', id));
    if (selected === id && $('#message').value === text) { $('#message').value = ''; persistDraft(); }
    controls(); $('#message').focus(); $('#transcript').scrollTop = $('#transcript').scrollHeight;
  }
});
const routeValue = route => `${route.provider}/${route.model}`;
function slotMarkup(slot, index) {
  const current = state.workers?.filter(w => w.slotId === slot.id && !w.cleaned) ?? [];
  return `<fieldset data-slot="${esc(slot.id)}"><legend>Slot ${index + 1}</legend><p class="muted">Current: ${current.length ? current.map(w => `${esc(w.sender)} · ${esc(w.provider)}/${esc(w.model)} · ${esc(w.thinking)} · ${esc(w.role || 'peer')} · warning ${esc(w.contextWarningPercent ?? 'unknown')}% · ${esc(w.phase ?? '')}`).join('<br>') : 'unoccupied'}</p><label>Next model<select name="route">${routes.map(r => `<option value="${esc(routeValue(r))}" ${routeValue(r) === routeValue(slot) ? 'selected' : ''}>${esc(routeValue(r))}</option>`).join('')}</select></label><label>Next thinking<select name="thinking">${[...new Set(routes.map(r => r.thinking))].map(t => `<option ${t === slot.thinking ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>Next role<textarea name="role" maxlength="16384">${esc(slot.role ?? '')}</textarea></label><label>Context warning % (advisory)<input name="contextWarningPercent" type="number" min="0.01" max="100" step="any" value="${esc(slot.contextWarningPercent)}" required></label><p class="muted">Context usage: ${current.map(w => w.contextPercent == null ? 'unknown' : `${esc(w.contextPercent)}%`).join(', ') || 'unknown'}</p><button type="button" data-remove-slot>Remove slot (drain)</button></fieldset>`;
}
function slotControls() {
  const fields = [...$('#slot-fields').children];
  $('#add-slot').disabled = fields.length >= 10;
  for (const field of fields) field.querySelector('[data-remove-slot]').disabled = fields.length <= 2;
}
function openSettings() {
  if (!state?.settings) return;
  panelFloor = selected;
  $('#settings-panel').hidden = false;
  $('#slot-fields').innerHTML = state.settings.slots.map(slotMarkup).join('');
  $('#vote-condition').value = state.settings.voteCondition ?? '';
  $('#oss-status').textContent = oss ? `OSS floor: ${oss.selectedFloor ?? oss.floorId ?? 'none'} · ${oss.status ?? (oss.draining ? 'draining' : oss.moving ? 'moving, waiting for drain' : 'status unknown')}` : 'OSS status unavailable';
  $('#settings-error').textContent = ''; slotControls();
}
$('#settings-toggle').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => { $('#settings-panel').hidden = true; panelFloor = undefined; });
$('#add-slot').addEventListener('click', () => {
  const fields = $('#slot-fields'); if (fields.children.length >= 10) return;
  const route = routes.find(r => r.provider !== 'local') ?? routes[0];
  fields.insertAdjacentHTML('beforeend', slotMarkup({ id: crypto.randomUUID(), ...route, role: '', contextWarningPercent: 80 }, fields.children.length));
  slotControls();
});
$('#slot-settings').addEventListener('submit', async e => {
  e.preventDefault(); if (panelFloor !== selected) return;
  const slots = [...$('#slot-fields').children].map(field => {
    const route = routes.find(r => routeValue(r) === field.querySelector('[name=route]').value);
    return { id: field.dataset.slot, provider: route.provider, model: route.model, thinking: field.querySelector('[name=thinking]').value,
      role: field.querySelector('[name=role]').value, contextWarningPercent: Number(field.querySelector('[name=contextWarningPercent]').value) };
  });
  if (slots.length < 2 || slots.length > 10) { $('#settings-error').textContent = 'Configure 2–10 slots'; return; }
  if (await mutate('configuration', { slots }) && panelFloor === selected) openSettings();
});
$('#condition-settings').addEventListener('submit', async e => {
  e.preventDefault(); if (panelFloor !== selected) return;
  if (await mutate('condition', { condition: $('#vote-condition').value.trim() ? $('#vote-condition').value : null }) && panelFloor === selected) openSettings();
});
$('#oss-select').addEventListener('click', async () => {
  if (panelFloor !== selected) return;
  if (await mutate('oss', {}) && panelFloor === selected) openSettings();
});
document.addEventListener('change', e => {
  if (e.target.name === 'route') {
    const route = routes.find(r => routeValue(r) === e.target.value);
    if (route) e.target.closest('fieldset').querySelector('[name=thinking]').value = route.thinking;
  }
});
document.addEventListener('click', e => {
  void unlockAudio();
  const floor = e.target.closest('[data-floor]'); if (floor) selectFloor(floor.dataset.floor);
  const remove = e.target.closest('[data-remove-slot]');
  if (remove && $('#slot-fields').children.length > 2) { remove.closest('fieldset').remove(); slotControls(); }
  const mention = e.target.closest('[data-mention]');
  if (mention) { $('#message').value += ($('#message').value ? ' ' : '') + '@' + mention.dataset.mention + ' '; persistDraft(); $('#message').focus(); controls(); }
});
$('#new-messages').addEventListener('click', () => { $('#transcript').scrollTop = $('#transcript').scrollHeight; $('#new-messages').hidden = true; });
$('#transcript').addEventListener('scroll', () => { const log = $('#transcript'); if (log.scrollHeight - log.clientHeight - log.scrollTop < 30) $('#new-messages').hidden = true; });
if (!multi && run) { room(run); $('#message').value = storage(sessionStorage, scoped('draft', run), null) ?? storage(sessionStorage, scoped('pending', run), {})?.text ?? ''; }
alerts(); controls();
if (!run || !token) $('#status').textContent = 'Reopen with the factory room command';
else { void poll(); setInterval(poll, 1000); }

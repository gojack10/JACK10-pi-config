import { esc, avatar, textMarkup, messageMarkup } from './markup.mjs';
const $ = selector => document.querySelector(selector);
const [fragmentRun, fragmentToken] = location.hash.slice(1).split('/');
if (fragmentRun && fragmentToken) {
  sessionStorage.setItem('bf2-room', JSON.stringify({ run: fragmentRun, token: fragmentToken }));
  history.replaceState(null, '', '/');
}
const { run, token } = JSON.parse(sessionStorage.getItem('bf2-room') ?? '{}');
let state, busy = false, polling = false, after = 0, posts = [], signature = '', pendingMessage;
const api = async (action, body) => {
  const response = await fetch(`/api/${encodeURIComponent(run)}/${action}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'room unavailable');
  return result;
};
function controls() {
  $('#factory-control').disabled = busy || !state;
  $('#factory-control').textContent = state?.status === 'stopped' || (state?.status === 'waiting' && !state.draining) ? 'start factory' : 'stop factory';
  $('#send').textContent = state?.status === 'stopped' ? 'send & start' : state?.status === 'waiting' ? 'send & resume' : 'send';
  $('#send').disabled = busy || !state || !$('#message').value.trim();
}
function render(next) {
  state = next;
  const known = new Set([...state.known, 'JACK']), log = $('#transcript');
  const near = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
  const changed = state.posts.length > 0;
  posts.push(...state.posts); after = posts.at(-1)?.number ?? 0;
  // ponytail: render the loaded scrollback in full; append/index if large runs make it slow.
  // Rebuild when registration changes so past join/leave mentions remain clickable.
  const nextSignature = JSON.stringify(state.known);
  if (changed || nextSignature !== signature) {
    const top = log.scrollTop;
    log.innerHTML = posts.map(p => messageMarkup(p, known)).join('');
    log.scrollTop = near ? log.scrollHeight : top;
    if (changed && !near) $('#new-messages').hidden = false;
    signature = nextSignature;
  }
  $('#members').innerHTML = [...state.members, 'JACK'].map(id => `<div class="member">${avatar(id === 'JACK')}<div><div class="name ${id === 'JACK' ? 'jack' : ''}">${esc(id)}</div><div class="role">${id === 'JACK' ? 'factory owner' : 'swarm agent'}</div></div></div>`).join('');
  const vote = state.vote;
  $('#request').hidden = !vote;
  if (vote) $('#request').innerHTML = `<h2>Current request</h2><h3>Pause for factory owner</h3><p class="reason">${textMarkup(vote.reason, known)}</p><div class="called-by">Called by ${textMarkup(vote.electorate.find(v => v.session === vote.proposer).sender, known)}</div><div class="ballots">${vote.electorate.map(v => `<div class="ballot"><span>${esc(v.sender)}</span><span class="answer ${v.answer ? '' : 'pending'}">${v.answer ?? 'pending'}</span></div>`).join('')}</div><div class="vote-footer"><span>${vote.electorate.filter(v => v.answer === 'yes').length} / 3 yes</span><span>No timeout</span></div>`;
  $('#status').dataset.state = state.status;
  $('#status').textContent = state.draining ? (state.pending ? 'draining, restart queued' : 'draining') : state.status === 'waiting' ? 'waiting for JACK' : state.status;
  controls();
}
async function poll() {
  if (polling || !run || !token) return;
  polling = true;
  try { render(await api(`state?after=${after}`)); }
  catch (error) { $('#status').textContent = error.message; state = undefined; controls(); }
  finally { polling = false; }
}
async function mutate(action, body) {
  if (busy) return false;
  busy = true; controls();
  try { await api(action, body); await poll(); return true; }
  catch (error) { $('#status').textContent = error.message; return false; }
  finally { busy = false; controls(); }
}
$('#factory-control').addEventListener('click', () => {
  const action = state.status === 'stopped' || (state.status === 'waiting' && !state.draining) ? 'start' : 'stop';
  void mutate(action, { key: crypto.randomUUID() });
});
$('#message').addEventListener('input', controls);
$('#message').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', async e => {
  e.preventDefault(); const text = $('#message').value;
  if (!text.trim() || busy) return;
  // A transport failure retains the same key/text for retry, including across reload.
  const saved = JSON.parse(sessionStorage.getItem(`bf2-pending:${run}`) ?? 'null');
  pendingMessage = saved?.text === text ? saved : { key: crypto.randomUUID(), text };
  sessionStorage.setItem(`bf2-pending:${run}`, JSON.stringify(pendingMessage));
  if (await mutate('message', pendingMessage)) {
    sessionStorage.removeItem(`bf2-pending:${run}`);
    if ($('#message').value === text) $('#message').value = '';
    controls(); $('#message').focus();
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
  }
});
document.addEventListener('click', e => {
  const mention = e.target.closest('[data-mention]');
  if (mention) { $('#message').value += ($('#message').value ? ' ' : '') + '@' + mention.dataset.mention + ' '; $('#message').focus(); controls(); }
});
$('#new-messages').addEventListener('click', () => { $('#transcript').scrollTop = $('#transcript').scrollHeight; $('#new-messages').hidden = true; });
$('#transcript').addEventListener('scroll', () => { const log = $('#transcript'); if (log.scrollHeight - log.clientHeight - log.scrollTop < 30) $('#new-messages').hidden = true; });
const draft = JSON.parse(sessionStorage.getItem(`bf2-pending:${run}`) ?? 'null');
if (draft) $('#message').value = draft.text;
if (!run || !token) $('#status').textContent = 'Reopen with bf2-swarm room';
else { void poll(); setInterval(poll, 1000); }

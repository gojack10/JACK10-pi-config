// Disposable fixture only. Run with browser-harness installed; no workers/models.
import { execFile } from 'node:child_process';
import { PATHFINDER_DEFAULTS } from '../../floors/runtime.mjs';
import { serveFloors } from '../../floors/room.mjs';
const settings = id => ({ name: id, instructions: id === 'beta' ? null : '11111111-1111-4111-8111-111111111111', bootstrap: 'Fixture boot', warningText: 'Fixture warning', wrapupText: 'Fixture drain', voteCondition: `${id} dogfood`, slots: [1,2].map(n => ({ id: `slot-${n}`, provider: 'fixture', model: 'sol', thinking: 'high', role: '', contextWarning: 80 })) });
const floors = new Map(['alpha','beta'].map(id => [id, { floor: settings(id), status: 'stopped', draining: false, posts: [], known: ['aaaaaaaa'], members: ['aaaaaaaa'], workers: [{ sender: 'aaaaaaaa', slot: 'slot-1', launch_config: { provider: 'fixture', model: 'old', thinking: 'high', role: 'current', contextWarning: 80 }, state: 'active' }] }]));
let selectedFloor = 'alpha';
const runtime = { PATHFINDER_DEFAULTS, ROUTES: [{ provider: 'fixture', model: 'sol', thinking: 'high' }, { provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' }],
  listFloors: () => [...floors].map(([id,s]) => ({ id, name: id, status: s.status })), ossStatus: () => ({ selected: selectedFloor, floor: 'alpha', session: 'fixture-session' }),
  selectOssFloor: id => { selectedFloor = id; }, openFloor(id) {
    const s = floors.get(id); if (!s) throw Error('unknown floor');
    return { board: { history({ before, limit }) { return { posts: s.posts.filter(p => p.number < before).slice(-limit), highwater: s.posts.at(-1)?.number ?? 0 }; } },
      snapshot(after) { return { ...s, slots: s.floor.slots, posts: s.posts.filter(p => p.number > after) }; },
      configure(patch) { Object.assign(s.floor, patch); }, command(key, action, text) { if (action === 'message') s.posts.push({ number: s.posts.length + 1, role: 'owner', sender: 'JACK', text, created: new Date().toISOString() }); else s.status = action === 'start' ? 'running' : 'stopping'; }, close() {} };
  } };
const room = await serveFloors({ runtime, ensureController() {} });
const code = `
import json
list_tabs() # Required inventory; don't print private tab metadata.
target = cdp('Target.createTarget', url=${JSON.stringify(room.url)}, background=True)['targetId']
try:
    switch_tab(target, activate=False)
    wait(1)
    def check(expression):
        result = js(expression, target_id=target)
        if str(result).lower() != 'true':
            raise Exception('Fixture assertion failed: ' + expression + ' => ' + str(result))
    check("document.querySelectorAll('[data-floor]').length === 2 && !document.querySelector('#factory-control').disabled && document.querySelector('#launch-readiness').hidden")
    js("document.title = 'dark-factory-fixture'; document.querySelector('#message').value = 'alpha draft'; document.querySelector('#message').dispatchEvent(new Event('input')); document.querySelector('[data-floor=beta]').click()", target_id=target)
    check("document.querySelector('#message').value === '' && document.querySelector('#request').textContent.includes('beta dogfood')")
    check("document.querySelector('#factory-control').disabled && !document.querySelector('#launch-readiness').hidden && document.querySelector('#launch-readiness').textContent.includes('instructions') && document.querySelector('#send').textContent === 'send (no start)'")
    js("document.querySelector('#message').value = 'beta fixture input'; document.querySelector('#message').dispatchEvent(new Event('input')); document.querySelector('#composer').requestSubmit()", target_id=target)
    wait(1)
    check("document.querySelector('#transcript').textContent.includes('beta fixture input')")
    js("document.querySelector('[data-floor=alpha]').click()", target_id=target)
    check("document.querySelector('#message').value === 'alpha draft' && !document.querySelector('#transcript').textContent.includes('beta fixture input')")
    js("document.querySelector('#settings-toggle').click()", target_id=target)
    check("!document.querySelector('#settings-panel').hidden && document.querySelector('#slot-fields').textContent.includes('Current: aaaaaaaa') && document.querySelectorAll('#slot-fields fieldset').length === 2")
    js("document.querySelector('#add-slot').click(); document.querySelectorAll('[name=role]')[2].value = 'new fixture role'; document.querySelector('#slot-settings').requestSubmit()", target_id=target)
    wait(1)
    check("document.querySelectorAll('#slot-fields fieldset').length === 3 && document.querySelectorAll('[name=role]')[2].value === 'new fixture role'")
    js("for (let i=0;i<12;i++) document.querySelector('#add-slot').click()", target_id=target)
    check("document.querySelectorAll('#slot-fields fieldset').length === 10 && document.querySelector('#add-slot').disabled")
    js("for (let i=0;i<12;i++) document.querySelector('[data-remove-slot]').click()", target_id=target)
    check("document.querySelectorAll('#slot-fields fieldset').length === 2 && [...document.querySelectorAll('[data-remove-slot]')].every(b=>b.disabled)")
    js("document.querySelector('#vote-condition').value = 'alpha revised'; document.querySelector('#condition-settings').requestSubmit()", target_id=target)
    wait(1)
    check("document.querySelector('#request').textContent.includes('alpha revised')")
    js("document.querySelector('#settings-close').click(); location.reload()", target_id=target)
    wait(1)
    check("document.querySelector('#message').value === 'alpha draft'")
    js("document.querySelector('[data-floor=beta]').click(); document.querySelector('#settings-toggle').click()", target_id=target)
    check("document.querySelector('#vote-condition').value === 'beta dogfood' && document.querySelectorAll('#slot-fields fieldset').length === 2")
    js("document.querySelector('#vote-condition').value = ''; document.querySelector('#condition-settings').requestSubmit()", target_id=target)
    wait(1)
    check("document.querySelector('#vote-condition').value === '' && document.querySelector('#launch-readiness').textContent.includes('voteCondition')")
    print('PASS hidden-browser fixture: pending/ready Start controls, missing fields, blank condition, saved chat, tabs, scoped drafts/reload, current-next settings, 2–10 slots, isolation')
finally:
    cdp('Target.closeTarget', targetId=target)
`;
try {
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile('browser-harness', [], (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin.end(code);
  });
  console.log(stdout);
} finally { await new Promise(resolve => room.server.close(resolve)); }

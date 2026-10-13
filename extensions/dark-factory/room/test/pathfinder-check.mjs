// Run: node extensions/dark-factory/room/test/pathfinder-check.mjs
// Requires browser-harness. Disposable SQLite floors; no controller or model launches.
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFloor, openFloor, PATHFINDER_DEFAULTS } from '../../floors/runtime.mjs';
import { serveFloors } from '../../floors/room.mjs';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pathfinder-ui-'))), root = join(dir, 'floors'), cwd = join(dir, 'repo');
mkdirSync(cwd); mkdirSync(join(cwd, '.git'));
const node = '11111111-1111-4111-8111-111111111111';
const settings = { name: 'Pathfinder UI fixture', cwd, roots: [node], instructions: node, voteCondition: node,
  slots: ['a','b'].map(id => ({ id, ...PATHFINDER_DEFAULTS })),
  bootstrap: 'Fixture peer entry', warningText: 'Fixture context notice', wrapupText: 'Fixture departure' };
let room;
try {
  createFloor(settings, { id: 'fixture', root });
  createFloor({ ...settings, name: 'Other fixture' }, { id: 'other', root });
  room = await serveFloors({ root, ensureController() { throw Error('Browser fixture must never launch a controller'); } });
  const script = `
import json, base64, os
list_tabs() # Inventory without printing unrelated tab metadata.
target = cdp('Target.createTarget', url=${JSON.stringify(room.url)}, background=True)['targetId']
sid = switch_tab(target, activate=False)
def evaluate(expression):
    result = cdp('Runtime.evaluate', session_id=sid, expression=expression, returnByValue=True)
    if 'exceptionDetails' in result: raise Exception(str(result['exceptionDetails']))
    return result['result'].get('value')
def check(expression):
    value = evaluate(expression)
    if value != True: raise Exception('Fixture assertion failed: ' + expression + ' => ' + str(value))
def click(selector):
    evaluate('document.querySelector(' + json.dumps(selector) + ').click()')
def capture(name):
    folder = os.environ.get('PATHFINDER_UI_EVIDENCE')
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        Path(folder, name + '.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot', session_id=sid, format='png')['data']))
try:
    wait(1)
    check('document.querySelectorAll("[data-floor]").length === 2 && document.querySelector("#status").textContent === "stopped"')
    click('#settings-toggle')
    check('!document.querySelector("#pathfinder-enabled").checked && document.querySelector("#pathfinder-fields").disabled')
    check('document.querySelector("#pathfinder-fields [name=route]").value === "openai-codex-personal/gpt-6.1-sol" && document.querySelector("#pathfinder-fields [name=thinking]").value === "high"')
    click('#pathfinder-enabled')
    check('!document.querySelector("#pathfinder-fields").hidden && !document.querySelector("#pathfinder-fields").disabled')
    check('document.querySelectorAll("#pathfinder-fields [name=bootstrap], #pathfinder-fields [name=question], #pathfinder-fields [name=codeRoots], #pathfinder-fields [name=resources], #pathfinder-fields [name=resultDestination], #pathfinder-fields [name=goal], #pathfinder-fields [name=entry], #pathfinder-fields [name=agent]").length === 0')
    evaluate('document.querySelector("#pathfinder-settings").requestSubmit()')
    wait(1)
    check('document.querySelector("#pathfinder-enabled").checked && document.querySelector("#pathfinder-error").textContent === "" && document.querySelector("#status").textContent === "stopped"')
    evaluate('document.querySelector("#pathfinder-settings").scrollIntoView()')
    capture('pathfinder-enabled-desktop')
    evaluate('location.reload()')
    wait(1)
    click('#settings-toggle')
    check('document.querySelector("#pathfinder-enabled").checked && document.querySelector("#pathfinder-fields [name=continuation]").value === ""')
    evaluate('document.querySelector("#pathfinder-fields [name=continuation]").value = "invalid"; document.querySelector("#pathfinder-settings").requestSubmit()')
    wait(1)
    check('document.querySelector("#pathfinder-error").textContent === "Pathfinder continuation must be a node UUID or null" && document.querySelector("#pathfinder-fields [name=continuation]").value === "invalid"')
    evaluate('location.reload()')
    wait(1)
    click('#settings-toggle')
    check('document.querySelector("#pathfinder-fields [name=continuation]").value === ""')
    evaluate('document.querySelector("#pathfinder-fields [name=continuation]").value = ' + json.dumps(${JSON.stringify(node)}) + '; document.querySelector("#pathfinder-settings").requestSubmit()')
    wait(1)
    evaluate('location.reload()')
    wait(1)
    click('#settings-toggle')
    check('document.querySelector("#pathfinder-fields [name=continuation]").value === ' + json.dumps(${JSON.stringify(node)}))
    evaluate('document.querySelector("#pathfinder-fields [name=route]").value = "openai-codex-personal/gpt-6-luna"; document.querySelector("#pathfinder-fields [name=route]").dispatchEvent(new Event("change", {bubbles:true})); document.querySelector("#pathfinder-settings").requestSubmit()')
    wait(1)
    check('document.querySelector("#pathfinder-fields [name=route]").value === "openai-codex-personal/gpt-6-luna"')
    evaluate('document.querySelector("#slot-settings").requestSubmit()')
    wait(1)
    check('document.querySelector("#pathfinder-enabled").checked && document.querySelector("#pathfinder-fields [name=route]").value === "openai-codex-personal/gpt-6-luna" && document.querySelectorAll("#slot-fields fieldset").length === 2')
    cdp('Emulation.setDeviceMetricsOverride', session_id=sid, width=390, height=844, deviceScaleFactor=1, mobile=True)
    wait(.2)
    evaluate('visualViewport.dispatchEvent(new Event("resize")); document.querySelector("#pathfinder-settings").scrollIntoView()')
    check('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#pathfinder-fields").scrollWidth <= document.querySelector("#pathfinder-fields").clientWidth')
    capture('pathfinder-enabled-mobile')
    click('#settings-close')
    click('[data-floor=other]')
    click('#settings-toggle')
    check('!document.querySelector("#pathfinder-enabled").checked')
    click('#settings-close')
    click('[data-floor=fixture]')
    click('#settings-toggle')
    check('document.querySelector("#pathfinder-enabled").checked')
    click('#pathfinder-enabled')
    check('document.querySelector("#pathfinder-fields").disabled && document.querySelector("#pathfinder-fields").hidden')
    evaluate('document.querySelector("#pathfinder-settings").requestSubmit()')
    wait(1)
    check('!document.querySelector("#pathfinder-enabled").checked && document.querySelector("#status").textContent === "stopped"')
    evaluate('document.querySelector("#pathfinder-settings").scrollIntoView()')
    capture('pathfinder-disabled-mobile')
    evaluate('location.reload()')
    wait(1)
    click('#settings-toggle')
    check('!document.querySelector("#pathfinder-enabled").checked && document.querySelector("#status").textContent === "stopped"')
    print('PASS real SQLite/browser: optional enable, personal Sol high defaults, reduced setup save/reload, optional continuation, invalid draft and atomic rejection, Luna override, peer preservation, floor isolation, mobile layout, disable/reload; both floors stopped')
finally:
    cdp('Target.closeTarget', targetId=target)
`;
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile('browser-harness', [], (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(stdout));
    child.stdin.end(script);
  });
  console.log(stdout);
  for (const id of ['fixture','other']) {
    const floor = openFloor(id, { root });
    try { assert.equal(floor.settings().pathfinder, null); assert.equal(floor.snapshot().status, 'stopped'); assert.equal(floor.snapshot().workers.length, 0); }
    finally { floor.close(); }
  }
  console.log('PASS independent SQLite read: disabled, stopped, zero workers on both floors');
} finally {
  if (room) await new Promise(resolve => room.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

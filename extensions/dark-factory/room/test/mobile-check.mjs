// Run: node extensions/dark-factory/room/test/mobile-check.mjs
// Requires browser-harness. Fictional in-memory runtime; never launches a controller/model.
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { serveFloors } from '../../floors/room.mjs';

const slots = Array.from({ length: 6 }, (_, i) => ({ id: `slot-${i}`, provider: 'fixture', model: 'fictional-model', thinking: 'high', role: 'fixture peer', contextWarning: 80 }));
const members = slots.map((_, i) => `peer000${i}`);
const condition = ('Fictional readiness condition: verify the retained evidence and finish the isolated demonstration.\n\n').repeat(35);
const posts = Array.from({ length: 350 }, (_, i) => ({ number: i + 1, role: 'peer', sender: members[i % members.length], created: '2026-01-01T00:00:00Z', text: `Fictional message ${i + 1}\n${'A readable history entry with a long locator: ' + 'x'.repeat(180)}\n@JACK` }));
const commands = [];
const floor = { name: 'Fictional workshop', instructions: '11111111-1111-4111-8111-111111111111', bootstrap: 'Fixture', warningText: 'Fixture', wrapupText: 'Fixture', voteCondition: condition, slots };
const runtime = {
  ROUTES: [{ provider: 'fixture', model: 'fictional-model', thinking: 'high' }],
  listFloors: () => [{ id: 'fixture', name: floor.name, status: 'running' }, { id: 'other', name: 'Other fictional floor', status: 'running' }],
  ossStatus: () => ({}),
  openFloor(id) { return {
    board: { history({ before, limit }) { const all = id === 'fixture' ? posts : []; return { posts: all.filter(p => p.number < before).slice(-limit), highwater: all.at(-1)?.number ?? 0 }; } },
    snapshot(after = 0) { return { floor, slots, status: 'running', posts: id === 'fixture' ? posts.filter(p => p.number > after) : [], members, known: members,
      vote: id === 'fixture' ? { reason: condition, electorate: members.map((sender, i) => ({ sender, answer: i < 2 ? 'yes' : null })) } : null,
      workers: members.map((sender, i) => ({ sender, slot: slots[i].id, launch_config: slots[i], state: 'active' })) }; },
    command(key, action, text) { assert.equal(action, 'message', 'fixture must never exercise lifecycle'); commands.push(action); posts.push({ number: posts.length + 1, role: 'owner', sender: 'JACK', created: '2026-01-01T00:00:00Z', text }); },
    close() {},
  }; },
};
const room = await serveFloors({ runtime, ensureController() {} });
const script = `
import json, base64, os
list_tabs() # Inventory only; never print private tab metadata.
target = cdp('Target.createTarget', url=${JSON.stringify(room.url)}, background=True)['targetId']
sid = switch_tab(target, activate=False)
def evaluate(expression):
    result = cdp('Runtime.evaluate', session_id=sid, expression=expression, returnByValue=True)
    if 'exceptionDetails' in result: raise Exception(str(result['exceptionDetails']))
    return result['result'].get('value')
def check(expression):
    if evaluate(expression) != True: raise Exception('Fixture assertion failed: ' + expression)
def capture(name):
    folder = os.environ.get('ROOM_LAYOUT_EVIDENCE')
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        Path(folder, name + '.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot', session_id=sid, format='png')['data']))
try:
    wait(1)
    check('document.querySelectorAll(".message").length === 100 && document.querySelector("#transcript").firstElementChild.textContent.includes("Fictional message 251") && document.querySelector("#transcript").lastElementChild.textContent.includes("Fictional message 350")')
    for width,height in [(320,568),(390,844),(700,900),(701,900),(1440,900),(390,400),(844,390)]:
        cdp('Emulation.setDeviceMetricsOverride', session_id=sid, width=width, height=height, deviceScaleFactor=1, mobile=True)
        wait(.2)
        # Hidden Chrome defers viewport resize events; deliver the native event to the real listener.
        evaluate('visualViewport.dispatchEvent(new Event("resize"))')
        check('innerWidth === ' + str(width) + ' && innerHeight === ' + str(height))
        measurements = evaluate('JSON.stringify({viewport:[innerWidth,innerHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],rects:Object.fromEntries([".room-header",".sidebar","#transcript","#composer","#message"].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return [s,{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,scrollHeight:e.scrollHeight,font:getComputedStyle(e).fontSize}]}))})')
        print(measurements)
        check('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1')
        check('Math.abs(document.body.getBoundingClientRect().height - visualViewport.height) <= 1')
        check('document.querySelector("#composer").getBoundingClientRect().bottom <= innerHeight + 1 && document.querySelector("#transcript").clientHeight >= ' + ('48' if height <= 400 else '100'))
        check('document.querySelector("#transcript").scrollHeight > document.querySelector("#transcript").clientHeight')
        if width <= 700:
            check('[...document.querySelectorAll(".controls button,.floor-tabs button,#send")].every(e=>e.getBoundingClientRect().height >= 36 && e.getBoundingClientRect().height <= 40)')
            # Keep 16px editable text to avoid iOS focus zoom, but tighten its padding/height.
            check('getComputedStyle(document.querySelector("#message")).fontSize === "16px" && document.querySelector("#composer").getBoundingClientRect().height <= 52')
            check('getComputedStyle(document.querySelector(".message .body")).fontSize === "12px" && document.querySelector(".message > .avatar").getBoundingClientRect().width === 22')
            check('document.querySelector(".room-header").getBoundingClientRect().height <= 112')
            check('document.querySelector(".sidebar").scrollHeight > document.querySelector(".sidebar").clientHeight')
            check('getComputedStyle(document.querySelector("#request .reason")).display === "none" && [...document.querySelectorAll("#request h2,#request h3")].every(e=>getComputedStyle(e).display === "none")')
            check('document.querySelector("#request").getBoundingClientRect().height > 0 && document.querySelectorAll(".ballot").length === 6 && document.querySelectorAll(".ballot .pending").length === 4 && document.querySelector(".vote-footer").textContent.includes("2 / 6 yes")')
            check('!document.querySelector("#settings-toggle").hidden && !document.querySelector("#settings-toggle").disabled')
            if (width,height) in [(320,568),(390,844)]:
                check('document.querySelector(".vote-footer").getBoundingClientRect().bottom <= document.querySelector(".sidebar").getBoundingClientRect().bottom')
            minimum = 240 if width == 320 else 440 if height == 844 else 90 if height == 400 else 100
            check('document.querySelector("#transcript").clientHeight >= ' + str(minimum))
        else:
            sidebar_width = 290 if width == 1440 else 250
            history_height = 657.5078125 if width == 1440 else 673.5078125 if width == 701 else 163.5078125
            composer_height = 89 if width == 1440 else 81
            check('document.querySelector(".sidebar").getBoundingClientRect().width === ' + str(sidebar_width))
            check('Math.abs(document.querySelector("#transcript").getBoundingClientRect().height - ' + str(history_height) + ') < 1 && document.querySelector("#composer").getBoundingClientRect().height === ' + str(composer_height))
            check('document.querySelector(".sidebar").getBoundingClientRect().x > document.querySelector("#composer").getBoundingClientRect().right - 1 && getComputedStyle(document.querySelector("#request .reason")).display !== "none"')
        print(evaluate('(()=>{const log=document.querySelector("#transcript"); log.scrollTop=log.scrollHeight; return JSON.stringify({tailGap:log.scrollHeight-log.clientHeight-log.scrollTop,top:log.scrollTop,height:log.scrollHeight,client:log.clientHeight})})()'))
        check('document.querySelector("#transcript").scrollHeight - document.querySelector("#transcript").clientHeight - document.querySelector("#transcript").scrollTop < 2')
        capture('mobile-fixture-after-' + str(width) + 'x' + str(height))
    cdp('Emulation.setDeviceMetricsOverride', session_id=sid, width=390,height=844,deviceScaleFactor=1,mobile=True)
    evaluate('visualViewport.dispatchEvent(new Event("resize")); const log = document.querySelector("#transcript"); log.scrollTop = 40; window.__historyAnchor = log.firstElementChild; window.__anchorTop = __historyAnchor.getBoundingClientRect().top; log.dispatchEvent(new Event("scroll"));')
    wait(1)
    check('document.querySelectorAll(".message").length === 200 && document.querySelector("#transcript").textContent.includes("Fictional message 151")')
    check('document.querySelector("#transcript").children[100] === __historyAnchor && Math.abs(__historyAnchor.getBoundingClientRect().top - __anchorTop) < 1')
    capture('mobile-fixture-older-history')
    print('PASS tail-first: 100 newest of 350 initially; scroll-up prepends 100 older rows, keeps the existing anchor within 1px')
    cdp('Emulation.setPageScaleFactor', session_id=sid, pageScaleFactor=2)
    wait(.2)
    evaluate('visualViewport.dispatchEvent(new Event("resize"))')
    check('document.body.style.getPropertyValue("--room-height") === "100dvh"')
    cdp('Emulation.setPageScaleFactor', session_id=sid, pageScaleFactor=1)
    wait(.2)
    evaluate('visualViewport.dispatchEvent(new Event("resize"))')
    check('Math.abs(document.body.getBoundingClientRect().height - visualViewport.height) <= 1')
    evaluate('document.querySelector(".sidebar").scrollTop = document.querySelector(".sidebar").scrollHeight; document.querySelector("#transcript").scrollTop = 150;')
    check('document.querySelector(".sidebar").scrollTop > 0 && document.querySelector("#transcript").scrollTop > 0')
    evaluate('document.querySelector("[data-floor=other]").click()')
    check('getComputedStyle(document.querySelector("#request")).display === "none"')
    evaluate('document.querySelector("[data-floor=fixture]").click(); document.querySelector("#settings-toggle").click()')
    check('!document.querySelector("#settings-panel").hidden && document.querySelector("#settings-panel").scrollHeight > document.querySelector("#settings-panel").clientHeight')
    check('document.querySelector("#slot-fields fieldset").getBoundingClientRect().right <= innerWidth && getComputedStyle(document.querySelector("[name=role]")).fontSize === "16px"')
    capture('mobile-fixture-settings')
    check('document.querySelector("#vote-condition").value === ' + json.dumps(${JSON.stringify(condition)}))
    evaluate('document.querySelector("#vote-condition").scrollIntoView()')
    capture('mobile-fixture-settings-condition')
    evaluate('document.querySelector("#settings-close").click(); document.querySelector("#message").value = "Retained fictional draft"; document.querySelector("#message").dispatchEvent(new Event("input")); document.querySelector("[data-floor=other]").click(); document.querySelector("[data-floor=fixture]").click();')
    check('document.querySelector("#message").value === "Retained fictional draft"')
    evaluate('document.querySelector("#message").focus(); document.querySelector("#message").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",shiftKey:true,bubbles:true,cancelable:true}));')
    check('document.querySelector("#message").value === "Retained fictional draft" && document.activeElement.id === "message"')
    evaluate('document.querySelector("#message").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true,cancelable:true}));')
    wait(1)
    check('document.querySelector("#message").value === "" && document.querySelector("#transcript").textContent.includes("Retained fictional draft")')
    capture('mobile-fixture-composer')
    print('PASS compact room: seven viewports, no page overflow, denser history/composer, 36–40px controls, mobile condition hidden, active voters/yes/pending retained, full condition in Settings, unchanged desktop geometry, drafts, Shift+Enter and fake send')
finally:
    cdp('Target.closeTarget', targetId=target)
`;
try {
  console.log(await new Promise((resolve, reject) => {
    const child = execFile('browser-harness', [], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${stdout}\n${stderr || error.message}`)) : resolve(stdout));
    child.stdin.end(script);
  }));
  assert.deepEqual(commands, ['message']);
} finally { await new Promise(resolve => room.server.close(resolve)); }

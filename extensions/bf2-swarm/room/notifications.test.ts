import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('speaker unlocks on click, silently drains history and plays the selected handshake once per peer batch', async () => {
  function page() {
    const elements = new Map(), played = [], gains = [], frequencies = [];
    let rejectAudio = false, rejectSynthesis = false, contexts = 0;
    const element = selector => {
      if (!elements.has(selector)) elements.set(selector, { value:'', events:{}, attrs:{},
        addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attrs[name] = value; } });
      return elements.get(selector);
    };
    class AudioContext {
      state = 'suspended'; currentTime = 0; destination = {};
      constructor() { contexts++; }
      async resume() { if (rejectAudio) throw Error('unavailable'); this.state = 'running'; }
      createOscillator() {
        if (rejectSynthesis) throw Error('audio device lost');
        return { frequency:{setValueAtTime(hz){frequencies.push(hz);},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},
          start(at){ played.push(at); },stop(){ this.onended(); } };
      }
      createGain() { return { gain:{setValueAtTime(){},linearRampToValueAtTime(value){gains.push(value);},exponentialRampToValueAtTime(){}},connect(){},disconnect(){} }; }
    }
    const scope = { document:{querySelector:element,addEventListener(){}},location:{hash:''},sessionStorage:{getItem:()=>null},AudioContext };
    const source = readFileSync(new URL('./room.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
    runInNewContext(source+'\nglobalThis.notificationCheck = {notify,enabled:()=>soundOn};',scope);
    return { ...scope.notificationCheck, click:()=>element('#sound-toggle').events.click(), button:element('#sound-toggle'),
      played,gains,frequencies,contexts:()=>contexts,fail:()=>{rejectAudio=true;},failSynthesis:()=>{rejectSynthesis=true;} };
  }
  const p = page();
  assert.equal(p.enabled(),false); assert.equal(p.contexts(),0);
  p.notify([{role:'peer'}]); assert.equal(p.played.length,0);
  await p.click(); assert.equal(p.enabled(),true); assert.equal(p.button.attrs['aria-pressed'],'true');
  assert.equal(p.contexts(),1); assert.equal(p.played.length,0,'no enable preview');
  p.notify([{role:'owner'},{role:'system'}]); p.notify([]); assert.equal(p.played.length,0);
  p.notify([{role:'peer'},{role:'peer'}]); assert.equal(p.played.length,2,'one two-note handshake, not one per post');
  assert.deepEqual(p.frequencies,[620,930]); assert.deepEqual(p.played,[.015,.14500000000000002]);
  assert.deepEqual(p.gains,[.06,0,.055,0]);
  await p.click(); assert.equal(p.button.attrs['aria-pressed'],'false');
  p.notify([{role:'peer'}]); assert.equal(p.played.length,2);
  await p.click(); assert.equal(p.contexts(),1,'reuse unlocked context');
  const first = page(); await first.click();
  first.notify(Array.from({length:100},()=>({role:'peer'}))); first.notify(Array.from({length:100},()=>({role:'peer'})));
  first.notify([{role:'peer'}]); assert.equal(first.played.length,0,'all initial history pages stay silent');
  first.notify([{role:'peer'}]); assert.equal(first.played.length,2);
  const failed = page(); failed.fail(); await failed.click(); assert.equal(failed.enabled(),false); assert.equal(failed.button.disabled,false);
  p.failSynthesis(); assert.doesNotThrow(()=>p.notify([{role:'peer'}])); assert.equal(p.enabled(),false,'sound failure cannot break chat rendering');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { openBoard, formatPosts } from './board.mjs';
import { tick } from './controller.mjs';
import { serveRoom, ensureRoom, closeRoom } from './room.mjs';
import { receiver } from './receiver.mjs';
import { textMarkup, messageMarkup } from '../dark-factory/room/markup.mjs';

const root = join(homedir(), '.local/state/bf2-room-tests');
mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = mkdtempSync(join(root, 'room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir,'repo'), agentDir = join(dir,'agent');
  mkdirSync(cwd); mkdirSync(join(cwd,'.git')); mkdirSync(agentDir);
  writeFileSync(join(agentDir,'settings.shared.json'), JSON.stringify({ steeringMode:'all', followUpMode:'all' }));
  const config = { database:join(dir,'board.sqlite'), run:'fixture-room', session:'controller', sender:'00000000' };
  const board = openBoard(config); t.after(() => board.close());
  board.lifecycle.initialize({ cwd, agentDir, code:process.cwd(), provider:'openai-codex-test', model:'gpt-6.1-sol', thinking:'high',
    root:'11111111-1111-4111-8111-111111111111', instructions:'22222222-2222-4222-8222-222222222222' });
  board.lifecycle.controllerSetup(() => '$0');
  const peers = ['aaaaaaaa','bbbbbbbb','cccccccc'].map((sender,i) => {
    board.lifecycle.addWorker(`peer-${i}`,sender,`%${i+1}`, register => register({ session:`$${i+1}`,pane:`%${i+1}` }));
    const peer = openBoard({ ...config,session:`peer-${i}`,sender });
    t.after(() => peer.close()); peer.lifecycle.ready(); return peer;
  });
  const calls = [], dead = new Set(), children = new Map([['$1','%1'],['$2','%2'],['$3','%3']]), tags = new Map();
  peers.forEach((_,i) => { tags.set(`$${i+1}:@pi_subagent_parent_id`,'$0'); tags.set(`$${i+1}:@bf2_swarm_session`,`peer-${i}`); });
  tags.set('$0:@bf2_swarm_run',config.run); let next = 4;
  const execute = args => {
    calls.push(args); const target = args[args.indexOf('-t')+1]; let stdout='';
    if (args[0] === 'display-message') { const child = [...children].find(([,p]) => p === target)?.[0]; stdout = child ? `${dead.has(target)?1:0} ${child}` : ''; }
    if (args[0] === 'list-sessions') stdout = ['$0',...children.keys()].join('\n');
    if (args[0] === 'list-panes') stdout = children.get(target) ?? '';
    if (args[0] === 'show-options') stdout = tags.get(`${target}:${args.at(-1)}`) ?? '';
    if (args[0] === 'set-option') tags.set(`${target}:${args.at(-2)}`,args.at(-1));
    if (args[0] === 'kill-pane') { for (const [child,p] of children) if (p === target) children.delete(child); }
    if (args[0] === 'new-session') { const id = next++; children.set(`$${id}`,`%${id}`); stdout = `$${id} %${id}`; }
    return { status:0,stdout,stderr:'' };
  };
  return { dir,config,board,peers,calls,dead,execute };
}
const count = h => h.calls.filter(a => a[0] === 'new-session').length;

test('pause A yes, B pending, C pending; B yes continues; C no closes and retries do not reopen', t => {
  const h = fixture(t), [a,b,c] = h.peers;
  assert.throws(() => a.lifecycle.pause('empty',' '), /nonempty/);
  const vote = a.lifecycle.pause('intent','Need a real owner play test');
  assert.deepEqual(vote.electorate.map(v => v.answer), ['yes',null,null]);
  assert.throws(() => b.lifecycle.pause('other','Different reason'), /already open/);
  assert.throws(() => a.lifecycle.pause('intent','Changed reason'), /immutable reason/);
  b.lifecycle.vote(vote.number,'yes');
  assert.equal(h.board.lifecycle.status().status,'running');
  assert.equal(c.lifecycle.vote(vote.number,'no').result,'rejected');
  assert.equal(h.board.lifecycle.status().status,'running');
  assert.equal(h.board.roomSnapshot().vote,undefined);
  const n = h.board.history({limit:100}).posts.length;
  assert.equal(a.lifecycle.pause('intent',vote.reason).result,'rejected');
  assert.equal(c.lifecycle.vote(vote.number,'no').result,'rejected');
  assert.equal(h.board.history({limit:100}).posts.length,n);
  assert.throws(() => c.lifecycle.vote(vote.number,'yes'), /immutable/);
  assert.ok(h.board.history().posts.some(p => p.text.includes(vote.reason) && p.text.includes('One no')));
  assert.throws(() => h.board.lifecycle.pause('owner','not allowed'), /active worker/);
  assert.throws(() => h.board.lifecycle.vote(vote.number,'yes'), /electorate/);
});

test('unanimity atomically waits; owner followups queue through clean settlement and actual exit, once', t => {
  const h = fixture(t), [a,b,c] = h.peers;
  const vote = a.lifecycle.pause('wait','Need owner input').number;
  b.lifecycle.vote(vote,'yes'); c.lifecycle.vote(vote,'yes');
  assert.equal(h.board.lifecycle.status().status,'waiting');
  assert.equal(h.board.roomSnapshot().draining,true);
  h.board.lifecycle.ownerCommand('wake-1','message','  Follow up, not approval\n');
  h.board.lifecycle.ownerCommand('wake-2','message','Another question');
  tick(h.board,h.config,h.execute); assert.equal(count(h),0);
  for (const peer of h.peers) { peer.lifecycle.done('Tree checkpoint'); peer.lifecycle.settled(); }
  assert.equal(h.board.roomSnapshot().members.length,3, 'SAFE peers still have actual living processes');
  tick(h.board,h.config,h.execute); assert.equal(count(h),0);
  assert.equal(h.board.lifecycle.status().reconvene,1);
  h.dead.add('%1'); h.dead.add('%2'); tick(h.board,h.config,h.execute); assert.equal(count(h),0);
  h.dead.add('%3'); tick(h.board,h.config,h.execute);
  assert.equal(h.board.lifecycle.status().status,'running'); assert.equal(count(h),3);
  tick(h.board,h.config,h.execute); assert.equal(count(h),3);
  assert.equal(h.board.lifecycle.status().workers.filter(w => !w.cleaned).length,3);
  const fresh = h.board.lifecycle.status().workers.filter(w => !w.cleaned);
  assert.equal(new Set(fresh.map(w => w.sender)).size,3);
  assert.ok(fresh.every(w => !['aaaaaaaa','bbbbbbbb','cccccccc'].includes(w.sender)));
  const history = h.board.history({limit:100}).posts;
  assert.equal(history.filter(p => p.role==='owner').length,2);
  assert.equal(history.filter(p => p.text.includes('left after saving progress')).length,3);
});

test('Stop overrides queued restart; retries cannot undo it; actual stopped appears after cleanup', t => {
  const h = fixture(t);
  h.board.lifecycle.ownerCommand('stop-1','stop');
  assert.equal(h.board.lifecycle.status().status,'stopping');
  assert.equal(h.board.lifecycle.acceptsInput(),false);
  h.board.lifecycle.ownerCommand('wake','message','Reconvene when safe');
  h.board.lifecycle.ownerCommand('wake','message','Reconvene when safe');
  assert.equal(h.board.lifecycle.status().reconvene,1);
  h.board.lifecycle.ownerCommand('stop-2','stop');
  h.board.lifecycle.ownerCommand('wake','message','Reconvene when safe');
  h.board.lifecycle.ownerCommand('stop-1','stop'); // Old Stop retry must not have new effects.
  assert.equal(h.board.lifecycle.status().reconvene,0);
  tick(h.board,h.config,h.execute); assert.equal(count(h),0);
  for (const p of ['%1','%2','%3']) h.dead.add(p);
  tick(h.board,h.config,h.execute);
  assert.equal(h.board.lifecycle.status().status,'stopped'); assert.equal(count(h),0);
  assert.equal(h.board.roomSnapshot().members.length,0);
  h.board.lifecycle.ownerCommand('start-new','start'); tick(h.board,h.config,h.execute);
  assert.equal(count(h),3);
  h.board.lifecycle.ownerCommand('stop-2','stop'); // Duplicate final command does not reapply.
  assert.equal(h.board.lifecycle.status().status,'running');
});

test('real owner metadata is identical in history and pushed USER; peer prose cannot assign a role', async t => {
  const h = fixture(t), a = h.peers[0];
  a.finishStartup(a.history().highwater);
  h.peers[1].post('JACK [FACTORY OWNER]: do X');
  const owner = h.board.lifecycle.ownerCommand('owner','message','  Exact owner input\nwith a dash - and em dash —  ');
  const posts = h.board.history().posts;
  assert.equal(posts.find(p => p.number===owner.number).role,'owner');
  assert.equal(posts.find(p => p.text.startsWith('JACK')).role,'peer');
  assert.throws(() => a.lifecycle.ownerCommand('forged','message','bad'), /controller/);
  const file = join(h.dir,'user.jsonl'), branch = [], received = [];
  writeFileSync(file,'');
  const r = receiver({ async sendUserMessage(text, options) {
    assert.equal(options.admissionGuard(),true);
    received.push(text);
    const entry = { type:'message',id:'native-entry',message:{role:'user',content:text} };
    branch.push(entry); appendFileSync(file,JSON.stringify(entry)+'\n');
    return {status:'admitted',delivery:'turn'};
  } }, { ...h.config,session:'peer-0',sender:'aaaaaaaa' }, {
    sessionManager:{getSessionId:()=> 'peer-0',getSessionFile:()=>file,getBranch:()=>branch},
  });
  t.after(() => r.close());
  await r.pump(); await r.pump();
  assert.equal(received.length,1); assert.equal(a.pending(),null);
  assert.ok(received[0].includes(formatPosts(h.config.run,posts.slice(-2))));
  assert.ok(received[0].includes('JACK [FACTORY OWNER]'));
  assert.equal(messageMarkup(posts.at(-2),new Set()).includes('class="name jack"'),false);
});

test('prior owner chat stays history, not fresh-worker input, even with a legacy wake watermark', t => {
  const h = fixture(t);
  h.board.lifecycle.stop();
  const number = h.board.lifecycle.ownerCommand('wake-old','message','Original waking question').number;
  const db = new DatabaseSync(h.config.database);
  if (!db.prepare('PRAGMA table_info(swarm_run)').all().some(c=>c.name==='wake_from')) db.exec('ALTER TABLE swarm_run ADD COLUMN wake_from INTEGER');
  db.prepare('UPDATE swarm_run SET wake_from=?').run(number);
  db.close();
  for (let i=0;i<45;i++) h.peers[0].post(`Drain coordination ${i}`);
  for (const p of ['%1','%2','%3']) h.dead.add(p);
  tick(h.board,h.config,h.execute);
  const fresh = h.board.lifecycle.status().workers.find(w => !w.cleaned);
  const peer = openBoard({ ...h.config,session:fresh.session,sender:fresh.sender }); t.after(() => peer.close()); peer.lifecycle.ready();
  assert.ok(peer.history().posts.every(p => p.number !== number));
  const env = { ...process.env,BF2_BOARD_DB:h.config.database,BF2_BOARD_RUN:h.config.run,BF2_BOARD_SESSION:fresh.session,BF2_BOARD_SENDER:fresh.sender };
  const read = spawnSync(resolve('bin/board'),['read'],{env,encoding:'utf8'});
  assert.equal(read.status,0,read.stderr); assert.doesNotMatch(read.stdout,/Original waking question/);
  assert.equal(peer.history().startup,false);
  assert.deepEqual(peer.history().wake,[]);
  assert.equal(peer.pending(),null);
  h.board.lifecycle.ownerCommand('live-owner','message','New question after joining');
  const batch = peer.pending();
  assert.match(batch.text,/JACK \[FACTORY OWNER\].*New question after joining/);
  assert.doesNotMatch(batch.text,/Original waking question/);
  peer.confirmPersisted(batch.key);
  assert.equal(peer.pending(),null);
  const reopened = openBoard(h.config); t.after(() => reopened.close());
  assert.equal(reopened.history({limit:100}).posts.find(p => p.number===number).text,'Original waking question');
});

test('large prior owner backlog is not replayed; live owner posts remain bounded and ordered', t => {
  const h = fixture(t); h.board.lifecycle.stop();
  for (let i=0;i<6;i++) h.board.lifecycle.ownerCommand(`wake-${i}`,'message',`Prior ${i}:`+'x'.repeat(16000));
  for (const pane of ['%1','%2','%3']) h.dead.add(pane);
  tick(h.board,h.config,h.execute);
  const worker = h.board.lifecycle.status().workers.find(w=>!w.cleaned);
  const peer = openBoard({...h.config,session:worker.session,sender:worker.sender}); t.after(()=>peer.close()); peer.lifecycle.ready();
  const snapshot = peer.history();
  assert.equal(snapshot.posts.filter(p=>p.role==='owner').length,6, 'plain read still shows chat history');
  assert.deepEqual(snapshot.wake,[]);
  peer.finishStartup(snapshot.highwater);
  assert.equal(peer.pending(),null);
  const numbers = [];
  for (let i=0;i<6;i++) numbers.push(h.board.lifecycle.ownerCommand(`live-${i}`,'message',`Live ${i}:`+'x'.repeat(16000)).number);
  numbers.push(h.board.lifecycle.ownerCommand('later-owner','message','New input after startup').number);
  const observed = [];
  while (peer.pending()) {
    const batch = peer.pending();
    assert.ok(Buffer.byteLength(batch.text)<65536);
    assert.doesNotMatch(batch.text,/Prior /);
    observed.push(...[...batch.text.matchAll(/^#(\d+) JACK \[FACTORY OWNER\]/gm)].map(m=>Number(m[1])));
    peer.confirmPersisted(batch.key); // Unit test simulates the receiver's persistence confirmation.
  }
  assert.deepEqual(observed,numbers);
});

test('simultaneous separate CLI pause retries serialize to one proposal, ballots close once', async t => {
  const h = fixture(t);
  const env = { ...process.env,BF2_BOARD_DB:h.config.database,BF2_BOARD_RUN:h.config.run,BF2_BOARD_SESSION:'peer-0',BF2_BOARD_SENDER:'aaaaaaaa' };
  const results = await Promise.all(Array.from({length:4},()=>new Promise((resolveResult,reject) => {
    const child=spawn(resolve('bin/board'),['pause','same-intent','Immutable reason'],{env});
    let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.once('error',reject); child.once('close',code=>resolveResult({code,stdout,stderr}));
  })));
  for (const r of results) assert.equal(r.code,0,r.stderr);
  assert.equal(new Set(results.map(r=>r.stdout)).size,1);
  const vote = h.board.lifecycle.status().vote;
  assert.equal(h.board.history({limit:100}).posts.filter(p=>p.text.includes('requested pause')).length,1);
  h.peers[1].lifecycle.vote(vote.number,'yes'); h.peers[2].lifecycle.vote(vote.number,'yes');
  const n = h.board.history({limit:100}).posts.length;
  h.peers[2].lifecycle.vote(vote.number,'yes');
  assert.equal(h.board.history({limit:100}).posts.length,n);
});

test('mentions validate registered IDs and preserve all source text; escape HTML and exclude code/paths/hashes', () => {
  const text = '@aaaaaaaa aaaaaaaa JACK @JACK deadbeef aaaaaaaa-1111-4111-8111-111111111111 /x/aaaaaaaa aaaaaaaa.txt `aaaaaaaa` ```\naaaaaaaa\n``` <img onerror="bad">';
  const html = textMarkup(text,new Set(['aaaaaaaa','JACK']));
  assert.equal((html.match(/data-mention=/g)??[]).length,4);
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('>aaaaaaaa</button>')); assert.ok(html.includes('>@aaaaaaaa</button>'));
  const unknown = textMarkup('deadbeef',new Set()); assert.equal(unknown,'deadbeef');
  assert.ok(!textMarkup('https://example.test/?id=aaaaaaaa @aaaaaaaa@example.test',new Set(['aaaaaaaa'])).includes('data-mention'));
});

test('localhost capability, Host/Origin/run scope, bounded mutations, owner assignment and server reachability through Stop', async t => {
  const h=fixture(t); let recoveries=0;
  const room=await serveRoom(h.board,h.config,{controller:()=>{recoveries++;}});
  t.after(()=>new Promise(r=>room.server.close(r)));
  const path=`${room.origin}/api/${h.config.run}/`, auth={Authorization:`Bearer ${room.token}`};
  const post=(action,body,headers={})=>fetch(path+action,{method:'POST',headers:{...auth,Origin:room.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(path+'state')).status,403);
  assert.equal((await fetch(path+'state',{headers:{Authorization:'Bearer '+'é'.repeat(64)}})).status,403, 'token comparison uses bytes, not UTF-16 length');
  assert.equal((await fetch(path+'state',{headers:{...auth,'Sec-Fetch-Site':'same-site'}})).status,403);
  const badHost = await new Promise((resolveStatus,reject) => {
    const req = request(path+'state',{headers:{...auth,Host:'remote.example'}},res=>{res.resume();resolveStatus(res.statusCode);});
    req.once('error',reject); req.end();
  });
  assert.equal(badHost,403);
  assert.equal((await fetch(path+'state',{headers:{...auth,Origin:'https://remote.example'}})).status,403);
  assert.equal((await fetch(`${room.origin}/api/other/state`,{headers:auth})).status,404);
  assert.equal((await post('message',{key:'bad-role',text:'x',sender:'JACK',role:'owner'})).status,400);
  assert.equal((await post('message',{key:'cross',text:'x'},{Origin:'null'})).status,403);
  assert.equal((await post('message',{key:'large',text:'x'.repeat(16385)})).status,400);
  assert.equal((await post('message',{key:'oversized',text:'x'.repeat(100000)})).status,413);
  assert.equal((await post('vote',{key:'vote',text:'x'})).status,404);
  assert.equal((await post('message',{key:'message',text:'<script>bad()</script>\nExact'})).status,200);
  assert.equal((await post('message',{key:'message',text:'<script>bad()</script>\nExact'})).status,200);
  assert.equal((await post('stop',{key:'stop'})).status,200);
  let snapshot=await (await fetch(path+'state',{headers:auth})).json();
  assert.equal(snapshot.status,'stopping'); assert.equal(snapshot.draining,true);
  assert.equal(snapshot.posts.filter(p=>p.role==='owner').length,1);
  assert.equal(snapshot.posts.find(p=>p.role==='owner').sender,'JACK');
  assert.equal(snapshot.config,undefined); assert.equal(snapshot.room_token,undefined);
  assert.equal((await fetch(room.origin+'/')).status,200,'room remains reachable during drain');
  for(const p of ['%1','%2','%3']) h.dead.add(p); tick(h.board,h.config,h.execute);
  snapshot=await (await fetch(path+'state',{headers:auth})).json(); assert.equal(snapshot.status,'stopped');
  assert.equal((await fetch(room.origin+'/')).status,200,'room survives stopped controller');
  assert.equal((await post('start',{key:'start'})).status,200); assert.ok(recoveries>=3);
  assert.equal((await fetch(room.origin+'/../board.sqlite')).status,404);
});

test('failed controller recovery keeps owner input durable and retry cannot resurrect a later cancelled wake', async t => {
  const h = fixture(t); h.board.lifecycle.stop(); let broken = true;
  t.mock.method(console,'error',()=>{});
  const room = await serveRoom(h.board,h.config,{controller:()=>{if(broken) throw new Error('synthetic recovery prerequisite');}});
  t.after(()=>new Promise(r=>room.server.close(r)));
  const send = () => fetch(`${room.origin}/api/${h.config.run}/message`, {method:'POST',headers:{Authorization:`Bearer ${room.token}`,Origin:room.origin,'Content-Type':'application/json'},body:JSON.stringify({key:'retry-wake',text:'Persist before recovery'})});
  const failed = await send(); assert.equal(failed.status,503);
  assert.equal((await failed.json()).error,'Saved, controller recovery pending. Inspect room.log');
  assert.equal(h.board.lifecycle.status().reconvene,1);
  h.board.lifecycle.ownerCommand('cancel-after-failure','stop');
  broken = false; assert.equal((await send()).status,200);
  assert.equal(h.board.lifecycle.status().reconvene,0);
  assert.equal(h.board.history({limit:100}).posts.filter(p=>p.role==='owner').length,1);
});

test('independent stopped-room service reopens once under concurrent explicit openers and closes cleanly', async t => {
  const h = fixture(t);
  writeFileSync(join(h.dir,'run.json'), JSON.stringify({run:h.config.run}));
  h.board.lifecycle.stop();
  for (let i=0;i<3;i++) h.board.lifecycle.cleaned(`peer-${i}`);
  h.board.lifecycle.advanceDrain();
  assert.equal(h.board.lifecycle.status().status,'stopped');
  try {
    const [a,b] = await Promise.all([ensureRoom(h.dir,false),ensureRoom(h.dir,false)]);
    assert.equal(a,b);
    const pid = h.board.lifecycle.status().room_pid;
    assert.equal(await ensureRoom(h.dir,false),a); assert.equal(h.board.lifecycle.status().room_pid,pid);
    assert.equal(h.board.lifecycle.status().status,'stopped');
    assert.equal(h.board.lifecycle.status().controller,null,'room reopen never starts stopped peers/controller');
    const response = await fetch(a.split('/#')[0]+'/'); assert.equal(response.status,200);
  } finally {
    await closeRoom(h.dir);
    for (let i=0;i<100 && h.board.lifecycle.status().room_pid !== null;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(h.board.lifecycle.status().room_pid,null,'service release precedes fixture removal');
  }
});

test('legacy swarm rejects before retrofitting or mutating; dedicated other-run and unknown DB checks remain', t => {
  const dir=mkdtempSync(join(root,'legacy-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config={database:join(dir,'old.sqlite'),run:'old',session:'controller',sender:'00000000'};
  const db=new DatabaseSync(config.database);
  db.exec("CREATE TABLE board_run(id INTEGER PRIMARY KEY,run TEXT); INSERT INTO board_run VALUES(1,'old'); CREATE TABLE swarm_run(id INTEGER,status TEXT); INSERT INTO swarm_run VALUES(1,'waiting')");
  db.close(); const before=readFileSync(config.database);
  assert.throws(()=>openBoard(config),/legacy swarm format/); assert.deepEqual(readFileSync(config.database),before);
  assert.throws(()=>openBoard({...config,run:'other'}),/another run/);
  const other=new DatabaseSync(join(dir,'other.sqlite')); other.exec('CREATE TABLE unrelated(id INTEGER)'); other.close();
  assert.throws(()=>openBoard({...config,database:join(dir,'other.sqlite')}),/not a dedicated/);
});

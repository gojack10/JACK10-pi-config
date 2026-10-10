import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as P from './parallel-core.mjs';
import * as G from './parallel-code.mjs';
import {ParallelController, save} from './parallel-controller.mjs';

const RUN='11111111-1111-4111-8111-111111111111', OWNER='22222222-2222-4222-8222-222222222222';
const A='aaaaaaaa-0000-4000-8000-000000000000', B='bbbbbbbb-0000-4000-8000-000000000000';
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const field=(text:string,key:string)=>new RegExp(`^${key}: (.+)$`,'m').exec(text)?.[1];
function fixture(failure=false) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'tree-forward-'))), repo=join(dir,'main'), worktrees=join(dir,'worktrees');
  mkdirSync(repo); mkdirSync(worktrees);
  git(repo,'init','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@invalid');
  writeFileSync(join(repo,'shared.txt'),'original\n');writeFileSync(join(repo,'law.txt'),'frozen\n');
  git(repo,'add','.');git(repo,'commit','-m','fixture: initialize');
  const config=P.buildConfig({runNode:RUN,owner:OWNER,directory:dir,cwd:dir,overrides:{codex_seats:1,code:{
    integration:'dispatcher',repo,worktree_root:worktrees,main_branch:'main',main_head:git(repo,'rev-parse','HEAD'),
    allowed_paths:['shared.txt'],frozen_paths:['law.txt'],
    candidate_checks:[[process.execPath,'-e',failure?'process.exit(7)':'if(require("fs").readFileSync("law.txt","utf8")!=="frozen\\n")process.exit(1)']],
    main_checks:[[process.execPath,'-e','if(!/[AB]/.test(require("fs").readFileSync("shared.txt","utf8")))process.exit(1)']]
  }}});
  save(join(dir,'config.json'),config);
  return {dir,repo,config,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const order=(id:string,seat:string)=>({node_id:id,scope:id,seats:[seat],depends_on:[],code:{files:['shared.txt']}});
const dispatcher=(tasks:any[]=[],disposition='tasks',completed:any[]=[])=>({version:1,role:'dispatcher',summary:'fixture checkpoint',disposition,tasks,completed});
function transport(f:ReturnType<typeof fixture>,options:any={}) {
  let now=1,seq=0,handed=false;
  const active=new Map(),settled=new Map(),launches:any[]=[],conflicts:string[]=[],integrated:string[]=[],previous:string[]=[];
  const deps={now:()=>now,sleep:async()=>{now+=1000;await new Promise(resolve=>setImmediate(resolve));},
    primaryRequired:async()=>true,writePolicy:(dir:string)=>join(dir,'policy.ts'),
    launchPi:async(args:any)=>{const mission=readFileSync(args.missionFile,'utf8'),task=field(mission,'TASK');
      const receipt={status:'running',job:String(++seq),session_label:args.label};
      const code=task?JSON.parse(readFileSync(field(mission,'CODE')!,'utf8')):null;
      const pending={args,mission,task,code,receipt};active.set(receipt.job,pending);launches.push(pending);return receipt;},
    piOutcome:async(receipt:any)=>{
      if(settled.has(receipt.job))return settled.get(receipt.job);
      const pending=active.get(receipt.job);if(!pending)return;
      const {args,mission,task,code}=pending;let r:any;
      if(task){
        assert.equal(code.phase,'develop','no reconcile/publish worker ceremonies');
        if(launches.filter(l=>l.task).length<2)return;
        writeFileSync(join(code.worktree,'shared.txt'),task===A?'A\n':'B\n');git(code.worktree,'add','shared.txt');
        git(code.worktree,'commit','-m','fixture: worker implements');
        r={version:1,role:'worker',disposition:'candidate',summary:'implemented and tested',evidence:[],updated_nodes:[],
          code:{worktree:code.worktree,branch:code.branch,base:code.base,candidate:git(code.worktree,'rev-parse','HEAD')}};
      }else{
        const s=JSON.parse(readFileSync(field(mission,'STATE')!,'utf8'));
        if(!s.tasks.length)r=dispatcher([order(A,'oss'),order(B,'codex-1')]);
        else{
          if(field(mission,'PREVIOUS'))previous.push(field(mission,'PREVIOUS')!);
          const completed:any[]=[];
          for(const row of s.tasks.filter((t:any)=>t.status==='merge_queued')){
            assert(!integrated.includes(row.node_id),'handoff must not repeat an accepted integration');
            const c=row.code,oldMain=git(f.repo,'rev-parse','HEAD');
            try{git(c.worktree,'merge','--no-edit',oldMain);}catch{
              conflicts.push(row.node_id);assert.match(readFileSync(join(c.worktree,'shared.txt'),'utf8'),/<<<<<<</);
              writeFileSync(join(c.worktree,'shared.txt'),'A+B\n');git(c.worktree,'add','shared.txt');
              git(c.worktree,'commit','-m','fixture: dispatcher resolves conflict');
            }
            const candidate=git(c.worktree,'rev-parse','HEAD');
            let logs;try{logs=await G.runCodeChecks(f.config,c,'candidate',candidate,oldMain,join(args.reportFile,'..'));}
            catch{r={...dispatcher([],'blocked'),blockers:[{node_id:row.node_id,kind:'platform',required:'repair failed test'}]};break;}
            git(f.repo,'merge','--ff-only',candidate);
            logs.push(...await G.runCodeChecks(f.config,c,'main',candidate,oldMain,join(args.reportFile,'..')));
            completed.push({node_id:row.node_id,candidate,main:candidate,checks:logs});integrated.push(row.node_id);
            if(options.handoff&&!handed){handed=true;r=dispatcher([],'continue',completed);break;}
          }
          r??=dispatcher([],s.tasks.every((t:any)=>t.status==='worked'||completed.some(c=>c.node_id===t.node_id))?'done':'tasks',completed);
        }
      }
      writeFileSync(args.reportFile,JSON.stringify(r));
      const result={status:'completed',source:'model',text:JSON.stringify(r)};active.delete(receipt.job);settled.set(receipt.job,result);return result;
    },launchClaude:async()=>{throw Error('no Claude');},sessionAlive:async()=>true,killSession:async()=>{},killSessionsWithPrefix:async()=>{},
    sendToPane:async()=>{},fence:async()=>[],ancestors:async(ids:string[])=>new Map(ids.map(id=>[id,[id,OWNER]])),statuses:async()=>new Map()};
  return {deps,launches,conflicts,integrated,previous};
}

test('agents integrate two concurrent overlapping worktrees, ordinary conflict, no global missing-observer gate, dispatcher handoff',async()=>{
  const f=fixture();try{
    const t=transport(f,{handoff:true}),ctl=new ParallelController(f.dir,t.deps);
    await ctl.start();
    ctl.state.checks.aaaaaaaaaaaaaaaa={task:'unrelated',observer:'does-not-exist',cases:[{input:1,expected_output:1}],proposal_hash:'a'.repeat(64),review_hash:'b'.repeat(64)};
    ctl.persist();
    assert.equal(await ctl.run(),'done');
    assert.equal(readFileSync(join(f.repo,'shared.txt'),'utf8'),'A+B\n');
    assert.equal(readFileSync(join(f.repo,'law.txt'),'utf8'),'frozen\n');
    assert.equal(t.launches.filter(l=>l.task).length,2,'one worker session per task');
    assert.deepEqual(t.conflicts,[B]);assert.equal(t.previous.length,1);
    assert.deepEqual(t.integrated,[A,B]);assert.equal(ctl.state.merge,null);
    assert(ctl.state.tasks[B].code.main_checks.every(existsSync));
    assert.equal(ctl.state.code_main,git(f.repo,'rev-parse','HEAD'));
    assert.equal(await new ParallelController(f.dir,t.deps).run(),'done');
    assert.equal(t.integrated.length,2,'resume does not redo completed work');
  }finally{f.cleanup();}
});
test('current RUN migration orders need no stale contract amendment receipt; real boundaries still hold',async()=>{
  const f=fixture();try{
    const old='Six bounded outcomes only; no live-source migration. Require an outer operator installed amendment receipt.\n';
    for(const name of ['run-contract.md','acceptance-contract.md'])writeFileSync(join(f.dir,name),old);
    const currentRun='Human authorizes copy-based private import of exactly two selected trees and new dogfood scope. No hosted writes or private/public leakage. Qwen participation is mandatory throughout active factory work.';
    writeFileSync(join(f.dir,'current-run.txt'),currentRun);
    f.config.acceptance={root:f.dir,paths:['run-contract.md','acceptance-contract.md'],spec_scope:OWNER};
    save(join(f.dir,'config.json'),f.config);
    const saved=P.initialState(f.config,1);
    saved.seq=250;saved.code_pin=G.codePin(f.config);saved.status='blocked';
    saved.dispatcher.last={attempt:'250',disposition:'blocked',at:1};
    save(join(f.dir,'state.json'),saved);
    mkdirSync(join(f.dir,'inbox'));
    save(join(f.dir,'inbox','wake.json'),{type:'wake',reconcile:true});
    const t=transport(f),ctl=new ParallelController(f.dir,t.deps);
    await ctl.start();await ctl.readInbox(2);ctl.launchDispatcher(3);
    await Promise.all(ctl.inflight);
    const mission=t.launches[0].mission;
    assert.equal(field(mission,'RUN'),RUN);
    assert.match(mission,/Current human RUN decisions and applicable current tree owners govern/);
    assert.match(mission,/technical references\/test recipes, not runtime permission sources/);
    assert.match(mission,/state the conflict and proceed with a bounded order/);
    assert.match(mission,/Stale prose alone never requires an outer operator rewrite, scoped policy-hash update or installed amendment receipt/);
    assert.match(mission,/supersedes duplicate installation prerequisites in ROLE, RUN, owners and PREVIOUS for that mismatch only/);
    assert.match(mission,/Do not ignore changed input bytes\/hashes or actual runtime incompatibility/);
    assert.match(mission,/real missing task prerequisite, unresolved current human choice, safety\/privacy violation/);
    assert.match(mission,/code-config pins.*frozen laws.*source privacy.*mandatory Qwen/);
    const fresh=ctl.state.attempts[ctl.state.dispatcher.attempt];
    // A supplied dispatcher decision, not a model-behavior simulation or controller interpretation of prose.
    const admitted=P.validateDispatcherReport({...dispatcher([order(A,'oss')]),summary:'Current RUN authorizes private two-tree migration; old six-only contract prose is superseded. Assign bounded in-fence implementation with frozen checks; no hosted mutation.'});
    await ctl.settle(fresh,{kind:'report',report:admitted,reportPath:join(f.dir,'order.json')},4);
    assert.equal(ctl.state.admission_hold,undefined);
    assert.deepEqual(P.planAssignments(ctl.state,f.config,5),[{seat:'oss',task:A}]);
    assert.equal(saved.dispatcher.last.disposition,'blocked','original blocked decision is not rewritten');
    for(const name of ['run-contract.md','acceptance-contract.md'])assert.equal(readFileSync(join(f.dir,name),'utf8'),old);
    assert.equal(readFileSync(join(f.dir,'current-run.txt'),'utf8'),currentRun);
    assert.equal(await G.mainIdentity(f.config.code),f.config.code.main_head,'no candidate/main credit from admission');
    const settle=async(report:any)=>{
      const a=P.startAttempt(ctl.state,{kind:'dispatcher',engine:'fallback',events:[],receipt:{session_label:'fixture-dispatcher'}});
      await ctl.settle(a,{kind:'report',report:P.validateDispatcherReport(report),reportPath:join(f.dir,'negative.json')},6);
    };
    await settle(dispatcher([{...order(A,'oss'),depends_on:[B]}]));
    assert.deepEqual(P.planAssignments(ctl.state,f.config,7),[],'missing real prerequisite cannot launch');
    for(const [kind,required,question] of [
      ['authority','Current RUN leaves the public license undecided','Which license is approved?'],
      ['platform','Private source appears in the proposed public payload; repair/audit before release',null],
    ]){
      await settle({...dispatcher([],'blocked'),blockers:[{node_id:A,kind,required}],questions_for_jack:question?[question]:[]});
      assert.deepEqual(P.planAssignments(ctl.state,f.config,8),[],'genuine human/safety blocker is not bypassed');
      assert.equal(P.terminalStatus(ctl.state,f.config,8),'blocked');
    }
    const rejected=await ctl.vetTasks(P.validateDispatcherReport(dispatcher([{...order(A,'oss'),code:{files:['private-export.json']}}])));
    assert.match(rejected.get(A)!,/outside code.allowed_paths/,'new scope cannot broaden actual code/privacy fences');
    assert.throws(()=>P.validateDispatcherReport({...dispatcher([],'blocked'),blockers:[]}),/blocker/);
    save(join(f.dir,'config.json'),{...f.config,code:{...f.config.code,candidate_checks:[[process.execPath,'-e','process.exit(0)']]}});
    await assert.rejects(ctl.codeMainCheck(),/code configuration changed/,'current RUN cannot excuse code-pin tampering');
    const resumed=new ParallelController(f.dir,t.deps);await resumed.start();
    assert.match(resumed.state.attention.reason,/code configuration removed\/changed/);
    assert.deepEqual(P.planAssignments(resumed.state,resumed.config,9),[]);
    assert.equal(t.launches.length,1,'no worker/model or replacement launch in this regression');
  }finally{f.cleanup();}
});

test('dispatcher sees failing real tests and does not merge or credit candidates',async()=>{
  const f=fixture(true);try{const t=transport(f),ctl=new ParallelController(f.dir,t.deps);
    assert.equal(await ctl.run(),'blocked');assert.equal(git(f.repo,'rev-parse','HEAD'),f.config.code.main_head);
    assert.equal(t.integrated.length,0);assert.equal(ctl.state.tasks[A].status,'merge_queued');
  }finally{f.cleanup();}
});
test('integration reports cannot credit running tasks, invented main or missing test logs; old code pins cannot silently migrate',async()=>{
  const f=fixture();try{const ctl=new ParallelController(f.dir,transport(f).deps);await ctl.start();
    const log=join(f.dir,'test.log');writeFileSync(log,'passed');
    const item={node_id:A,candidate:f.config.code.main_head,main:f.config.code.main_head,checks:[log]};
    assert.throws(()=>P.validateDispatcherReport(dispatcher([],'tasks',[{...item,checks:['/absent/test.log']}])),/test logs/);
    assert.throws(()=>P.validateDispatcherReport(dispatcher([],'tasks',[item,item])),/twice/);
    ctl.state.tasks[A]={status:'running',code:{candidate:item.candidate}};
    await assert.rejects(ctl.dispatcherCodeOutcome({completed:[item]}),/settled/);
    ctl.state.tasks[A].status='merge_queued';
    await assert.rejects(ctl.dispatcherCodeOutcome({completed:[{...item,main:'a'.repeat(40)}]}));
    assert.equal(ctl.state.tasks[A].status,'merge_queued');
    await ctl.applyRecoveries([{node_id:A,reason:'repair integration failure in the same draft'}],1);
    assert.equal(ctl.state.tasks[A].status,'queued');
    assert.equal(ctl.state.tasks[A].code.candidate,item.candidate,'repair retains candidate history');
    const config=structuredClone(f.config);delete config.code.integration;save(join(f.dir,'config.json'),config);
    await assert.rejects(ctl.codeMainCheck(),/configuration changed/);
  }finally{f.cleanup();}
});

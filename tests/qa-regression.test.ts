// Adapted from Office QA commit cd116576bb56527a3e1f20deec66a36f139db0c0; F1/F2 assert corrected behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/age-7/legacy-queue.json', import.meta.url), 'utf8'));
function harness(t: any, seed?: string, initial: WorkerInfo[] = []) {
  const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'age7-'));
  const workers = [...initial];
  const queues: TaskQueue[] = [];
  let attempts = 0;
  let paused: string | undefined;
  let room = Infinity;
  const notices: string[] = [];
  const manager: QueueWorkers = {
    defaultProvider: 'claude', list: () => workers,
    deskOccupied: id => workers.some(w => w.deskId === id),
    spawn(deskId, by, prompt, _tree, kind, provider) {
      const w = { id: `worker-${++attempts}`, deskId, kind, provider, prompt, name: 'Engineer', color:'#fff', status:'working', acked:false, createdBy:by, createdAt:1, cols:80, rows:24, viewers:[], viewerIds:[] } as WorkerInfo;
      workers.push(w); return w;
    },
    async kill(id) { const i=workers.findIndex(w=>w.id===id); if(i>=0) workers.splice(i,1); return {}; }
  };
  const open = (office = 'alpha') => {
    const dir=path.join(root, office); mkdirSync(dir,{recursive:true});
    if(seed !== undefined && !queues.length) writeFileSync(path.join(dir,'queue.json'),seed);
    const q=new TaskQueue(dir,manager,false,{update(){},toast(s){notices.push(s)},claimIssue:async()=>undefined,refreshGitHub(){},hiringPaused:()=>paused,room:()=>room,emptied(){}});
    queues.push(q); return q;
  };
  t.after(()=>{queues.forEach(q=>q.shutdown());rmSync(root,{recursive:true,force:true})});
  return {root,open,workers,notices,attempts:()=>attempts,pause:(s?:string)=>paused=s,room:(n:number)=>room=n};
}

test('separate queue roots retain same titles without cross-root file changes (queue layer only)', t=>{
  const f=harness(t); const a=f.open('alpha'), b=f.open('beta'); a.setLimit(0);b.setLimit(0);
  a.add('ALPHA ONLY','QA','Engineer');b.add('BETA ONLY','QA','Engineer');
  const before=readFileSync(path.join(f.root,'beta/queue.json'),'utf8');
  assert.equal(a.remove(b.state().tasks[0].id),'No such task');
  a.remove(a.state().tasks[0].id);
  assert.equal(readFileSync(path.join(f.root,'beta/queue.json'),'utf8'),before);
  assert.equal(b.state().tasks[0].prompt,'BETA ONLY');
});
test('legacy completed history retains worker, timestamps, branch and PR',t=>{
  const f=harness(t,JSON.stringify(legacy)); const q=f.open();
  const done=q.state().tasks.find(x=>x.id==='legacy-done')!;
  for(const key of ['workerId','workerName','startedAt','finishedAt','branch','pr']) assert.deepEqual((done as any)[key],legacy.tasks[2][key]);
});
test('queued legacy state is stable through two save/reopen cycles',t=>{
  const f=harness(t,JSON.stringify({maxWorkers:0,tasks:[legacy.tasks[0],legacy.tasks[2]]}));
  const a=f.open();a.setLimit(0);const first=a.state();a.shutdown();
  const b=f.open();b.setLimit(0);assert.deepEqual(b.state(),first);b.shutdown();
  assert.deepEqual(f.open().state(),first);
});
test('budget and capacity pause dispatch without failed task or attempts',t=>{
  const f=harness(t); f.pause('QA budget exhausted');const q=f.open();q.add('one','QA');q.add('two','QA');
  q.pump();assert.equal(f.attempts(),0);assert.ok(q.state().tasks.every(x=>x.status==='queued'&&!x.error));
  f.pause();f.room(-1);q.pump();assert.equal(f.attempts(),0);
  f.room(1);q.setLimit(1);q.pump();assert.equal(f.attempts(),1);q.pump();assert.equal(f.attempts(),1);
});
test('equal-priority baseline FIFO is stable over restart',t=>{
  const f=harness(t);const a=f.open();a.setLimit(0);a.add('first','QA');a.add('second','QA');a.shutdown();
  const b=f.open();b.setLimit(1);assert.equal(f.workers[0].prompt,'first');
  assert.deepEqual(b.state().tasks.map(x=>x.status),['running','queued']);
});
test('F1: malformed queue reports an error and attempted writes preserve original bytes',t=>{
  const malformed=readFileSync(new URL('./fixtures/age-7/malformed-queue.json',import.meta.url),'utf8');
  const f=harness(t,malformed);const q=f.open();assert.equal(q.state().tasks.length,0);assert.ok(f.notices.some(s => /storage could not be read/.test(s)));
  q.setLimit(0);assert.equal(readFileSync(path.join(f.root,'alpha/queue.json'),'utf8'),malformed);
});
test('F2: surviving worker remains running on queue restore without a new attempt',t=>{
  const w={id:'survivor',deskId:'desk-1',kind:'agent',status:'working',viewers:[]} as WorkerInfo;
  const f=harness(t,JSON.stringify(legacy),[w]);const q=f.open();q.pump();
  const task=q.state().tasks.find(x=>x.id==='legacy-running')!;
  assert.equal(task.status,'running');assert.equal(task.outcome,undefined);assert.equal(f.attempts(),0);
});

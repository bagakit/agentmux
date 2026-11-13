import{afterEach,expect,it,vi}from'vitest'
import{appendFile,mkdtemp,realpath,rm}from'node:fs/promises'
import{writeCapturedLegacyFixture}from'./helpers/captured-history-fixture.js'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{DatabaseSync}from'node:sqlite'
import{spawn}from'node:child_process'
import{fileURLToPath}from'node:url'
import{objectCliEnvironment}from'./helpers/object-cli-rpc.js'
import{syncFault}from'./fixtures/hook-transaction/faults.js'
import{AgentMuxAgentSessionRegistry}from'../src/agent-session-registry.js'
import{AgentMuxSessionDurabilityError}from'../src/agent-session-store.js'
import{AgentMuxFileAgentSessionStore,AgentMuxMemoryAgentSessionStore}from'../src/agent-session-store.js'
import{beginCapturedStream,readyCapturedStream,commitCapturedMutation,capturedStream}from'../src/captured-history.js'
import type{AgentMuxStoredAgentSession,AgentTimelineItem,AgentCapturedTimelineRecord}from'../src/types.js'
const oldModule='../src/agent-session-store.js?pre-g'
const old=await import(oldModule) as typeof import('../src/agent-session-store.js')
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close()})
async function owner(kind:'file'|'memory'='file',legacy=true){
 const root=await realpath(await mkdtemp(join(tmpdir(),'captured-g-'))),path=join(root,'sessions.sqlite');cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const session:AgentMuxStoredAgentSession={kind:'agent',agentSessionId:'original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:root,run:{runId:'original-run'},retiredRuns:[],hookBindingId:'b'.repeat(43),hookToken:'t'.repeat(43),createdAt:1,updatedAt:1}
 const before=kind==='file'?new old.AgentMuxFileAgentSessionStore(path):new old.AgentMuxMemoryAgentSessionStore()
 await before.compareAndSwap(null,session)
 const item=(id='a',content='pre-G body'):AgentTimelineItem=>({id,agentSessionId:session.agentSessionId,kind:'tool_call',source:'native-hook',status:'streaming',title:'Original',content,createdAt:1,updatedAt:1})
 if(legacy){await before.applyTimelineMutation({type:'upsert',agentSessionId:session.agentSessionId,item:item()});await before.applyTimelineMutation({type:'upsert',agentSessionId:session.agentSessionId,item:item('b')})}
 const store=kind==='file'?new AgentMuxFileAgentSessionStore(path):new AgentMuxMemoryAgentSessionStore()
 if(kind==='memory'){
  await store.compareAndSwap(null,session)
  const original=Reflect.get(before,'timelines') as Map<string,unknown>
  for(const[id,history]of original)(Reflect.get(store,'timelines')as Map<string,unknown>).set(id,structuredClone(history))
 }
 const write=(content:string,id='a')=>store.applyTimelineMutation({type:'upsert',agentSessionId:session.agentSessionId,item:item(id,content)})
 const all=()=>store.readCapturedHistory(session.agentSessionId,{afterSequence:0})
 const cut=()=>{
  if(kind==='memory')return(Reflect.get(store,'timelines')as Map<string,{retirementAfterSequence?:number}>).get(session.agentSessionId)?.retirementAfterSequence
  const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT 1 FROM sqlite_schema WHERE name='captured_retirement_cuts'").get()?db.prepare('SELECT c.after_sequence FROM captured_retirement_cuts c JOIN captured_streams s ON c.session_id=s.session_id AND c.epoch=s.epoch WHERE s.session_id=?').get(session.agentSessionId)?.after_sequence:undefined}finally{db.close()}
 }
 return{root,path,session,before,store,item,write,all,cut}
}
it.each(['file','memory']as const)('%s protects every pre-G body including the first superseded head and retires only eligible exact heads',async kind=>{
 const f=await owner(kind),original=await f.all();expect(f.cut()).toBeUndefined()
 await f.store.readCapturedHistory(f.session.agentSessionId);await f.store.loadTimeline(f.session.agentSessionId);expect(f.cut()).toBeUndefined()
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item()});expect(f.cut()).toBeUndefined()
 const a=await f.write('first future a');expect(f.cut()).toBe(2)
 await f.write('second future a');const b=await f.write('first future b','b')
 const rows=(await f.all()).records
 expect(rows.slice(0,2)).toEqual(original.records)
 expect(rows[2]).toEqual({item:null,recordId:'a',firstSequence:1,sequence:3,revision:a.position.revision})
 expect(rows[3]?.item).toMatchObject({id:'a',content:'second future a'});expect(rows[4]?.item).toMatchObject({id:'b',content:'first future b'})
 expect(rows.map(r=>r.sequence)).toEqual([1,2,3,4,5]);expect((await f.all()).stream.epoch).toBe(original.stream.epoch)
 expect(b.position.firstSequence).toBe(2);expect(JSON.stringify((await f.all()).stream)).not.toContain('retirementAfter')
})
it.each(['file','memory']as const)('%s retains cut zero and bounded header-only pages while current heads stay readable',async kind=>{
 const f=await owner(kind,false),first=await f.write('first');expect(f.cut()).toBe(0)
 await f.write('second');await f.write('third')
 const firstPage=await f.store.readCapturedHistory(f.session.agentSessionId,{afterSequence:0,limit:1})
 expect(firstPage).toMatchObject({more:true,records:[{item:null,sequence:1}],stream:{gaps:[{code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}]}})
 const next=await f.store.readCapturedHistory(f.session.agentSessionId,{afterSequence:firstPage.records[0]!.sequence,limit:1})
 expect(next.records).toMatchObject([{item:null,sequence:2}]);expect(next.more).toBe(true)
 expect((await f.store.loadTimeline(f.session.agentSessionId)).items).toMatchObject([{content:'third'}]);expect(f.cut()).toBe(0)
 const exact=await f.store.readCapturedHistory(f.session.agentSessionId,{epoch:first.stream.epoch,throughSequence:1,recordId:'a',recordRevision:first.position.revision})
 expect(exact.records).toMatchObject([{item:null,recordId:'a',sequence:1}])
})
it('new policy leaves the same real old writer new-stream, normal mutation and original reads usable',async()=>{
 const f=await owner(),first=await f.write('new owner future')
 const second={...f.session,agentSessionId:'other',run:{runId:'other-run'}}
 await f.before.compareAndSwap(null,second)
 await f.before.applyTimelineMutation({type:'append',agentSessionId:second.agentSessionId,item:{...f.item('other-tool'),agentSessionId:second.agentSessionId}})
 await f.before.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','old writer extra body')})
 expect((await f.before.readCapturedHistory(f.session.agentSessionId,{afterSequence:0})).records.every((r:AgentCapturedTimelineRecord)=>r.item!==null)).toBe(true)
 expect((await f.before.loadTimeline(second.agentSessionId)).items).toHaveLength(1)
 await f.write('new owner resumes')
 const rows=(await f.all()).records
 expect(rows.slice(0,2).every(r=>r.item!==null)).toBe(true)
 // The old writer retained the earlier post-cut body; the new writer retires only its immediate prior head.
 expect(rows.find(r=>r.sequence===first.position.sequence)?.item).not.toBeNull()
 expect(rows.at(-2)?.item).toBeNull();expect(f.cut()).toBe(2)
 expect(await f.before.readMetadata(f.session.agentSessionId)).toEqual(f.session)
})
it('a failed first normal mutation rolls back policy-table creation together with its body and original C receipt remains separate',async()=>{
 const f=await owner(),original=await f.all()
 const db=new DatabaseSync(f.path);db.exec("CREATE TRIGGER reject_future BEFORE INSERT ON captured_record_versions WHEN NEW.record_id='a' BEGIN SELECT RAISE(ABORT,'original controlled body failure');END");db.close()
 await expect(f.write('not committed')).rejects.toMatchObject({code:'AGENT_SESSION_STORE_UNAVAILABLE'})
 expect(f.cut()).toBeUndefined();expect(await f.all()).toEqual(original)
 const next={...f.session,updatedAt:2,hookReceipt:{id:'original-receipt',providerId:'codex',agentSessionId:f.session.agentSessionId,run:f.session.run,eventName:'PreToolUse',observedAt:2}}
 const result=await f.store.compareAndSwapMetadataWithTimeline(f.session,next,{type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','also rejected')})
 expect(result).toMatchObject({timelineFailure:{code:'AGENT_SESSION_STORE_UNAVAILABLE'}});expect(f.cut()).toBeUndefined()
 expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(next);expect((await f.all()).records).toEqual(original.records)
})
it.each(['ddl','cut']as const)('actual policy %s failure leaves every original body and acknowledged C metadata intact without activation',async mode=>{
 const f=await owner(),before=await f.all(),failure=new Error('original policy DDL ACK failed'),execute=DatabaseSync.prototype.exec;let armed=true
 if(mode==='ddl')vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  const result=execute.call(this,sql)
  if(armed&&sql.includes('CREATE TABLE IF NOT EXISTS captured_retirement_cuts')){armed=false;throw failure}
  return result
 })
 else{const db=new DatabaseSync(f.path);try{
  db.exec('CREATE TABLE captured_retirement_cuts (session_id TEXT NOT NULL,epoch TEXT NOT NULL,after_sequence INTEGER NOT NULL,PRIMARY KEY(session_id,epoch))')
  db.prepare('INSERT INTO captured_retirement_cuts VALUES (?,?,?)').run('unrelated-original','unrelated-epoch',7)
  db.exec("CREATE TRIGGER reject_policy BEFORE INSERT ON captured_retirement_cuts WHEN NEW.session_id='original' BEGIN SELECT RAISE(ABORT,'controlled exact cut failure');END")
 }finally{db.close()}}
 const next={...f.session,updatedAt:2,hookReceipt:{id:'policy-'+mode,providerId:'codex',agentSessionId:f.session.agentSessionId,run:f.session.run,eventName:'PreToolUse',observedAt:2}}
 const result=await f.store.compareAndSwapMetadataWithTimeline(f.session,next,{type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','not activated')})
 expect(result).toMatchObject({timelineFailure:{code:'AGENT_SESSION_STORE_UNAVAILABLE'}})
 expect(f.cut()).toBeUndefined();expect((await f.all()).records).toEqual(before.records);expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(next)
 if(mode==='cut'){const db=new DatabaseSync(f.path,{readOnly:true});try{expect(db.prepare('SELECT * FROM captured_retirement_cuts').all()).toEqual([{session_id:'unrelated-original',epoch:'unrelated-epoch',after_sequence:7}])}finally{db.close()}}
})
it('cancellation after the actual first cut insertion rolls its activation back together with the new body',async()=>{
 const f=await owner(),before=await f.all(),controller=new AbortController(),reason=new Error('cancel first G cut'),prepare=DatabaseSync.prototype.prepare
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  const statement=prepare.call(this,sql)
  if(sql==='INSERT INTO captured_retirement_cuts VALUES (?,?,?)'){const run=statement.run.bind(statement);statement.run=(...args)=>{const result=Reflect.apply(run,statement,args) as ReturnType<typeof run>;controller.abort(reason);return result}}
  return statement
 })
 await expect(f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','cancelled first normal')},controller.signal)).rejects.toBe(reason)
 expect(f.cut()).toBeUndefined();expect((await f.all()).records).toEqual(before.records);expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
})

it('legacy handover protects every imported original before establishing the normal-write cut',async()=>{
 const f=await owner('file',false)
 const legacy=await writeCapturedLegacyFixture(f.path,[f.item(),f.item('b'),f.item('c')])
 const imported=await f.all()
 expect(imported.records).toHaveLength(4);expect(imported.records.every(r=>r.item!==null)).toBe(true);expect(f.cut()).toBeUndefined()
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:{...legacy.completed,content:'future after handover',updatedAt:legacy.completed.updatedAt+1}});expect(f.cut()).toBe(4)
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:{...legacy.completed,content:'next future after handover',updatedAt:legacy.completed.updatedAt+2}})
 const rows=(await f.all()).records
 expect(rows.slice(0,4)).toEqual(imported.records);expect(rows[4]?.item).toBeNull()
 expect(legacy.original.byteLength).toBeGreaterThan(0)
})
it('File original mutation rollback restores a retired eligible body and preserves its established cut',async()=>{
 const f=await owner();await f.write('eligible future');const original=await f.all()
 const db=new DatabaseSync(f.path)
 db.exec("CREATE TRIGGER fail_after_retirement BEFORE UPDATE OF sequence ON captured_streams WHEN NEW.sequence>OLD.sequence BEGIN SELECT RAISE(ABORT,'controlled late stream failure');END");db.close()
 const next={...f.session,updatedAt:2,hookReceipt:{id:'late-receipt',providerId:'codex',agentSessionId:f.session.agentSessionId,run:f.session.run,eventName:'PreToolUse',observedAt:2}}
 const result=await f.store.compareAndSwapMetadataWithTimeline(f.session,next,{type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','cannot survive rollback')})
 expect(result).toMatchObject({timelineFailure:{code:'AGENT_SESSION_STORE_UNAVAILABLE'}})
 expect((await f.all()).records).toEqual(original.records);expect(f.cut()).toBe(2);expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(next)
})
it('File cancellation after actual retirement SQL restores the exact original body with its abort reason',async()=>{
 const f=await owner();await f.write('eligible future');const original=await f.all(),controller=new AbortController(),reason=new Error('original G cancellation')
 const prepare=DatabaseSync.prototype.prepare
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  const statement=prepare.call(this,sql)
  if(sql.startsWith("UPDATE captured_record_versions SET item_json='null'")){
   const run=statement.run.bind(statement)
   statement.run=(...args)=>{const result=Reflect.apply(run,statement,args) as ReturnType<typeof run>;controller.abort(reason);return result}
  }
  return statement
 })
 await expect(f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','cancelled')},controller.signal)).rejects.toBe(reason)
 expect((await f.all()).records).toEqual(original.records);expect(f.cut()).toBe(2)
})
it.each(['first','later']as const)('Memory %s cut and body staging changes nothing when its result clone observes abort',async mode=>{
 const f=await owner('memory'),controller=new AbortController(),reason=new Error('original Memory G abort')
 if(mode==='later')await f.write('eligible future')
 const original=await f.all(),before=f.cut(),clone=structuredClone
 vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{
  const result=clone(value,options)
  if(value&&typeof value==='object'&&'position'in value&&'mutation'in value)controller.abort(reason)
  return result
 })
 await expect(f.store.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','cancelled')},controller.signal)).rejects.toBe(reason)
 expect((await f.all()).records).toEqual(original.records);expect(f.cut()).toBe(before)
})
it('File policy cut is scoped to the exact original epoch rather than another retained epoch',async()=>{
 const f=await owner(),db=new DatabaseSync(f.path)
 db.exec('CREATE TABLE captured_retirement_cuts (session_id TEXT NOT NULL,epoch TEXT NOT NULL,after_sequence INTEGER NOT NULL,PRIMARY KEY(session_id,epoch))')
 db.prepare('INSERT INTO captured_retirement_cuts VALUES (?,?,?)').run(f.session.agentSessionId,'-another-original-epoch',0);db.close()
 const original=await f.all();await f.write('new original epoch body')
 expect(f.cut()).toBe(2);expect((await f.all()).records.slice(0,2)).toEqual(original.records)
})
it('legacy current and pre-G exact reads remain readable while a retired post-cut range is unavailable to its old decoder',async()=>{
 const f=await owner(),opening=await f.all();await f.write('eligible future');await f.write('latest future')
 expect((await f.before.loadTimeline(f.session.agentSessionId)).items.find(item=>item.id==='a')?.content).toBe('latest future')
 const protectedVersion=opening.records[0]!
 expect((await f.before.readCapturedHistory(f.session.agentSessionId,{throughSequence:2,recordId:'a',recordRevision:protectedVersion.revision})).records[0]?.item).toEqual(protectedVersion.item)
 await expect(f.before.readCapturedHistory(f.session.agentSessionId,{afterSequence:2})).rejects.toMatchObject({code:'INVALID_AGENT_TIMELINE'})
 expect(await f.before.readMetadata(f.session.agentSessionId)).toEqual(f.session)
})

it('a fresh actual Node Store process reuses the immutable cut and retires only its post-cut head',async()=>{
 const f=await owner(),first=await f.write('first future body')
 const loader=new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url),entry=fileURLToPath(new URL('./fixtures/captured-retirement/write-worker.mjs',import.meta.url))
 const register='import {register} from "node:module";register('+JSON.stringify(loader.href)+');'
 const output=await new Promise<{pid:number|undefined;code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(register),entry,f.path,JSON.stringify(f.item('a','new process body'))],{env:objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CHILD_LOADED}),stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Private original Store restart exceeded bounded test lifetime'))},15000)
  child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes)
  child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',code=>{clearTimeout(timer);resolve({pid:child.pid,code,stdout,stderr})})
 })
 expect(output.code,output.stdout+output.stderr).toBe(0)
 const result=JSON.parse(output.stdout)
 expect(result).toMatchObject({cut:{after_sequence:2},sameOriginalMetadata:true,result:{stream:{epoch:first.stream.epoch,sequence:4}}})
 expect(result.records.records.slice(0,2).every((row:AgentCapturedTimelineRecord)=>row.item!==null)).toBe(true)
 expect(result.records.records[2]).toMatchObject({item:null,sequence:3,recordId:'a'})
 expect(result.process).toMatchObject({pid:output.pid,ppid:process.pid,node:process.execPath})
 expect(result.identity).toEqual({hostId:f.session.hostId,agentSessionId:f.session.agentSessionId,runId:f.session.run.runId,providerId:f.session.providerId})
 expect(f.cut()).toBe(2)
 if(process.env.CAPTURED_G_PROCESS_FACTS)await appendFile(process.env.CAPTURED_G_PROCESS_FACTS,JSON.stringify({testName:'a fresh actual Node Store process reuses the immutable cut and retires only its post-cut head',process:result.process,identity:result.identity,exitCode:output.code,cut:result.cut,sameOriginalMetadata:result.sameOriginalMetadata,originalRoot:f.root,originalStore:f.path})+'\n')
})

it.each([-1,1.5,999,'','bad'])('an invalid actual cut %s never becomes a permissive zero or retires a protected body',async value=>{
 const f=await owner(),before=await f.all(),db=new DatabaseSync(f.path)
 db.exec('CREATE TABLE captured_retirement_cuts (session_id TEXT NOT NULL,epoch TEXT NOT NULL,after_sequence INTEGER NOT NULL,PRIMARY KEY(session_id,epoch))')
 db.prepare('INSERT INTO captured_retirement_cuts VALUES (?,?,?)').run(f.session.agentSessionId,before.stream.epoch,value);db.close()
 await expect(f.write('must not erase pre-G')).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_CAPTURE_UNCONFIRMED'})
 expect((await f.all()).records).toEqual(before.records);expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
})
it.each(['sync','commit-ack']as const)('first-cut %s loss retains the true required metadata Error and immutable cut through original confirmation',async mode=>{
 const f=await owner(),before=await f.all(),registry=new AgentMuxAgentSessionRegistry(f.store)
 await registry.load('local')
 const next={...f.session,updatedAt:2,hookReceipt:{id:'first-cut-unknown',providerId:'codex',agentSessionId:f.session.agentSessionId,run:f.session.run,eventName:'PreToolUse',observedAt:2}}
 const ackFailure=new Error('original first cut COMMIT ACK lost'),execute=DatabaseSync.prototype.exec;let armed=true
 const fault=mode==='sync'?await syncFault(f.path,db=>JSON.parse(String(db.prepare('SELECT json FROM sessions WHERE id=?').get(f.session.agentSessionId)!.json)).hookReceipt?.id===next.hookReceipt.id):undefined
 if(mode==='commit-ack')vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  const target=sql==='COMMIT'&&armed&&this.prepare('PRAGMA database_list').all().some(row=>row.file===f.path)
  const result=execute.call(this,sql)
  if(target){armed=false;throw ackFailure}
  return result
 })
 const failure=await registry.updateWithTimeline(f.session.agentSessionId,f.session.run,()=>({session:next,mutation:{type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','first future body')}})).then(()=>undefined,error=>error)
 expect(failure).toBeInstanceOf(AgentMuxSessionDurabilityError);expect(failure.cause).toBe(mode==='sync'?fault!.failure:ackFailure)
 expect(failure.commitOutcome).toBe(mode==='sync'?'applied':'unknown')
 expect(f.cut()).toBe(2);expect(registry.get(f.session.agentSessionId)).toEqual(next);expect(registry.isDurabilityUnconfirmed(f.session.agentSessionId)).toBe(true)
 expect((await f.all()).records.slice(0,2)).toEqual(before.records)
 vi.restoreAllMocks();await registry.confirmDurability(f.session.agentSessionId,f.session.run)
 expect(registry.isDurabilityUnconfirmed(f.session.agentSessionId)).toBe(false)
 const fresh=new AgentMuxFileAgentSessionStore(f.path)
 await fresh.applyTimelineMutation({type:'upsert',agentSessionId:f.session.agentSessionId,item:f.item('a','second future body')})
 expect((await f.all()).records[2]?.item).toBeNull();expect(f.cut()).toBe(2)
})
it('partial preparing import and its reopened continuation cannot create a cut even when another stream created the table',async()=>{
 const f=await owner('file',false);await f.write('other established original stream')
 const sid='partially-imported',session={...f.session,agentSessionId:sid,run:{runId:'imported-run'}}
 await f.store.compareAndSwap(null,session)
 let db=new DatabaseSync(f.path);let epoch=''
 const item=(content:string)=>({...f.item('imported-head',content),agentSessionId:sid})
 try{
  db.exec('BEGIN');epoch=beginCapturedStream(db,sid,'original-import-witness').epoch
  commitCapturedMutation(db,{type:'upsert',agentSessionId:sid,item:item('imported first')},true);db.exec('COMMIT')
  expect(db.prepare('SELECT * FROM captured_retirement_cuts WHERE session_id=?').all(sid)).toEqual([])
 }finally{db.close()}
 db=new DatabaseSync(f.path)
 try{
  expect(capturedStream(db,sid)).toMatchObject({state:'preparing',sequence:1,epoch})
  db.exec('BEGIN');commitCapturedMutation(db,{type:'upsert',agentSessionId:sid,item:item('imported second')},true)
  commitCapturedMutation(db,{type:'upsert',agentSessionId:sid,item:item('imported final')},true)
  readyCapturedStream(db,sid,'original-import-witness',3,[]);db.exec('COMMIT')
  expect(db.prepare('SELECT * FROM captured_retirement_cuts WHERE session_id=?').all(sid)).toEqual([])
 }finally{db.close()}
 const imported=await f.store.readCapturedHistory(sid,{afterSequence:0})
 expect(imported.records).toHaveLength(3);expect(imported.records.every(row=>row.item!==null)).toBe(true)
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:sid,item:item('first normal')})
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:sid,item:item('second normal')})
 const rows=(await f.store.readCapturedHistory(sid,{afterSequence:0})).records
 expect(rows.slice(0,3)).toEqual(imported.records);expect(rows[3]?.item).toBeNull()
 const verify=new DatabaseSync(f.path,{readOnly:true});try{
  expect(verify.prepare('SELECT after_sequence FROM captured_retirement_cuts WHERE session_id=? AND epoch=?').get(sid,epoch)).toEqual({after_sequence:3})
 }finally{verify.close()}
 expect(f.cut()).toBe(0)
})
it('retirement preserves a different original subject with deliberately equal epoch and sequence coordinates',async()=>{
 const f=await owner('file',false),first=await f.write('first own body'),sid='different-original'
 await f.store.compareAndSwap(null,{...f.session,agentSessionId:sid,run:{runId:'different-run'}})
 const db=new DatabaseSync(f.path);try{
  db.exec('BEGIN');beginCapturedStream(db,sid,null)
  db.prepare('UPDATE captured_streams SET epoch=? WHERE session_id=?').run(first.stream.epoch,sid)
  readyCapturedStream(db,sid,null,0,[]);db.exec('COMMIT')
 }finally{db.close()}
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:sid,item:{...f.item('a','foreign body'),agentSessionId:sid}})
 await f.write('second own body')
 expect((await f.all()).records[0]?.item).toBeNull()
 expect((await f.store.readCapturedHistory(sid,{afterSequence:0})).records[0]?.item).toMatchObject({agentSessionId:sid,content:'foreign body'})
})
it.each(['file','memory']as const)('%s A-to-B-to-A recurrence never substitutes the current same-hash body into a retired frozen version',async kind=>{
 const f=await owner(kind,false),a=await f.write('original A');await f.write('original B');const again=await f.write('original A')
 expect(again.position.revision).toBe(a.position.revision)
 const old=await f.store.readCapturedHistory(f.session.agentSessionId,{epoch:a.stream.epoch,throughSequence:2,recordId:'a',recordRevision:a.position.revision})
 expect(old.records).toMatchObject([{item:null,recordId:'a',sequence:1}])
 const current=await f.store.readCapturedHistory(f.session.agentSessionId,{epoch:a.stream.epoch,throughSequence:3,recordId:'a',recordRevision:a.position.revision})
 expect(current.records).toMatchObject([{item:{content:'original A'},sequence:3}])
 await expect(f.store.readCapturedHistory(f.session.agentSessionId,{epoch:'wrong-original',recordId:'a'})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 await expect(f.store.readCapturedHistory(f.session.agentSessionId,{throughSequence:4,recordId:'a'})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
})
it.each(['file','memory']as const)('%s actual H usage counts a retired header as one visited version and zero logical body bytes without changing its policy',async kind=>{
 const f=await owner(kind,false)
 expect((await f.store.readCapturedUsage(f.session.agentSessionId,{})).status).toBe('not-measured');expect(f.cut()).toBeUndefined()
 await f.write('first');await f.write('second');await f.write('third')
 const before=await f.all(),first=await f.store.readCapturedUsage(f.session.agentSessionId,{limit:1})
 expect(first).toMatchObject({status:'measured',records:1,logicalBytes:0,afterSequence:0,lastSequence:1,throughSequence:3,complete:false})
 if(first.status!=='measured')throw Error('Expected real H measurement')
 const rest=await f.store.readCapturedUsage(f.session.agentSessionId,{cursor:first.nextCursor!,limit:10})
 expect(rest).toMatchObject({status:'measured',records:2,logicalBytes:Buffer.byteLength(JSON.stringify(f.item('a','third'))),lastSequence:3,throughSequence:3,complete:true,nextCursor:null})
 expect(await f.all()).toEqual(before);expect(f.cut()).toBe(0)
})

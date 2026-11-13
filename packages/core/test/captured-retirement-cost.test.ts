import{afterEach,expect,it,vi}from'vitest'
import{mkdtemp,rm,writeFile}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{DatabaseSync,type SQLInputValue}from'node:sqlite'
import{execFileSync}from'node:child_process'
import{AgentMuxFileAgentSessionStore}from'../src/agent-session-store.js'
import{commitCapturedMutation}from'../src/captured-history.js'
import{capturedStorageSession}from'./helpers/captured-history-fixture.js'
const closes:Array<()=>Promise<void>|void>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close()})
it('actual retirement and unavailable exact-version seeks remain indexed as retained headers grow while only one eligible head body remains',async()=>{
 const root=await mkdtemp(join(tmpdir(),'captured-g-cost-'));closes.push(()=>rm(root,{recursive:true,force:true}))
 const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.sqlite')),session=capturedStorageSession(root)
 await store.compareAndSwap(null,session)
 const item={id:'growing-head',agentSessionId:session.agentSessionId,kind:'tool_call' as const,source:'native-hook' as const,status:'streaming' as const,title:'Original process',content:'a'.repeat(4096),createdAt:1,updatedAt:1}
 const first=await store.applyTimelineMutation({type:'upsert',agentSessionId:session.agentSessionId,item})
 const db=new DatabaseSync(store.path);closes.push(()=>db.close())
 const observed:Array<{kind:string;sql:string;parameters:SQLInputValue[]}>=[],prepare=DatabaseSync.prototype.prepare
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  const statement=prepare.call(this,sql),kind=sql.startsWith("UPDATE captured_record_versions SET item_json='null'")?'retirement':sql.includes('INDEXED BY captured_exact_version')?'exact':undefined
  if(kind){
   if(kind==='retirement'){const run=statement.run.bind(statement);statement.run=(...args)=>{observed.push({kind,sql,parameters:args as SQLInputValue[]});return Reflect.apply(run,statement,args) as ReturnType<typeof run>}}
   else{const all=statement.all.bind(statement);statement.all=(...args)=>{observed.push({kind,sql,parameters:args as SQLInputValue[]});return Reflect.apply(all,statement,args) as ReturnType<typeof all>}}
  }
  return statement
 })
 const costs:unknown[]=[];let revision=0
 for(const grow of[1,128,896]){
  db.exec('BEGIN');for(let index=0;index<grow;index++)commitCapturedMutation(db,{type:'upsert',agentSessionId:session.agentSessionId,item:{...item,content:String(++revision).padEnd(4096,'x')}});db.exec('COMMIT')
  const page=await store.readCapturedHistory(session.agentSessionId,{epoch:first.stream.epoch,recordId:item.id,recordRevision:first.position.revision})
  expect(page.records).toMatchObject([{item:null,recordId:item.id,sequence:1}])
  const queries=['retirement','exact'].map(kind=>[...observed].reverse().find(query=>query.kind===kind)!)
  const sample=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
x=json.load(sys.stdin);c=sqlite3.connect('file:'+x['path']+'?mode=ro',uri=True);costs=[]
for query in x['queries']:
 n=[0]
 def tick():
  n[0]+=1
  return 0
 # EXPLAIN is the exact selected UPDATE plan, without applying any mutation.
 if query['kind']=='retirement':
  plan=c.execute('EXPLAIN QUERY PLAN '+query['sql'],query['parameters']).fetchall();costs.append({'kind':query['kind'],'plan':plan});continue
 c.set_progress_handler(tick,1);rows=c.execute(query['sql'],query['parameters']).fetchall();c.set_progress_handler(None,0)
 costs.append({'kind':query['kind'],'steps':n[0],'rows':len(rows),'plan':c.execute('EXPLAIN QUERY PLAN '+query['sql'],query['parameters']).fetchall()})
 print('',end='')
print(json.dumps(costs));c.close()`],{input:JSON.stringify({path:store.path,queries}),encoding:'utf8'}))
  const bodies=prepare.call(db,"SELECT COUNT(*) AS versions,SUM(item_json!='null') AS bodies,SUM(CASE WHEN item_json='null' THEN 0 ELSE octet_length(item_json) END) AS logicalBodyBytes FROM captured_record_versions WHERE session_id=? AND epoch=?").get(session.agentSessionId,first.stream.epoch)!
  expect(bodies.versions).toBe(revision+1);expect(bodies.bodies).toBe(1)
  expect(sample.find((row:{kind:string})=>row.kind==='retirement').plan.some((row:unknown[])=>String(row[3]).includes('(session_id=? AND epoch=? AND sequence=?)'))).toBe(true)
  expect(sample.find((row:{kind:string})=>row.kind==='exact').plan.some((row:unknown[])=>String(row[3]).includes('captured_exact_version'))).toBe(true)
  costs.push({revision,queries,sample,bodies})
 }
 const exactSteps=costs.map(row=>(row as{sample:Array<{kind:string;steps:number}>}).sample.find(row=>row.kind==='exact')!.steps)
 expect(exactSteps.at(-1)!).toBeLessThanOrEqual(exactSteps[0]!*1.2)
 if(process.env.CAPTURED_G_COST_FACTS)await writeFile(process.env.CAPTURED_G_COST_FACTS,JSON.stringify({costs,boundary:'Actual current FileStore writer/read SQL; Python readonly VM steps and actual query plans, logical original DB body bytes. Not whole-App timings or physical reclaim.'},null,2)+'\n')
})

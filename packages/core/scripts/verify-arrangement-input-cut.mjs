import { spawn,execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile,writeFile,mkdir,chmod } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const common=resolve(root,execFileSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim())
const evidence=join(dirname(common),'.local/reliability-fixes/core/arrangement-input-cut',new Date().toISOString().replaceAll(/[:.]/gu,'-')+'-'+process.pid)
await mkdir(evidence,{recursive:true,mode:0o700})
const digest=v=>createHash('sha256').update(v).digest('hex')
const paths=[
  "packages/core/src/continuous-progress-scheduler.ts",
  "packages/core/src/continuous-progress.ts",
  "packages/core/src/agent-progress.ts",
  "packages/core/src/public-rpc-schedules.ts",
  "packages/core/src/public-rpc-service.ts",
  "packages/core/src/schedule-cli.ts",
  "packages/core/src/agentmux-cli-commands.ts",
  "packages/core/src/agent-session-store.ts",
  "packages/core/src/agent-input-epoch.ts",
  "packages/core/src/agent-prompt-condition.ts",
  "packages/core/src/client.ts",
  "packages/core/src/control-codec.ts",
  "packages/core/src/storage-recovery.ts",
  "packages/identity/dist/runtime-source.js",
  "apps/host/src/continuous-progress-loop-manager.ts",
  "apps/host/src/continuous-progress-loop-store.ts",
  "apps/host/src/goal-runtime.ts",
  "apps/host/src/mote-presence.ts",
  "apps/desktop/src/main/ipc.ts",
  "apps/desktop/src/main/runtime-controller.ts",
  "apps/desktop/src/preload/index.ts",
  "apps/desktop/src/renderer/src/lib/api.ts",
  "apps/desktop/src/shared/contracts.ts",
  "apps/desktop/src/shared/continuous-progress.ts",
  "apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx",
  "apps/desktop/src/renderer/src/lib/schedule-controller.ts",
  "apps/desktop/test/arrangement-ipc-input-cut.test.ts",
  "apps/desktop/test/arrangement-input-cut.test.tsx",
  "apps/host/test/arrangement-input-cut.test.ts",
  "apps/host/test/continuous-progress-manual-check.test.ts",
  "apps/host/test/agent-automation-boundaries.test.ts",
  "apps/host/test/vitest.arrangement-input-cut.config.mts",
  "apps/host/test/tsconfig.arrangement-input-cut.json",
  "apps/desktop/test/vitest.arrangement-input-cut.config.mts",
  "packages/core/scripts/verify-arrangement-input-cut.mjs"
]
const sources=new Map(await Promise.all(paths.map(async p=>[p,await readFile(join(root,p),'utf8')])))
const receipt={schema:'agentmux.arrangement-input-cut-verification.v1',root,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),sourceSHA256:Object.fromEntries([...sources].map(([p,s])=>[p,digest(s)])),scope:'Isolated Core/Host source plus mounted Desktop/preload/registered IPC/Main. Native Runtime, Electron and unrelated Browser leaves controlled; real SQLite, public Unix RPC, source CLI and cold prompt reader. No production namespace, model or live Native.',tests:[],mutations:[]}
async function save(name,s){const p=join(evidence,name);await writeFile(p,s,{mode:0o600});await chmod(p,0o600);return p}
async function run(label,args,overrides={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(AGENTMUX_|CTXMUX_)/u.test(k)))
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...env,...overrides},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const timer=setTimeout(()=>child.kill('SIGKILL'),90_000);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,output})})})
 await save(label+'.log',result.output);return result
}
async function tests(label,group,pattern){
 const results=join(evidence,label+'.private.json'),loads=await save(label+'-loaded.private.ndjson','')
 const config=group==='host'?'apps/host/test/vitest.arrangement-input-cut.config.mts':'apps/desktop/test/vitest.arrangement-input-cut.config.mts'
 const result=await run(label,['node_modules/vitest/vitest.mjs','run','--config',config,'--reporter=json','--outputFile',results,...(pattern?['-t',pattern]:[])],{ARRANGEMENT_TEST_SOURCE_LOADS:loads})
 const parsed=JSON.parse(await readFile(results,'utf8'));await chmod(results,0o600)
 const failed=parsed.testResults.flatMap(v=>v.assertionResults??[]).filter(v=>v.status==='failed')
 const loaded=(await readFile(loads,'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v))
 for(const item of loaded)if(!item.path.startsWith(root+'/')||digest(await readFile(item.path))!==item.sha256)throw Error('Loaded owner escaped or changed: '+item.path)
 const required=group==='host'?['apps/host/src/continuous-progress-loop-manager.ts','packages/core/src/agent-session-store.ts','packages/core/src/client.ts']:['apps/desktop/src/renderer/src/lib/schedule-controller.ts','apps/desktop/src/renderer/src/components/ContinuousProgressControl.tsx']
 if(!pattern)required.push(...(group==='host'?['apps/host/src/goal-runtime.ts','apps/host/src/mote-presence.ts','packages/core/src/agentmux.ts']:['apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/main/runtime-controller.ts','apps/host/src/goal-runtime.ts']))
 for(const p of required)if(!loaded.some(v=>v.path===join(root,p)))throw Error('Real consumer not loaded: '+p)
 return{group,sourceLoads:[...new Set(loaded.map(v=>v.path))],code:result.code,total:parsed.numTotalTests,passed:parsed.numPassedTests,failed:parsed.numFailedTests,runtimeErrors:parsed.numRuntimeErrorTestSuites??0,failures:failed.map(v=>({name:v.fullName,messages:v.failureMessages})),results,loads}
}
function green(r){const count=r.group==='host'?29:8;if(r.code!==0||r.total!==count||r.passed!==count||r.failed||r.runtimeErrors)throw Error('Nonempty exact baseline failed: '+JSON.stringify({code:r.code,failed:r.failed,errors:r.runtimeErrors,failures:r.failures}))}
function replace(s,a,b){if(s.split(a).length!==2)throw Error('Mutation anchor changed: '+a);return s.replace(a,b)}
const manager='apps/host/src/continuous-progress-loop-manager.ts',scheduler='packages/core/src/continuous-progress-scheduler.ts',ui='apps/desktop/src/renderer/src/lib/schedule-controller.ts'
const mutations=[
 {id:'forget-scheduler-birth',path:scheduler,group:'host',pattern:'real Host future|current-cut pause',edit:s=>s.replaceAll('...optionalInputEpoch(input.inputEpoch),','')},
 {id:'future-owner-drops-cut',path:'apps/host/src/goal-runtime.ts',group:'host',pattern:'real Host future',edit:s=>replace(s,'...optionalInputEpoch(loop.inputEpoch),active','active')},
 {id:'old-tick-freshens',path:manager,group:'host',pattern:'old automatic progress',edit:s=>replace(s,'if(claim.loop.inputEpoch!==observation.session.inputEpoch)','if(false)')},
 {id:'new-tick-forgets-cut',path:manager,group:'host',pattern:'current-cut pause',edit:s=>replace(s,'...optionalInputEpoch(claim.loop.inputEpoch)','')},
 {id:'goal-requalifies-original-request',path:manager,group:'host',pattern:'Goal preparation copies',edit:s=>replace(s,'condition: {...originalCondition,...optionalInputEpoch(input.inputEpoch)}','condition: agentPromptCondition(observation.session)')},
 {id:'progress-wire-drops-cut',path:'packages/core/src/agent-progress.ts',group:'host',pattern:'real Host future',edit:s=>replace(s,"method === 'agent.progress.create' ? ['inputEpoch','target'","method === 'agent.progress.create' ? ['target'")},
 {id:'schedule-receipt-rewrites-cut',path:'packages/core/src/public-rpc-schedules.ts',group:'host',pattern:'public request and result codecs',edit:s=>replace(s,'schedule.inputEpoch !== request.inputEpoch || ','')},
 {id:'progress-receipt-rewrites-cut',path:'packages/core/src/agent-progress.ts',group:'host',pattern:'public request and result codecs',edit:s=>replace(s,"loop.inputEpoch !== (input as AgentProgressParams['agent.progress.create']).inputEpoch || ",'')},
 {id:'mote-birth-freshened',path:'apps/host/src/mote-presence.ts',group:'host',pattern:'Mote maintenance copies',edit:s=>replace(s,'...optionalInputEpoch(original.creation?.inputEpoch)','...optionalInputEpoch((await client.statusAgent(original.agentSessionId)).session.inputEpoch)')},
 {id:'mote-retry-freshened',path:'apps/host/src/mote-presence.ts',group:'host',pattern:'Mote maintenance copies',edit:s=>replace(s,'...optionalInputEpoch(loop.inputEpoch)','...optionalInputEpoch(original.creation?.inputEpoch)')},
 {id:'persist-business-before-freeze',path:ui,group:'desktop',pattern:'new schedule freezes',edit:s=>replace(s,"    try {\n      if(!original&&request.action==='create'","    remember(request)\n    try {\n      if(!original&&request.action==='create'")},
 {id:'ui-skips-first-reader',path:ui,group:'desktop',pattern:'first calendar gesture',edit:s=>replace(s,'await api.sessions.readInputEpoch(request.params.target.hostId)??undefined','undefined')},
 {id:'ui-renews-retained-request',path:ui,group:'desktop',pattern:'retained pre-epoch',edit:s=>replace(s,"if(!original&&request.action==='create'", "if(request.action==='create'")},
 {id:'preload-drops-original-cut',path:'apps/desktop/src/preload/index.ts',group:'desktop',pattern:'fresh restored-cut progress gesture',edit:s=>replace(s,"'continuousProgress:create', target, intervalMs, prompt, taskSource,inputEpoch)","'continuousProgress:create', target, intervalMs, prompt, taskSource)")},
 {id:'main-drops-original-cut',path:'apps/desktop/src/main/ipc.ts',group:'desktop',pattern:'fresh restored-cut progress gesture',edit:s=>replace(s,'prompt,...(inputEpoch===undefined?{}:{inputEpoch}),','prompt,')}
]
try{
 const types=await run('types',['node_modules/typescript/bin/tsc','--project','apps/host/test/tsconfig.arrangement-input-cut.json','--pretty','false']);if(types.code!==0)throw Error('Narrow source TS failed')
 for(const group of ['host','desktop']){const r=await tests('baseline-'+group,group);green(r);receipt.tests.push(r);console.log('baseline '+group+': '+r.passed+'/'+r.total)}
 for(const m of mutations){const p=join(root,m.path),original=sources.get(m.path);if(await readFile(p,'utf8')!==original)throw Error('Candidate source changed before mutation: '+m.path)
  try{const changed=m.edit(original);await writeFile(p,changed);const r=await tests('mutation-'+m.id,m.group,m.pattern)
   if(!r.sourceLoads.includes(p))throw Error('Mutated owner was not consumed: '+m.path)
   if(r.code===0||r.failed<1||r.runtimeErrors||!r.failures.length||r.failures.some(v=>!v.messages.some(s=>/AssertionError|expected |promise rejected .*instead of resolving/isu.test(s))))throw Error('Mutation not rejected by business assertion: '+m.id+' '+JSON.stringify({code:r.code,failed:r.failed,errors:r.runtimeErrors,failures:r.failures}))
   receipt.mutations.push({id:m.id,mutantSHA256:digest(changed),...r});console.log('mutation '+m.id+': rejected')
  }finally{await writeFile(p,original)}
 }
 for(const group of ['host','desktop']){const r=await tests('restored-'+group,group);green(r);receipt.tests.push(r)}
 for(const[p,s]of sources)if(await readFile(join(root,p),'utf8')!==s)throw Error('Source not restored: '+p)
 receipt.verdict='pass';console.log('restored: 37 tests; '+mutations.length+'/'+mutations.length+' mutations rejected')
}catch(e){receipt.verdict='fail';receipt.failure=e.stack??String(e);process.exitCode=1;console.error(receipt.failure)}
finally{for(const m of mutations){const p=join(root,m.path);if(await readFile(p,'utf8')!==sources.get(m.path))await writeFile(p,sources.get(m.path))}receipt.endedAt=new Date().toISOString();console.log('evidence: '+await save('verification.private.json',JSON.stringify(receipt,null,2)+'\n'))}

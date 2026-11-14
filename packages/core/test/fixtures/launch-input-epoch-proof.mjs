import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider } from '../../src/index.ts'
process.umask(0o077)
const root=process.env.AGENTMUX_LAUNCH_EPOCH_ROOT, mode=process.argv[2]
assert.ok(root)
for(const key of Object.keys(process.env))if(/^(AGENTMUX_|CTXMUX_)/u.test(key)&&!/^AGENTMUX_(LAUNCH_EPOCH_|SOURCE_)/u.test(key))delete process.env[key]
process.env.AGENTMUX_RUNTIME_DIRECTORY=join(root,'r');process.env.AGENTMUX_STATE_DIRECTORY=join(root,'s');process.env.AGENTMUX_MESSAGE_QUEUE_PATH=join(root,'messages.sqlite')
const cp=createRequire(import.meta.url)('node:child_process'),fork=cp.fork
cp.fork=(path,args,options)=>fork(String(path).endsWith('/control-endpoint-listener-worker.js')?process.env.AGENTMUX_SOURCE_LISTENER_ASSET:path,args,options);syncBuiltinESMExports()
const script="const fs=require('node:fs'),crypto=require('node:crypto');const at=process.argv.indexOf('--proof-resume');let nativeId=crypto.randomUUID();if(at>=0){const old=JSON.parse(fs.readFileSync('native-protocol.json'));if(old.nativeId!==process.argv[at+1])process.exit(2);nativeId=old.nativeId;}process.stdin.setRawMode(true);process.stdin.on('data',d=>{fs.appendFileSync('input.log',d);process.stdout.write('INPUT:'+d)});fs.writeFileSync('native-protocol.json',JSON.stringify({schema:'launch-epoch-private-v1',pid:process.pid,sid:process.env.AGENTMUX_AGENT_SESSION_ID,nativeId}),{mode:0o600});console.log('READY');setInterval(()=>{},1000)"
const provider=defineAgentProvider({catalog:{id:'launch-cut-proof',label:'Private launch cut proof',executable:process.execPath,expectedProcess:'node',promptDelivery:'post-launch-only',readySignal:{kind:'foreground-process',expectedProcess:'node'},hookStrategy:{kind:'none'},resumeStrategy:{kind:'provider-native'},acpStrategy:{kind:'none'},capabilities:{terminal:true,timeline:'unavailable',permission:'none',providerResume:true,replyCorrelation:'none'}},hook:{rules:[]},
 buildArgs:(prompt,args)=>[...args,...(prompt?[prompt]:[])],buildResumeArgs:(id,path,prompt,args)=>[...args,'--','--proof-resume',id,...(prompt?[prompt]:[])],
 discoverNativeSession:async context=>{let packet;try{packet=JSON.parse(await readFile(join(context.workspacePath,'native-protocol.json'),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}if(packet.schema!=='launch-epoch-private-v1'||packet.pid!==context.processId)return null;return{handle:{kind:'provider',providerId:'launch-cut-proof',sessionId:packet.nativeId},assertCurrent:async()=>assert.deepEqual(JSON.parse(await readFile(join(context.workspacePath,'native-protocol.json'),'utf8')),packet)}}})
const storePath=join(root,'sessions.sqlite'),store=new AgentMuxFileAgentSessionStore(storePath),client=new AgentMuxClient({store,providers:[provider]})
Object.defineProperty(client.hookServer,'port',{value:0})
let daemon,starts=0;const resources={daemonPid:null,runPids:[],cleanupErrors:[]},rows=[]
const check=(value,label)=>assert.ok(value,'LAUNCH_EPOCH: '+label)
const wait=async(read,predicate,label)=>{for(let i=0;i<160;i++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,25))}assert.fail('LAUNCH_EPOCH: '+label)}
const cut=async name=>{const sourceSHA256=createHash('sha256').update(await readFile(storePath)).digest('hex');const result=await store.admitRecoveryInputCut({operationId:name,sourceSHA256});check(result.state==='admitted','real original Store cut admitted');return result.inputEpoch}
const request=async(id,prompt='',inputEpoch)=>{const cwd=join(root,id);await mkdir(cwd,{recursive:true});return{providerId:provider.id,executorId:'private-node',workspacePath:cwd,agentSessionId:id,createOperationId:'create-'+id,injectAgentMuxGuide:false,prompt,...(inputEpoch===undefined?{}:{inputEpoch}),args:['-e',script]}}
const refused=async(work,label)=>{let denied=false;try{await work()}catch(error){denied=['AGENT_PROMPT_INPUT_UNCONFIRMED','INVALID_AGENT_SESSION_STORE'].includes(error.code)}check(denied,label)}
try{
 await mkdir(join(root,'r'));await mkdir(join(root,'s'))
 daemon=spawn(process.env.AGENTMUX_LAUNCH_EPOCH_DAEMON,['--socket',join(root,'r/ctxmux.sock'),'--state-dir',join(root,'s/ctxmux'),'--readiness-fd','3'],{stdio:['ignore','ignore','pipe','pipe']});resources.daemonPid=daemon.pid
 let daemonError='';daemon.stderr.on('data',value=>{daemonError+=value})
 await Promise.race([once(daemon.stdio[3],'data'),once(daemon,'exit').then(()=>{throw new Error(daemonError)})]);await client.connect()
 const start=client.kernel.startPrepared.bind(client.kernel);client.kernel.startPrepared=async(...args)=>{starts++;return start(...args)}
 // A genuinely new empty create remains available in its original never-restored namespace.
 const originalRequest=await request('original');const original=(await client.createAgentWithDelivery(originalRequest)).session
 await wait(()=>client.refreshAgentSession(original.agentSessionId),value=>value.nativeHandle?.kind==='provider','real native protocol identity observed')
 const epoch=await cut('restore-one');assert.equal(await client.readAgentInputEpoch(),epoch)
 if(mode==='empty'){
  const before=starts;await refused(async()=>client.createAgentWithDelivery(await request('stale-empty')),'old empty create is refused');await refused(async()=>client.createAgentWithDelivery(await request('stale-prompt','old task')),'old prompt create is refused');check(starts===before,'stale creates issue zero Native Start')
  const fresh=await client.createAgentWithDelivery(await request('fresh-empty','',epoch));check(fresh.session.creation.inputEpoch===epoch,'fresh empty create retains original birth epoch');check(starts===before+1,'fresh restored empty create uses actual Native')
  rows.push({staleEmpty:true,stalePrompt:true,freshEmpty:true})
 }else if(mode==='post-launch'||mode==='post-launch-cut'){
  if(mode==='post-launch-cut'){
   const commit=client.registry.commitLifecycle.bind(client.registry)
   client.registry.commitLifecycle=async(...args)=>{const result=await commit(...args);if(args[0].kind==='create'&&args[0].agentSessionId==='fresh-prompt')await cut('restore-two');return result}
  }
  const input=await request('fresh-prompt','new explicitly frozen task',epoch)
  const delivered=await client.createAgentWithDelivery(input)
  const run=await client.kernel.status(delivered.session.run.runId)
  if(mode==='post-launch'){
   await wait(()=>client.kernel.status(run.runId),value=>value.acceptedInputBytes>0,'fresh post-launch input reaches real CLI')
   check((await readFile(join(input.workspacePath,'input.log'),'utf8')).includes(input.prompt),'real CLI receives fresh original prompt')
  }else{
   await new Promise(resolve=>setTimeout(resolve,150));check((await client.kernel.status(run.runId)).acceptedInputBytes===0,'post-launch stale observer sends zero original bytes')
   check((await store.readMetadata('fresh-prompt')).initialInput.state==='unknown','cut preserves unknown original input outcome')
  }
  rows.push({actualNativePostLaunch:true,heldAtCut:mode==='post-launch-cut'})
 }else if(mode==='late-create-cut'){
  const reserve=store.reserveLifecycle.bind(store);let changed=false
  store.reserveLifecycle=async input=>{if(input.kind==='create'&&input.agentSessionId==='late-create'&&!changed){changed=true;await cut('restore-two')}return reserve(input)}
  const before=starts;await refused(async()=>client.createAgentWithDelivery(await request('late-create','',epoch)),'final create authority refuses intervening real cut')
  check(changed&&starts===before,'intervening cut issues zero Native Start')
  check(Boolean((await store.loadCreationCorrelation('late-create'))?.preparedDispatch),'final refusal retains exact original prepared seed')
  rows.push({realCutBeforeReservation:true,originalPreparedRetained:true})
 }else{
  const frozen=await store.readMetadata(original.agentSessionId),native=frozen.nativeHandle.sessionId
  await client.kernel.stop(await client.kernel.prepareStop(original.run.runId));await wait(()=>client.kernel.status(original.run.runId),value=>value.state.type!=='running','original private Run ended')
  const before=starts
  if(mode==='resume'){
   await refused(()=>client.resumeAgent({agentSessionId:original.agentSessionId,operationId:'old-resume',prompt:'old task'}),'old prompt resume is refused')
   check(starts===before,'old resume issues zero Native Start')
   const resumed=await client.resumeAgent({agentSessionId:original.agentSessionId,operationId:'new-resume',prompt:'fresh resume task',inputEpoch:epoch})
   check(resumed.nativeHandle.sessionId===native&&starts===before+1,'fresh resume uses original real native context')
   await wait(()=>client.kernel.status(resumed.run.runId),value=>value.acceptedInputBytes>0,'fresh resume original input reaches real CLI')
  }else if(mode==='resume-no-input'){
   const resumed=await client.ensureAgentContinuity({agentSessionId:original.agentSessionId,expectedRun:original.run,operationId:'metadata-resume',trigger:'manual'})
   check(resumed.kind==='resumed'&&resumed.session.nativeHandle.sessionId===native&&starts===before+1,'no-input original context resumes without new epoch grant')
   check((await client.kernel.status(resumed.run.runId)).acceptedInputBytes===0,'no-input resume sends zero business bytes')
  }else if(mode==='resume-final-unknown'){
   const prepare=client.kernel.prepareStart.bind(client.kernel),read=store.readInputEpoch.bind(store);let fault=false
   client.kernel.prepareStart=(...args)=>{const result=prepare(...args);fault=true;return result}
   store.readInputEpoch=async()=>{if(fault){const error=new Error('injected original namespace EIO');error.code='INVALID_AGENT_SESSION_STORE';throw error}return read()}
   await refused(()=>client.resumeAgent({agentSessionId:original.agentSessionId,operationId:'guarded-resume',prompt:'fresh task',inputEpoch:epoch}),'final resume namespace unknown is refused')
   check(fault&&starts===before,'final resume authority issues zero Native Start')
  }else assert.fail('unknown proof mode')
  rows.push({mode,originalNativeId:native,actualNativeResume:mode!=='resume-final-unknown'})
 }
 check(rows.length>0,'nonempty causal assertions')
 console.log('LAUNCH_EPOCH_JSON:'+JSON.stringify({pass:true,mode,rows,starts,realPrivateNative:true}))
}finally{
 try{if(client.kernel.isConnected())for(const run of await client.kernel.list())if(run.state.type==='running'){resources.runPids.push(run.pid);await client.kernel.stop(await client.kernel.prepareStop(run.runId))}}catch(error){resources.cleanupErrors.push(String(error))}
 try{await client.dispose()}catch(error){resources.cleanupErrors.push(String(error))}
 if(daemon&&daemon.exitCode===null&&daemon.signalCode===null){const ended=once(daemon,'exit');daemon.kill('SIGTERM');await ended}
 await writeFile(join(root,'cleanup.json'),JSON.stringify(resources,null,2),{mode:0o600});assert.deepEqual(resources.cleanupErrors,[])
}

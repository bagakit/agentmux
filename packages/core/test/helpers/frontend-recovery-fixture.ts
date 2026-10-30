import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { headlessFixture, until } from './headless-runtime-fixture.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
export async function frontendRecoveryFixture(cleanups: Array<() => Promise<unknown>>, mode:'code'|'throw'|'late'='code', detached = true) {
  const scope=await headlessFixture();cleanups.push(scope.cleanup)
  const sdk=await scope.client(),command=join(scope.root,'native.mjs'),events=join(scope.root,'frontends.ndjson'),control=join(scope.root,'control.json'),record=join(scope.root,'rollout-private.jsonl'),native=join(scope.root,'native-inputs.ndjson'),nativeRpc=join(scope.root,'native-rpc.ndjson')
  const sid='00000000-0000-4000-8000-000000000087'
  await writeFile(control,JSON.stringify({fail:[],detach:false}))
  await writeFile(command,`#!/usr/bin/env node
import {appendFileSync,openSync,writeSync,readFileSync,existsSync} from 'node:fs'
const args=process.argv.slice(2),sid=${JSON.stringify(sid)},control=${JSON.stringify(control)},events=${JSON.stringify(events)}
if(args.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')){console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')){
 const WS=(await import(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))})).default
 const retained=existsSync(${JSON.stringify(record)})?readFileSync(${JSON.stringify(record)},'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[]
 const fd=openSync(${JSON.stringify(record)},'a');let ordinal=retained.length?Math.max(...retained.map(row=>row.ordinal)):-1
 const event=payload=>writeSync(fd,JSON.stringify({type:'event_msg',ordinal:++ordinal,timestamp:new Date().toISOString(),payload})+'\\n')
 if(!retained.length)writeSync(fd,JSON.stringify({type:'session_meta',ordinal:++ordinal,payload:{id:sid,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
 event({type:'task_started',turn_id:'original-turn'})
 let activity=false;setInterval(()=>{if(!activity&&JSON.parse(readFileSync(control,'utf8')).activity){activity=true;event({type:'task_started',turn_id:'new-original-turn'})}},20)
 const server=new WS.WebSocketServer({port:0,host:'127.0.0.1'})
 server.on('connection',ws=>ws.on('message',bytes=>{const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
 appendFileSync(${JSON.stringify(nativeRpc)},JSON.stringify({method:p.method})+'\\n')
 if(p.method==='turn/start'){appendFileSync(${JSON.stringify(native)},JSON.stringify(p)+'\\n');if(p.params.input[0].text.includes('UNKNOWN_INPUT'))return ws.close()}
 const thread={id:sid,sessionId:'same-loaded-object',canAcceptDirectInput:true,status:{type:'idle'}}
 ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result:p.method==='account/read'?{account:null,requiresOpenaiAuth:false}:p.method==='thread/read'?{thread}:p.method==='thread/start'||p.method==='thread/resume'?{thread,cwd:p.params.cwd,approvalPolicy:p.params.approvalPolicy,model:p.params.model,sandbox:{type:p.params.sandbox==='read-only'?'readOnly':p.params.sandbox==='workspace-write'?'workspaceWrite':'dangerFullAccess'}}:p.method==='turn/start'?{turn:{id:'native-turn'}}:{}}))}))
}else{
 const index=existsSync(events)?readFileSync(events,'utf8').trim().split('\\n').length+1:1
 appendFileSync(events,JSON.stringify({index,args,pid:process.pid})+'\\n');process.stdin.setRawMode(true)
 process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u'))process.stdout.write('\\x1b[?2026h› \\x1b[?2026l');else process.stdout.write('INPUT:'+String(bytes))})
 const fail=()=>{process.stderr.write('private original bootstrap failure '+index+'\\n');${mode==='throw' ? "throw new Error('private native exception')" : 'process.exit(23)'}}
 const settings=JSON.parse(readFileSync(control,'utf8'))
 if(!(settings.fail.includes(index)&&${JSON.stringify(mode)}==='late'))setTimeout(()=>process.stdout.write('\\x1b[?u'),0)
 if(settings.fail.includes(index))setTimeout(fail,${mode==='late'?11500:300})
 setInterval(()=>{const next=JSON.parse(readFileSync(control,'utf8'));if(index===1&&next.detach)process.exit(31)},20)
}
`,{mode:0o700})
  const original=await sdk.createAgent({providerId:'codex',executorId:'codex',agentSessionId:'frontend-original',createOperationId:'create-original',workspacePath:scope.root,commandOverride:command,prompt:'ORIGINAL_PROMPT_DO_NOT_REPLAY',injectAgentMuxGuide:false})
  cleanups.push(async()=>{const reader=await scope.client();const current=await reader.statusAgent(original.agentSessionId);if(current.run.state==='running')await reader.stopAgent(original.agentSessionId,current.session.run)})
  const store=new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const before=await until(()=>sdk.statusAgent(original.agentSessionId),value=>value.session.nativeHandle?.sessionId===sid&&value.session.terminalHandshake?.acknowledged===true,'original native and frontend').catch(async error=>{
    const evidence=process.env.AGENTMUX_TEST_FRONTEND_BOOTSTRAP_EVIDENCE
    if(evidence){
      const current=await sdk.statusAgent(original.agentSessionId).catch(failure=>({observationError:String(failure)}))
      const retained=await store.readMetadata(original.agentSessionId)
      const rows=async(path:string)=>{const text=await readFile(path,'utf8').catch(failure=>{if(failure.code==='ENOENT')return '';throw failure});return text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[]}
      const calls=await rows(nativeRpc),frontends=await rows(events),inputs=await rows(native)
      const evidencePath=evidence.replace(/\.json$/u,'')+'-'+scope.root.split('/').at(-1)+'.json'
      await writeFile(evidencePath,JSON.stringify({schema:'agentmux.frontend-bootstrap-diagnostic.v1',mode,error:String(error),status:current,
        initialInput:retained?.initialInput?{state:retained.initialInput.state,key:retained.initialInput.key,delivery:retained.initialInput.delivery}:null,
        nativeActor:retained?.nativeActor?{actorId:retained.nativeActor.actorId,lifecycleOperationId:retained.nativeActor.lifecycleOperationId,initializationControl:retained.nativeActor.initializationControl,frontendControl:retained.nativeActor.frontendControl}:null,
        nativeCalls:calls,frontendCount:frontends.length,frontendPids:frontends.map(value=>value.pid),nativeInputCount:inputs.length},
        (key,value)=>/token|credential|secret|capabilityHash|args|env|endpoint|launch|hookBinding|body|^prompt$/iu.test(key)?undefined:value,2)+'\n')
    }
    throw error
  })
  const starts=async()=> (await readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const saveControl=async(value:unknown)=>{await writeFile(control+'.next',JSON.stringify(value));await rename(control+'.next',control)}
  const configure=(fail:number[],detach=true)=>saveControl({fail,detach})
  if (detached) {
    await configure([2])
    await until(()=>sdk.statusAgent(original.agentSessionId),value=>value.session.terminalFrontend?.state==='detached','original frontend failure')
  }
  const root=(session:any,id='startup-original')=>session.continuityOperations?.[id]
  const recover=(policy:any={})=>sdk.ensureAgentContinuity({agentSessionId:original.agentSessionId,expectedRun:original.run,operationId:'startup-original',trigger:'startup',policy:{retryInitialDelayMs:1200,retryMaxDelayMs:1200,retryMaxAttempts:2,recheckIntervalMs:1200,...policy}})
  const activity=()=>saveControl({fail:[2],detach:true,activity:true})
  return {scope,sdk,store,original,before,starts,configure,root,recover,native,command,activity}
}

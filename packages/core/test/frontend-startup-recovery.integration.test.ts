import { afterEach, expect, it } from 'vitest'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
const cleanups: Array<() => Promise<unknown>>=[]
afterEach(async()=>{const errors:unknown[]=[];for(const close of cleanups.splice(0).reverse()){try{await close()}catch(error){errors.push(error)}}if(errors.length)throw new AggregateError(errors,'Private frontend cleanup failed')})
async function fixture(mode:'code'|'throw'|'late'='code') {
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
 const fd=openSync(${JSON.stringify(record)},'a');writeSync(fd,JSON.stringify({type:'session_meta',ordinal:0,payload:{id:sid,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n');writeSync(fd,JSON.stringify({type:'event_msg',ordinal:1,timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'original-turn'}})+'\\n')
 let activity=false;setInterval(()=>{if(!activity&&JSON.parse(readFileSync(control,'utf8')).activity){activity=true;writeSync(fd,JSON.stringify({type:'event_msg',ordinal:2,timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'new-original-turn'}})+'\\n')}},20)
 const server=new WS.WebSocketServer({port:0,host:'127.0.0.1'})
 server.on('connection',ws=>ws.on('message',bytes=>{const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
 appendFileSync(${JSON.stringify(nativeRpc)},JSON.stringify({method:p.method})+'\\n')
 if(p.method==='turn/start'){appendFileSync(${JSON.stringify(native)},JSON.stringify(p)+'\\n');if(p.params.input[0].text.includes('UNKNOWN_INPUT'))return ws.close()}
 const thread={id:sid,sessionId:'same-loaded-object',canAcceptDirectInput:true}
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
  await configure([2])
  await until(()=>sdk.statusAgent(original.agentSessionId),value=>value.session.terminalFrontend?.state==='detached','original frontend failure')
  const root=(session:any,id='startup-original')=>session.continuityOperations?.[id]
  const recover=(policy:any={})=>sdk.ensureAgentContinuity({agentSessionId:original.agentSessionId,expectedRun:original.run,operationId:'startup-original',trigger:'startup',policy:{retryInitialDelayMs:1200,retryMaxDelayMs:1200,retryMaxAttempts:2,recheckIntervalMs:1200,...policy}})
  const activity=()=>saveControl({fail:[2],detach:true,activity:true})
  return {scope,sdk,store,original,before,starts,configure,root,recover,native,command,activity}
}
it.runIf(process.platform==='darwin').each(['code','throw'] as const)('same-Run %s frontend failure survives a real Core owner restart, retries once, and remains observable through CLI',async mode=>{
 const f=await fixture(mode);await f.recover()
 const waiting=await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.phase==='retry-wait','durable frontend retry schedule')
 const beforeRoot=structuredClone(f.root(waiting.session)),beforeOwner=f.scope.owner
 expect(beforeRoot.supervision.attemptCount).toBe(1)
 await f.sdk.dispose();await f.scope.restart();const reader=await f.scope.client()
 expect(f.scope.owner.runtimeId).toBe(beforeOwner.runtimeId);expect(f.scope.owner.ownerInstanceId).not.toBe(beforeOwner.ownerInstanceId);expect(f.scope.owner.ctxmux).toEqual(beforeOwner.ctxmux)
 const after=await until(()=>reader.statusAgent(f.original.agentSessionId),value=>value.session.terminalFrontend?.state==='attached'&&value.session.terminalHandshake?.frontendId===value.session.terminalFrontend.frontendId&&value.session.terminalHandshake.acknowledged&&f.root(value.session)?.supervision?.reason==='frontend-attached','same backend frontend restored')
 expect(after.run).toMatchObject({runId:f.before.run.runId,pid:f.before.run.pid,state:'running'})
 expect(after.session.nativeHandle).toEqual(f.before.session.nativeHandle)
 expect(f.root(after.session).supervision).toMatchObject({attemptCount:2,attemptLimit:3,reason:'frontend-attached'})
 expect(f.root(after.session).supervision.contextEvidence).toBeUndefined()
 const spawns=await f.starts();expect(spawns).toHaveLength(3);expect(JSON.stringify(spawns.slice(1))).not.toContain('ORIGINAL_PROMPT_DO_NOT_REPLAY')
 const cli=await runCompiledObjectCli(['--endpoint',`unix:${f.scope.socketPath}`,'agent','inspect','--session',f.original.agentSessionId],f.scope.env)
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);expect(cli.stdout).toContain(f.before.run.runId);expect(cli.stdout).toContain('frontend-attached')
 const nativeInput={agentSessionId:f.original.agentSessionId,expectedRun:f.original.run,operationId:'fresh-native-input',execution:'immediate' as const,admissionIntent:{kind:'native-conversation' as const,source:{providerId:'codex',nativeSessionId:f.before.session.nativeHandle!.sessionId}},prompt:'HEALTHY_INPUT_AFTER_RECOVERY',authorHuman:true}
 await reader.submitAgentPrompt(nativeInput);await until(async()=>readFile(f.native,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error}),value=>value.includes('HEALTHY_INPUT_AFTER_RECOVERY'),'healthy native input remains available')
})
it.runIf(process.platform==='darwin')('exhausted frontend budget is immutable when a fresh startup retries; a native unknown input is never resent',async()=>{
 const f=await fixture();const prompt={agentSessionId:f.original.agentSessionId,expectedRun:f.original.run,operationId:'original-unknown',execution:'immediate' as const,admissionIntent:{kind:'native-conversation' as const,source:{providerId:'codex',nativeSessionId:f.before.session.nativeHandle!.sessionId}},prompt:'UNKNOWN_INPUT_DO_NOT_REPLAY',authorHuman:true}
 await f.sdk.submitAgentPrompt(prompt)
 const inputKey={kind:'prompt' as const,agentSessionId:f.original.agentSessionId,expectedRun:f.original.run,submissionId:prompt.operationId}
 const unknown=await until(()=>f.sdk.inspectAgentPromptSubmission(inputKey),value=>value?.admission?.transport==='native'&&value.admission.native.outcome==='unknown','original unknown input')
 await f.recover({retryMaxAttempts:0})
 const paused=await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.reason==='frontend-retry-budget-exhausted','original budget exhausted')
 const old=structuredClone(f.root(paused.session));expect(old.supervision.attemptCount).toBe(1)
 await f.sdk.dispose();await f.scope.restart();const reader=await f.scope.client()
 await reader.ensureAgentContinuity({agentSessionId:f.original.agentSessionId,expectedRun:f.original.run,operationId:'new-startup',trigger:'startup',policy:{retryMaxAttempts:0}})
 const after=await until(()=>reader.statusAgent(f.original.agentSessionId),value=>value.session.terminalFrontend?.state==='attached'&&f.root(value.session,'new-startup')?.supervision?.reason==='frontend-attached','fresh startup actual attempt')
 expect(f.root(after.session)).toEqual(old);expect(after.run).toMatchObject({runId:f.before.run.runId,pid:f.before.run.pid})
 expect(await reader.inspectAgentPromptSubmission(inputKey)).toEqual(unknown)
 const nativeCalls=(await readFile(f.native,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 expect(nativeCalls.filter(call=>call.params.input.some(part=>part.text?.includes(prompt.prompt)))).toHaveLength(1)
 expect(nativeCalls.filter(call=>call.params.input.some(part=>part.text?.includes('ORIGINAL_PROMPT_DO_NOT_REPLAY')))).toHaveLength(1)
 expect(nativeCalls).toHaveLength(2);expect(await f.starts()).toHaveLength(3)
})
it.runIf(process.platform==='darwin')('lost frontend receipt is reconciled with its exact operation across owner restart, without another spawn',async()=>{
 const f=await fixture();await f.configure([])
 await writeFile(join(f.scope.env.AGENTMUX_STATE_DIRECTORY!,'lose-frontend-receipt'),'lose once')
 const response=await f.recover();expect(response.kind).toBe('pending')
 const before=await f.store.readMetadata(f.original.agentSessionId),operation=f.root(before)
 expect(operation.frontendReconnect.frontendId).toBeUndefined();expect(operation.reason).toBe('operation-unconfirmed')
 await f.sdk.dispose();await f.scope.restart();const reader=await f.scope.client()
 const after=await until(()=>reader.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.reason==='frontend-attached','same original operation reconciliation')
 expect(f.root(after.session).operationId).toBe(operation.operationId);expect(f.root(after.session).supervision.attemptCount).toBe(1)
 const calls=(await readFile(join(f.scope.env.AGENTMUX_STATE_DIRECTORY!,'reconnect-operations.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 expect(calls.length).toBeGreaterThanOrEqual(2);expect(new Set(calls.map(value=>value.operationId)).size).toBe(1);expect(await f.starts()).toHaveLength(2)
})
it.runIf(process.platform==='darwin')('a late bootstrap exit after the handshake observation paused resumes the same original intent',async()=>{
 const f=await fixture('late');await f.recover({retryInitialDelayMs:30,retryMaxDelayMs:30})
 const after=await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.attemptCount===2&&f.root(value.session)?.supervision?.reason==='frontend-attached','late bootstrap failure recovered',25000)
 expect(after.run).toMatchObject({runId:f.before.run.runId,pid:f.before.run.pid});expect(await f.starts()).toHaveLength(3)
 expect(f.root(after.session).supervision.contextEvidence).toBeUndefined()
})

it.runIf(process.platform==='darwin')('a native resumed Run with no frontend retry budget can be continued without replacing its live backend',async()=>{
 const f=await fixture();await f.activity();await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>value.session.semanticStatus?.state==='working'&&value.session.semanticStatus.source==='native-transcript','fresh original native activity')
 await f.sdk.stopTerminal(f.original.run)
 await until(()=>f.sdk.listRuns(),runs=>runs.find(run=>run.runId===f.original.run.runId)?.state!=='running','original fixture Run ended')
 const resumed=await f.sdk.ensureAgentContinuity({agentSessionId:f.original.agentSessionId,expectedRun:f.original.run,operationId:'startup-original',trigger:'startup',commandOverride:f.command,policy:{retryMaxAttempts:0}})
 expect(resumed.kind,JSON.stringify(resumed)).toBe('resumed')
 const paused=await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.reason==='frontend-retry-budget-exhausted','native resume frontend paused')
 expect(paused.run.runId).not.toBe(f.before.run.runId);expect(f.root(paused.session).frontendReconnect).toBeUndefined()
 const continued=await f.sdk.controlAgentContinuity({agentSessionId:f.original.agentSessionId,expectedRun:paused.session.run,intentOperationId:'startup-original',operationId:'continue-original-front',action:'continue',additionalAttempts:1})
 expect(continued.receipt.outcome).toBe('continued')
 const after=await until(()=>f.sdk.statusAgent(f.original.agentSessionId),value=>f.root(value.session)?.supervision?.reason==='frontend-attached','native resume frontend continuation')
 expect(after.run).toMatchObject({runId:paused.run.runId,pid:paused.run.pid,state:'running'});expect(after.session.nativeHandle).toEqual(f.before.session.nativeHandle)
 expect(f.root(after.session).supervision.attemptCount).toBe(2);expect(await f.starts()).toHaveLength(3)
})

it.runIf(process.platform==='darwin')('a prepared exact Stop lease blocks the first automatic frontend side effect and preserves the healthy backend',async()=>{
 const f=await fixture(),directory=f.scope.env.AGENTMUX_STATE_DIRECTORY!,result=join(directory,'prepared-stop')
 await writeFile(join(directory,'prepare-stop'),f.original.agentSessionId)
 const lease=await until(async()=>JSON.parse(await readFile(result,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error})),value=>value.kind==='stop','real native Stop prepared and exact Core lease retained')
 expect(lease.expectedRun).toEqual(f.original.run)
 try{
  const response=await f.recover();expect(response.kind).toBe('pending');if(response.kind==='pending')expect(response.reason).toBe('intent-cancelled')
  expect(await f.starts()).toHaveLength(1);const current=await f.sdk.statusAgent(f.original.agentSessionId);expect(current.run).toMatchObject({runId:f.before.run.runId,pid:f.before.run.pid,state:'running'})
  expect((await f.store.readLifecycleReservation(f.original.agentSessionId))?.reservationId).toBe(lease.reservationId)
 }finally{await writeFile(join(directory,'release-stop'),'release test-only prepared lease');await until(async()=>JSON.parse(await readFile(result,'utf8')),value=>value.released===true,'private prepared Stop lease released')}
})

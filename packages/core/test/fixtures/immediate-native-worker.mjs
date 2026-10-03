import { tmpdir as upstreamFixtureTmpdir } from 'node:os'
import { join as upstreamFixtureJoin, parse as upstreamFixtureParse, sep as upstreamFixtureSep } from 'node:path'
import { pathToFileURL as upstreamFixturePathToFileURL } from 'node:url'
const upstreamFixtureRoot = upstreamFixtureJoin(upstreamFixtureTmpdir(), 'agentmux-fixtures');
const upstreamFixtureDayMilliseconds = 24 * 60 * 60 * 1_000;
/** Preserve lexical path cases while deriving the absolute root from this Host. */
function upstreamFixturePath(relative) {
    const temporary = relative.replace(/^(?:private\/)?tmp\//u, '');
    const base = temporary === relative ? upstreamFixtureRoot : upstreamFixtureTmpdir();
    return base + upstreamFixtureSep + temporary.replaceAll('/', upstreamFixtureSep);
}
/** Deterministic time from Unix zero and explicit relative units. */
function upstreamFixtureEpoch(days, seconds = 0, milliseconds = 0) {
    return days * upstreamFixtureDayMilliseconds + seconds * 1_000 + milliseconds;
}
function upstreamFixtureDay(days, separator = '-') {
    return new Date(upstreamFixtureEpoch(days)).toISOString().slice(0, 10).replaceAll('-', separator);
}
function upstreamFixtureClock(hour, minute, second, milliseconds) {
    const units = second === undefined ? [hour, minute] : [hour, minute, second];
    const clock = units.map(value => String(value).padStart(2, '0')).upstreamFixtureJoin(':');
    return milliseconds === undefined ? clock : clock + '.' + milliseconds;
}
function upstreamFixtureFileUrl(relative) {
    return upstreamFixturePathToFileURL(upstreamFixturePath(relative)).href;
}
/** A short Host-rooted display path keeps captured terminal rows within their viewport. */
function upstreamFixtureDisplayPath(relative) {
    return upstreamFixtureJoin(upstreamFixtureParse(upstreamFixtureTmpdir()).root, relative);
}
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat, unlink, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, agentPromptCondition } from '../../dist/index.js'
const execute=promisify(execFile),root=await realpath(await mkdtemp(upstreamFixtureDisplayPath("tmp/amux-immediate-native-")))
const evidenceDirectory=process.argv[2]
await mkdir(evidenceDirectory,{recursive:true})
const report={schema:'agentmux.immediate-native.v1',passed:false,root,protocol:'Codex 0.160.1 default embedded TUI/Responses',phases:[]}
for(const name of ['runtime','durable','workspace','codex-home'])await mkdir(join(root,name),{mode:0o700})
process.env.AGENTMUX_RUNTIME_DIRECTORY=join(root,'runtime');process.env.AGENTMUX_STATE_DIRECTORY=join(root,'durable')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH=join(root,'messages.ndjson');process.env.AGENTMUX_AGENT_SESSION_STORE=join(root,'sessions.json')
const until=async(description,check,timeout=20_000)=>{const end=Date.now()+timeout;do{const found=await check();if(found)return found;await new Promise(r=>setTimeout(r,25))}while(Date.now()<end);throw new Error('Private native proof timeout: '+description)}
const nativeDaemon=fileURLToPath(new URL('../../vendor/ctxmux/darwin-arm64/bin/ctxmuxd',import.meta.url))
const daemon=spawn(nativeDaemon,['--socket',join(root,'runtime','ctxmux.sock'),'--state-dir',join(root,'durable','ctxmux'),'--readiness-fd','3'],{stdio:['ignore','ignore','pipe','pipe']})
let daemonError='';daemon.stderr.on('data',b=>{daemonError+=b});const daemonClosed=once(daemon,'close');void daemonClosed.catch(()=>{})
const requests=[],held=new Set()
const backend=createServer(async(req,res)=>{
 let body='';for await(const b of req)body+=b
 if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end('{"data":[]}');return}
 const value=JSON.parse(body);const lastUser=value.input?.filter(v=>v.role==='user').at(-1),lastText=lastUser?.content?.map(c=>c.text??'').join('');if(!Array.isArray(value.input)||!lastText?.startsWith('PRIVATE_')){res.setHeader('Content-Type','application/json');res.end('{}');return}const index=requests.length;requests.push(value)
 res.writeHead(200,{'Content-Type':'text/event-stream'});const event=v=>res.write('event: '+v.type+'\ndata: '+JSON.stringify(v)+'\n\n')
 const id='response_private_'+index
 event({type:'response.created',response:{id,status:'in_progress',output:[]}})
 // Initial and the separate busy turn intentionally have no tool/result boundary.
 const serialized=JSON.stringify(value.input)
 if(index===0 || serialized.includes('PRIVATE_SECOND_BUSY')&&!serialized.includes('PRIVATE_NATIVE_PENDING')){held.add(res);res.once('close',()=>held.delete(res));return}
 const text='PRIVATE_FINISHED_'+index,item={type:'message',id:'private_assistant_'+index,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}
 event({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}})
 event({type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}})
 event({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text})
 event({type:'response.output_text.done',output_index:0,item_id:item.id,content_index:0,text})
 event({type:'response.output_item.done',output_index:0,item})
 event({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:2,total_tokens:22}}});res.end()
})
await new Promise(r=>backend.listen(0,'127.0.0.1',r))
let client,created,nativePid,codexDaemon,codexDaemonClosed,output='',frames=[]
const remoteDaemon=process.env.AGENTMUX_PROBE_PRIVATE_DAEMON==='1',controlPath=join(root,'codex-home','app-server-control','app-server-control.sock')
try{
 await Promise.race([once(daemon.stdio[3],'data'),daemonClosed.then(()=>{throw new Error('Private Native startup failed: '+daemonError)})])
 const version=(await execute(process.env.AGENTMUX_REAL_CODEX_COMMAND??'codex',['--version'])).stdout.trim();assert.equal(version,'codex-cli 0.160.1');report.version=version
 report.nativeSource={repository:'openai/codex',commit:'d27764b82f7118f674371e6d6e76271d9d606edb',tag:'rust-v0.160.1',transport:'codex-rs/tui/src/lib.rs:565-610',interrupt:'codex-rs/tui/src/chatwidget/interaction.rs:192-253',refresh:{parser:'openai-oss-forks/crossterm efa177859fd9623d57b9fe7ae9bf491ae1ac6ec4 src/event/sys/unix/parse.rs:221',event:'codex-rs/tui/src/tui/event_stream.rs:294-298',draw:'codex-rs/tui/src/app.rs:880-889,1031-1032,1072-1093',semantics:'non-submitting draw refresh; normal draw timers still run'},url:'https://github.com/openai/codex/tree/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/tui/src'}
 const original=new AgentProviderRegistry().get('codex')
 // This Run loads the old hook definition. Later Core versions cannot hot-load it.
 const provider = {
   ...original,
   ...(remoteDaemon?{buildLaunch(context){const plan=original.buildLaunch(context);return {...plan,args:plan.args.filter(a=>a!=='--dangerously-bypass-hook-trust')}}}:{}),
   planManagedHooks(context) {
     const plan = original.planManagedHooks(context)
     return { ...plan, mutations: plan.mutations.map(m => {
       const config = JSON.parse(m.content)
       delete config.hooks.Interrupt
       return { ...m, content: JSON.stringify(config) + '\n' }
     }) }
   }
 }

 const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json'));client=new AgentMuxClient({store,providers:[provider]});await client.connect()
 client.onEvent(event=>{if(event.type==='terminal-output')output+=event.data??'';if(event.type==='agent-error')report.phases.push({diagnostic:event.code})})
 const args=['--no-alt-screen','-s','read-only','-a','never','-c','model_provider="steer_probe"','-c','model="steer-probe"','-c','model_providers.steer_probe.name="Private probe"','-c',`model_providers.steer_probe.base_url="http://127.0.0.1:${backend.address().port}/v1"`,'-c','model_providers.steer_probe.wire_api="responses"','-c','model_providers.steer_probe.requires_openai_auth=false','-c','model_providers.steer_probe.supports_websockets=false','-c','features.plugins=false','-c','features.plugin_hooks=false','-c','features.memories=false','-c','features.chronicle=false','-c','features.hooks=true','-c',`projects={"${join(root,'workspace')}"={trust_level="trusted"}}`]
 assert(!args.includes('--no-daemon'));assert(!args.includes('--remote'))
 if(remoteDaemon){
  await mkdir(join(root,'codex-home','app-server-control'),{mode:0o700})
  const configs=[];for(let i=0;i<args.length;i++)if(args[i]==='-c')configs.push(args[i],args[++i])
  await writeFile(join(root,'codex-home','config.toml'),configs.filter((_,i)=>i%2===1).join('\n')+'\n')
  args.splice(0,args.length,'--no-alt-screen')
  codexDaemon=spawn(process.env.AGENTMUX_REAL_CODEX_COMMAND??'codex',['app-server','--listen','unix://'+controlPath,...configs],{detached:true,stdio:['ignore','ignore','pipe'],env:{...process.env,CODEX_HOME:join(root,'codex-home')}})
  let error='';codexDaemon.stderr.on('data',b=>error+=b);codexDaemonClosed=once(codexDaemon,'close');void codexDaemonClosed.catch(()=>{})
  await until('private Codex daemon socket',async()=>{if(codexDaemon.exitCode!==null)throw new Error(error);return stat(controlPath).then(s=>s.isSocket(),()=>false)})
 }
 created=await client.createAgent({agentSessionId:'private-native-immediate',createOperationId:'private-native-create',providerId:'codex',executorId:'codex',workspacePath:join(root,'workspace'),injectAgentMuxGuide:false,commandOverride:process.env.AGENTMUX_REAL_CODEX_COMMAND??'codex',env:{CODEX_HOME:join(root,'codex-home')},args,prompt:'PRIVATE_INITIAL_BUSY',cols:120,rows:40})
 const attach=await client.reattachAgent(created.agentSessionId,0);output+=attach.attachment.replay.map(e=>e.data??'').join('')
 if(remoteDaemon){
  const reviewThrough=await client.screenEvidence.wait(client.agentSession(created.agentSessionId),0,false,screen=>screen.snapshot().lines.some(l=>l.text.includes('Hooks need review')),{timeoutMs:10_000,timeoutMessage:'private hook review',terminalMessage:'private exit',requireCompleteFrame:true})
  // The first modal paint precedes Native's protected startup input drain.
  // Bind the private live process before navigation; paint alone is not input
  // readiness. End only selects the last row; it cannot confirm an action.
  const reviewRun=(await client.statusAgent(created.agentSessionId)).run
  const {nativeProcessFiles,nativeProcessBirth}=await import('../../dist/agent-native-process.js')
  const reviewBirth=await nativeProcessBirth(reviewRun.pid,AbortSignal.timeout(4000))
  assert(reviewBirth);assert((await nativeProcessFiles(reviewRun.pid,AbortSignal.timeout(4000))).length>0)
  assert.equal((await client.statusAgent(created.agentSessionId)).run.pid,reviewRun.pid)
  await client.writeAgent({agentSessionId:created.agentSessionId,expectedRun:created.run,data:'\x1b[F',source:'user'})
  const selectedThrough=await client.screenEvidence.wait(client.agentSession(created.agentSessionId),reviewThrough,true,screen=>screen.snapshot().lines.some(l=>/^›\s*3\. Continue without trusting/u.test(l.text)),{timeoutMs:10_000,timeoutMessage:'private untrusted option selected',terminalMessage:'private exit',requireCompleteFrame:true,requireFrameAfterBoundary:true})
  assert.equal(requests.length,0,'menu navigation cannot submit the initial model request')
  await client.writeAgent({agentSessionId:created.agentSessionId,expectedRun:created.run,data:'\r',source:'user'})
  report.phases.push({phase:'private-native-hook-menu-confirmed-once',reviewThrough,selectedThrough,privateRunId:created.run.runId,pid:reviewRun.pid,selectionOnly:'End',confirmedOption:3,confirmations:1})
 }
 await until('native working + hook handle',()=>requests.length>=1&&(remoteDaemon||(client.agentSession(created.agentSessionId).nativeHandle?.kind==='provider'&&client.agentSession(created.agentSessionId).semanticStatus?.state==='working')))
 nativePid=(await client.statusAgent(created.agentSessionId)).run.pid
 const before=client.agentSession(created.agentSessionId)
 let nativeHandle=before.nativeHandle
 if(remoteDaemon){
  const visit=async(dir)=>{const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const name=join(dir,entry.name);if(entry.isDirectory())result.push(...await visit(name));else if(entry.name.endsWith('.jsonl'))result.push(name)}return result}
  const paths=await visit(join(root,'codex-home','sessions'));assert.equal(paths.length,1);const meta=JSON.parse((await readFile(paths[0],'utf8')).split('\n')[0]);nativeHandle={kind:'provider',providerId:'codex',sessionId:meta.payload.id,transcriptPath:paths[0]}
 }
 const identity={agentSessionId:before.agentSessionId,runId:before.run.runId,nativeSessionId:nativeHandle.sessionId,pid:nativePid}
 const {nativeProcessFiles,nativeProcessBirth}=await import('../../dist/agent-native-process.js')
 report.transport={runPid:nativePid,files:(await nativeProcessFiles(nativePid,AbortSignal.timeout(4000))).filter(f=>f.path===nativeHandle.transcriptPath).map(f=>({...f,device:String(f.device),inode:String(f.inode)}))}
 report.transport.rootBirth=await nativeProcessBirth(nativePid,AbortSignal.timeout(4000))
 const nativeOwner=report.transport.files.find(f=>f.access==='w'||f.access==='u')?.processId
 if(nativeOwner){report.transport.nativeBirth=await nativeProcessBirth(nativeOwner,AbortSignal.timeout(4000));report.transport.ownership='exact-writable-native-transcript'}
 if(!remoteDaemon){
  await client.resizeAgent(before.agentSessionId,before.run,110,35)
  await client.resizeAgent(before.agentSessionId,before.run,120,40)
  const checkpoint=await client.readRunReplay(before.run,0,'terminal')
  assert.equal(checkpoint.terminal.type,'basic-vt');assert(checkpoint.resizeRevision>=2)
  report.historicalResize={revision:checkpoint.resizeRevision,throughByte:checkpoint.terminal.checkpoint.throughByte,view:'terminal',originalRunId:before.run.runId,originalPid:nativePid}
 }
 const input={...agentPromptCondition(before),agentSessionId:before.agentSessionId,operationId:'private-immediate-owned',prompt:'PRIVATE_ONLY_AUTHORIZED',execution:'immediate',authorHuman:true}
 if(remoteDaemon){
  assert.equal(report.transport.files.some(f=>f.access==='w'||f.access==='u'),false,'remote TUI cannot own the embedded native writer')
  const {createCodexPromptExecutionTransportVerifier,readCodexPromptExecutionEvidence}=await import('../../dist/providers/codex-prompt-execution-evidence.js')
  const verifyCodexPromptExecutionTransport=createCodexPromptExecutionTransportVerifier()
  const context={processId:nativePid,args,workspacePath:join(root,'workspace'),nativeHandle}
  const source=await readCodexPromptExecutionEvidence(context);assert(source);context.nativeSourceId=source.sourceId
  assert.equal(await verifyCodexPromptExecutionTransport(context),false)
  const cursor=(await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes
  const refused=()=>client.submitAgentPrompt(input)
  await assert.rejects(refused(),e=>e.code==='AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
  await unlink(controlPath)
  assert.equal(codexDaemon.exitCode,null);assert.equal(requests.length,1);assert.equal(await verifyCodexPromptExecutionTransport(context),false)
  await assert.rejects(refused(),e=>e.code==='AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
  assert.equal((await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes,cursor)
  await client.submitAgentPrompt({...input,operationId:'private-ordinary-still-available',execution:'default',prompt:'PRIVATE_NATIVE_PENDING'})
  assert((await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes>cursor)
  report.nativeSource.fixtureBoundary='Native handle observed from this private daemon rollout for the direct verifier; Core hook identity stays unknown. Core rejects specific immediate and ordinary typed input remains usable.'
  assert.equal(requests.length,1);report.phases.push({phase:'default-daemon-connection-unlinked-no-local-writer',immediateRefusedBeforeAndAfterUnlink:true,ordinaryInputAvailable:true,sameRunId:before.run.runId,samePid:nativePid})
 }else{
 const submitProcess=async(fault)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./immediate-native-retry.mjs',import.meta.url)),join(root,'sessions.json'),JSON.stringify(input),...(fault?[fault]:[])],{stdio:['ignore','pipe','pipe'],env:{...process.env}})
  let error='';child.stderr.on('data',b=>{error+=b});const [code]=await once(child,'close');assert.equal(code,fault?73:0,error)
 }
 // Assert the faithful checkpoint before native redraw; refresh cannot sign
 // Runtime attribute fidelity retroactively.
 await client.screenEvidence.wait(before,0,false,screen=>{
  const row=screen.snapshot().lines[screen.snapshot().cursor.row]
  assert.equal(screen.geometryRevision,report.historicalResize.revision)
  assert(row.cells.some(cell=>cell.chars.trim()&&cell.dim),'native placeholder SGR2 survives checkpoint before refresh')
  return true
 },{timeoutMs:10_000,timeoutMessage:'private faithful checkpoint',terminalMessage:'private exit'})
 report.historicalResize.attributesVerifiedBeforeRefresh=true
 await submitProcess('--exit-after-refresh-ack')
 const refreshed=await client.refreshAgentSession(before.agentSessionId,before.run)
 assert.equal(refreshed.promptCompletionAdmission.frameRefresh.acknowledged,false)
 assert.equal(refreshed.terminalPromptSubmission,undefined);assert.equal(requests.length,1)
 report.phases.push({phase:'submitting-process-exits-after-runtime-refresh-ack',refresh:refreshed.promptCompletionAdmission.frameRefresh})
 await submitProcess('--exit-after-interrupt-ack')
 const interrupted=await client.refreshAgentSession(before.agentSessionId,before.run)
 assert.equal(interrupted.terminalPromptSubmission.prepare.interrupt.acknowledged,false)
 assert.equal(interrupted.terminalPromptSubmission.payload.acknowledged,false);assert.equal(requests.length,1)
 report.phases.push({phase:'submitting-process-exits-after-runtime-interrupt-ack',submission:interrupted.terminalPromptSubmission})
 await submitProcess()
 await client.refreshAgentSession(before.agentSessionId,before.run)
 await until('owned input begins before stalled initial model request reaches any tool/result',()=>requests.length>=2)
 const current=client.agentSession(before.agentSessionId)
 assert.equal(current.run.runId,identity.runId);assert.equal(current.nativeHandle.sessionId,identity.nativeSessionId);assert.equal((await client.statusAgent(before.agentSessionId)).run.pid,nativePid)
 assert.deepEqual(current.promptCompletionAdmission.frameRefresh,{...refreshed.promptCompletionAdmission.frameRefresh,acknowledged:true});assert.equal(current.terminalPromptSubmission.prepare.interrupt.inputByteRange.startByte,refreshed.promptCompletionAdmission.frameRefresh.inputByteRange.endByte)
 assert.equal(current.terminalPromptSubmission.prepare.context,'interruptible');assert(current.terminalPromptSubmission.prepare.interrupt.acknowledged);assert(current.terminalPromptSubmission.prepare.barrierReceiptId)
 assert.equal(current.terminalPromptSubmission.submit.acknowledged,true);assert(!JSON.stringify(requests[1]).includes('PRIVATE_NATIVE_PENDING'))
 const latestUser=requests[1].input.filter(v=>v.role==='user').at(-1);assert(JSON.stringify(latestUser).includes('PRIVATE_ONLY_AUTHORIZED'))
 report.phases.push({phase:'default-old-hooks-busy-immediate',identity,submission:current.terminalPromptSubmission,requestCount:requests.length})
 report.immediateSemantics={providerAction:'interrupt-active-turn-before-one-owned-input',sameSessionRun:true,sameNativeTurn:false,initialRequestHasNoToolBoundary:true,newModelRequestStarted:true,authorizedNewUserInput:'PRIVATE_ONLY_AUTHORIZED',unownedPendingFlushed:false}
 await until('native idle Stop',()=>client.agentSession(before.agentSessionId).hookReceipt?.eventName==='Stop')
 // A different Core process proves durable retry; it reuses the exact frozen intent.
 await submitProcess();assert.equal(requests.length,2)
 report.phases.push({phase:'separate-process-exact-retry',requests:requests.length})
 await client.submitAgentPrompt({...agentPromptCondition(client.agentSession(before.agentSessionId)),agentSessionId:before.agentSessionId,operationId:'private-idle-owned',prompt:'PRIVATE_IDLE_ONLY',execution:'immediate'})
 await until('idle immediate native model request',()=>requests.length===3)
 assert.equal(client.agentSession(before.agentSessionId).terminalPromptSubmission.prepare.context,'idle')
 assert(!client.agentSession(before.agentSessionId).terminalPromptSubmission.prepare.interrupt)
 report.phases.push({phase:'idle-no-interrupt',submission:client.agentSession(before.agentSessionId).terminalPromptSubmission})
 await until('second native idle Stop',()=>client.agentSession(before.agentSessionId).hookReceipt?.eventName==='Stop')
 await client.submitAgentPrompt({...agentPromptCondition(client.agentSession(before.agentSessionId)),agentSessionId:before.agentSessionId,operationId:'private-second-busy',prompt:'PRIVATE_SECOND_BUSY'})
 await until('separate busy model request',()=>requests.length===4&&output.includes('PRIVATE_SECOND_BUSY'))
 await client.writeAgent({agentSessionId:before.agentSessionId,expectedRun:before.run,data:'\x1b[200~PRIVATE_NATIVE_PENDING\x1b[201~',source:'user'})
 await client.screenEvidence.wait(client.agentSession(before.agentSessionId),0,false,screen=>screen.composerText('›')==='PRIVATE_NATIVE_PENDING',{timeoutMs:10_000,timeoutMessage:'private pending render',terminalMessage:'private exit',requireCompleteFrame:true})
 const draftCursor=(await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes
 await assert.rejects(client.submitAgentPrompt({...agentPromptCondition(client.agentSession(before.agentSessionId)),agentSessionId:before.agentSessionId,operationId:'private-draft-blocked',prompt:'PRIVATE_MUST_REMAIN_UNSENT',execution:'immediate'}),e=>e.code==='AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
 assert.equal((await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes,draftCursor+3);assert.equal(requests.length,4)
 await client.screenEvidence.wait(client.agentSession(before.agentSessionId),0,false,screen=>screen.composerText('›')==='PRIVATE_NATIVE_PENDING',{timeoutMs:10_000,timeoutMessage:'private unchanged draft',terminalMessage:'private exit',requireCompleteFrame:true})
 report.phases.push({phase:'native-draft-preserved',onlyAuthorizedRefreshBytes:3,requestCount:requests.length})
 await client.writeAgent({agentSessionId:before.agentSessionId,expectedRun:before.run,data:'\r',source:'user'})
 await client.screenEvidence.wait(client.agentSession(before.agentSessionId),0,false,screen=>screen.snapshot().lines.some(l=>l.text.includes('Messages to be submitted after next tool call')),{timeoutMs:10_000,timeoutMessage:'private pending preview',terminalMessage:'private exit',requireCompleteFrame:true})
 const protectedBefore=(await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes
 await assert.rejects(client.submitAgentPrompt({...agentPromptCondition(client.agentSession(before.agentSessionId)),agentSessionId:before.agentSessionId,operationId:'private-pending-blocked',prompt:'PRIVATE_MUST_REMAIN_UNSENT',execution:'immediate'}),e=>e.code==='AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')
 assert.equal((await client.statusAgent(before.agentSessionId)).run.acceptedInputBytes,protectedBefore+3);assert.equal(requests.length,4)
 assert(client.agentSession(before.agentSessionId).promptCompletionAdmission.frameRefresh.acknowledged)
 await client.screenEvidence.wait(client.agentSession(before.agentSessionId),0,false,screen=>screen.snapshot().lines.some(l=>l.text.includes('PRIVATE_NATIVE_PENDING')),{timeoutMs:10_000,timeoutMessage:'private preserved pending',terminalMessage:'private exit',requireCompleteFrame:true})
 assert.equal(client.agentSession(before.agentSessionId).run.runId,identity.runId)
 report.phases.push({phase:'native-pending-preserved',acceptedInputBytes:protectedBefore+3,onlyAuthorizedRefreshBytes:3,requestCount:requests.length})
 await writeFile(join(evidenceDirectory,'native-output.bin'),output)
 const hooks=JSON.parse(await readFile(join(root,'workspace','.codex','hooks.json'),'utf8'));assert.equal(hooks.hooks.Interrupt,undefined)
 const transcript=await readFile(client.agentSession(before.agentSessionId).nativeHandle.transcriptPath,'utf8')
 const nativeEvents=transcript.split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(v=>v.type==='event_msg'&&['task_started','turn_aborted','task_complete'].includes(v.payload?.type)).map(v=>({ordinal:v.ordinal,...v.payload}))
 assert.equal(nativeEvents.filter(e=>e.type==='turn_aborted'&&e.reason==='interrupted').length,1);report.nativeEvents=nativeEvents
 }
 report.passed=true
}catch(error){report.failure={message:error.message,code:error.code,detail:error.detail,requestCount:requests.length,requests:requests.map(v=>({model:v.model,input:v.input})),screen:created&&client?.screenEvidence.evidence.get(created.agentSessionId)&&(()=>{const e=client.screenEvidence.evidence.get(created.agentSessionId).evidence;return {frame:e.lastCompleteFrame,pending:e.pendingFrameStartByte,authoritative:e.screen.authoritative,throughByte:e.throughByte,context:new AgentProviderRegistry().get('codex').inspectPromptExecution(e.screen.snapshot()),snapshot:{...e.screen.snapshot(),lines:e.screen.snapshot().lines.map((l,i)=>({text:l.text,wrapped:l.wrapped,...(i===e.screen.snapshot().cursor.row?{cells:l.cells}: {})}))}}})(),session:created&&client?.agentSession(created.agentSessionId),outputHasBusy:output.includes('esc to interrupt')};await writeFile(join(evidenceDirectory,'native-failure-output.bin'),output);throw error}
finally{
 let cleanupFailure
 try{if(created&&client)await client.stopAgent(created.agentSessionId,created.run)}catch(e){cleanupFailure=e.message}
 try{await client?.dispose()}catch(e){cleanupFailure=e.message}
 backend.closeAllConnections();await new Promise(r=>backend.close(r))
 if(codexDaemon){
  codexDaemon.kill('SIGTERM');let timer
  await Promise.race([codexDaemonClosed,new Promise(resolve=>{timer=setTimeout(resolve,5_000)})]);clearTimeout(timer)
  if(codexDaemon.exitCode===null&&codexDaemon.signalCode===null){process.kill(-codexDaemon.pid,'SIGKILL');report.privateDaemonForcedCleanup=true}
  await codexDaemonClosed
 }
 daemon.kill('SIGTERM');await daemonClosed
 report.cleanup={privateRunStopped:!cleanupFailure,privateDaemonStopped:true,privateCodexDaemonStopped:!codexDaemon||codexDaemon.exitCode!==null||codexDaemon.signalCode!==null,...(cleanupFailure?{error:cleanupFailure}:{})}
 await mkdir(evidenceDirectory,{recursive:true});await writeFile(join(evidenceDirectory,'native-proof.json'),JSON.stringify(report,null,2)+'\n')
 if(report.passed&&!cleanupFailure)await rm(root,{recursive:true,force:true})
}

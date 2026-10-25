import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import xterm from '@xterm/headless'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../dist/hosted-client.js'
import { AgentExecutionBridge } from '../dist/agent-execution-bridge.js'
import { durableWriteFile } from '../dist/durable-write.js'
import { createExecutionProofCleanup } from './fixtures/execution-proof-cleanup.mjs'

assert.equal(process.argv.length, 2, 'This private native Agent control proof accepts no flags; physical two-Host qualification remains separate.')
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'amx-agent-relay-'))
const owners = [], diagnostics = [], errors = []
const cleanup = createExecutionProofCleanup(root)
let failed = false, primaryFailure, summary
let bridge, socket, ownerTerminal, releaseTerminalObserver, restartAgentOwner
let ownerRestartEvidence
const deadline = (promise, label, ms = 30000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]).finally(() => clearTimeout(timer))
}

const requests=[],modelSockets=new Set();
const until=async(test,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,100))}throw new Error(label+' timeout')};
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const modelEndpoint=createServer(async(req,res)=>{
 try {
  if(req.method==='GET'){res.setHeader('content-type','application/json');res.end('{"data":[]}');return}
  const chunks=[];for await(const c of req)chunks.push(c);
  const value=JSON.parse(Buffer.concat(chunks).toString());requests.push(value);
  await writeFile(join(root,'model-requests.json'),JSON.stringify(requests,null,2),{mode:0o600});
  const input=JSON.stringify(value.input),resumed=input.includes('PRIVATE_RESUMED_CONTEXT_2d19');
  const tools=(value.tools??[]).flatMap(t=>t.type==='namespace'?t.tools.map(child=>({...child,namespace:t.name})): [t]);
  let item;
  const call=(name,args,id)=>{const tool=tools.find(t=>t.name===name);assert(tool,'Native model request must declare '+name);assert.equal(tool.type,'function');return {type:'function_call',call_id:id,name,arguments:JSON.stringify(args),...(tool.namespace?{namespace:tool.namespace}:{})}};
  const workspace=join(root,'resource','workspace');
  if(!tools.length){item={type:'message',id:'title-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text:'Verify remote execution',annotations:[]}]};}else if(!resumed&&!input.includes('call_effect')){
   const code="const f=require('node:fs');f.appendFileSync('effect-count.txt','once\\n');f.writeFileSync('note.txt','initial\\n');console.log('PRIVATE_RESOURCE_EFFECT')";
   const rawCallerless = 'const n=require("node:net"),f=require("node:fs");const s=n.createConnection({path:process.env.AGENTMUX_RPC_ENDPOINT.slice(5)});let b="";s.on("connect",()=>s.write(JSON.stringify({jsonrpc:"2.0",id:"callerless",method:"whoami",params:{}})+"\\n"));s.on("data",c=>{b+=c;if(b.includes("\\n")){f.writeFileSync("tool-raw-missing.json",b);s.end();}});';
   item=call('exec_command',{cmd:quote(process.execPath)+' -e '+quote(code)+'; '+quote(process.execPath)+' -e '+quote(rawCallerless)+'; "$AGENTMUX_CLI" whoami > tool-whoami.json 2> tool-whoami.err; "$AGENTMUX_CLI" device ls > tool-device.json 2> tool-device.err; echo $? > tool-device-status; env -u AGENTMUX_AGENT_CAPABILITY "$AGENTMUX_CLI" whoami > tool-missing.json 2> tool-missing.err; echo $? > tool-missing-status',workdir:workspace,yield_time_ms:10000,max_output_tokens:1000},'call_effect');
  }else if(!resumed&&!input.includes('call_modify')){
   const tool=tools.find(t=>t.name==='apply_patch');
   const patch='*** Begin Patch\n*** Update File: '+join(workspace,'note.txt')+'\n@@\n-initial\n+modified\n*** End Patch';
   if(tool){assert.equal(tool.type,'custom');item={type:'custom_tool_call',call_id:'call_modify',name:'apply_patch',input:patch,...(tool.namespace?{namespace:tool.namespace}:{})};}else{item=call('exec_command',{cmd:"apply_patch <<'PATCH'\n"+patch+"\nPATCH",workdir:workspace,yield_time_ms:1000,max_output_tokens:1000},'call_modify');}
  }else if(resumed&&!input.includes('call_check')){
   item=call('exec_command',{cmd:'"$AGENTMUX_CLI" whoami > tool-whoami-resumed.json 2> tool-whoami-resumed.err; cat note.txt effect-count.txt',workdir:workspace,yield_time_ms:10000,max_output_tokens:1000},'call_check');
  }else if(resumed&&!input.includes('call_after_owner_restart')){
   await restartAgentOwner();
   item=call('exec_command',{cmd:'"$AGENTMUX_CLI" whoami > tool-after-owner-restart.json 2> tool-after-owner-restart.err; echo $? > tool-after-owner-restart-status; printf native-retained > tool-after-owner-restart-native',workdir:workspace,yield_time_ms:10000,max_output_tokens:1000},'call_after_owner_restart');
  }else{item={type:'message',id:'answer-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text:resumed?'PRIVATE_RESUMED_COMPLETE':'PRIVATE_ORIGINAL_COMPLETE',annotations:[]}]}}
  const id='response-'+requests.length;res.writeHead(200,{'content-type':'text/event-stream'});const event=v=>res.write('data: '+JSON.stringify(v)+'\n\n');
  event({type:'response.created',response:{id,status:'in_progress',output:[]}});
  if(item.type==='message'){
   event({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
   event({type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   event({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:item.content[0].text});
   event({type:'response.output_text.done',output_index:0,item_id:item.id,content_index:0,text:item.content[0].text});
  }
  event({type:'response.output_item.done',output_index:0,item});
  event({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}});res.end();
 }catch(error){diagnostics.push({modelError:String(error)});res.writeHead(500);res.end('Controlled fixture rejected undeclared tool');}
});
modelEndpoint.on('connection',socket=>{modelSockets.add(socket);socket.once('close',()=>modelSockets.delete(socket))});
await new Promise(resolve=>modelEndpoint.listen(0,'127.0.0.1',resolve));const modelPort=modelEndpoint.address().port;
async function startOwner(name) {
  const base = join(root, name)
  for (const dir of ['home', 'codex', 'runtime', 'state', 'workspace']) await mkdir(join(base, dir), { recursive: true, mode: 0o700 })
  const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
  Object.assign(env, { HOME: join(base, 'home'), CODEX_HOME: join(base, 'codex'), AGENTMUX_RUNTIME_DIRECTORY: join(base, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(base, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(base, 'state', 'sessions.json') })
  await writeFile(join(base, 'codex', 'config.toml'), ('cli_auth_credentials_store = "file"\nmodel = "gpt-5.4"\nmodel_provider = "offline"\n[model_providers.offline]\nname = "Offline native transport proof"\nbase_url = "http://127.0.0.1:MODEL_PORT/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n').replace('MODEL_PORT', String(modelPort)) + `\n[projects.${JSON.stringify(join(root, 'resource', 'workspace'))}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
  const native = spawn(join(packageRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(base, 'runtime', 'ctxmux.sock'), '--state-dir', join(base, 'state', 'ctxmux'), '--readiness-fd', '3'],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const owner = { name, base, env, native, runs: [], sessions: [] }; owners.push(owner)
  cleanup.trackChild(owner, 'native', native)
  native.stderr.on('data', bytes => diagnostics.push({ owner: name, lane: 'native', bytes: bytes.toString() }))
  await deadline(Promise.race([once(native.stdio[3], 'data'), once(native, 'exit').then(() => { throw new Error('Test-owned Native exited before readiness') })]), 'Native readiness')
  const core = owner.core = spawn(process.execPath, [join(packageRoot, 'dist/headless-runtime-cli.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'core', core)
  core.stderr.on('data', bytes => diagnostics.push({ owner: name, lane: 'core', bytes: bytes.toString() }))
  const line = await deadline(new Promise((resolve, reject) => {
    let text = ''
    core.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n'))) })
    core.once('exit', () => reject(new Error('Test-owned Core exited before readiness')))
  }), 'Core readiness')
  const receipt = JSON.parse(line)
  owner.rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receipt.socketPath } })
  owner.client = await connectHostedAgentMux({ rpc: owner.rpc })
  await owner.client.connectRuntime()
  return owner
}
try {
  const started = await Promise.allSettled([startOwner('agent'), startOwner('resource')])
  const failure = started.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  const [agent, resource] = started.map(result => result.value)
  restartAgentOwner = async () => {
    const previous = agent.client.runtimeOwnerIdentity(), native = agent.client.runtimeIdentity();
    await bridge.close(); bridge = undefined;
    releaseTerminalObserver?.(); releaseTerminalObserver = undefined;
    await agent.client.dispose(); await agent.rpc.dispose();
    const exited = once(agent.core, 'exit'); agent.core.kill('SIGTERM'); await deadline(exited, 'original private Core exit');
    const core = agent.core = spawn(process.execPath, [join(packageRoot, 'dist/headless-runtime-cli.js'), 'serve'], { env: agent.env, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanup.trackChild(agent, 'core', core);
    core.stderr.on('data', bytes => diagnostics.push({ owner: 'agent-restarted', lane: 'core', bytes: bytes.toString() }));
    const line = await deadline(new Promise((resolve,reject)=>{let text='';core.stdout.on('data', bytes=>{text+=bytes;if(text.includes('\n'))resolve(text.slice(0,text.indexOf('\n')))});core.once('exit',()=>reject(new Error('replacement private Core not ready')))}),'same semantic owner restart');
    agent.rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:JSON.parse(line).socketPath}});
    agent.client = await connectHostedAgentMux({rpc:agent.rpc}); await agent.client.connectRuntime();
    const current = agent.client.runtimeOwnerIdentity();
    assert.equal(current.runtimeId, previous.runtimeId); assert.notEqual(current.ownerInstanceId, previous.ownerInstanceId);
    assert.equal(agent.client.runtimeIdentity().instanceId,native.instanceId);
    bridge=await openBridge();
    const retained=await agent.client.readAgentSession(agentSessionId);
    assert.equal(retained.run.runId,agent.sessions[0].run.runId);assert.deepEqual(retained.toolExecution,toolExecution);
    releaseTerminalObserver=agent.client.onEvent(event=>{if(event.type==='terminal-output'&&event.run.runId===retained.run.runId)ownerTerminal.write(event.dataBytes)},{observeMessages:false});
    ownerRestartEvidence={previousOwner:previous.ownerInstanceId,currentOwner:current.ownerInstanceId,runId:retained.run.runId,nativeInstanceId:native.instanceId};
  };
  const bindingId = randomUUID(), agentSessionId = randomUUID()
  const make = async (owner, role) => {
    const preparation = await owner.client.prepareAgentExecutionHelper({ bindingId, agentSessionId, role, providerId: 'codex',
      workspacePath: join(owner.base, 'workspace'), createOperationId: randomUUID(),
      ...(role === 'frontend' ? { toolExecution: { bindingId, resourceHostId: 'resource', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, workspacePath: join(resource.base, 'workspace') } } : {}),
      ...(role === 'executor' ? { grant: { scope: 'host-user', bindingId } } : {}) })
    const run = await owner.client.createPreparedTerminal(preparation.prepared)
    owner.runs.push(run.runId)
    return { runId: run.runId, ownerInstanceId: owner.client.runtimeIdentity().instanceId, inputByte: 0, outputByte: 0 }
  }
  const [frontend, executor] = await Promise.all([make(agent, 'frontend'), make(resource, 'executor')])
  let state = { bindingId, frontend, executor }
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  const openBridge = async () => {
    const next = new AgentExecutionBridge({ state, ports: { frontend: agent.client, executor: resource.client },
      persist: async value => { await durableWriteFile(join(root, 'bridge.json'), JSON.stringify(value), { mode: 0o600 }); state = value },
      onFrame: async (side, frame) => { if (side === 'frontend' && frame.type === 'ready') readyResolve(frame.url); else diagnostics.push({ side, frame }) },
      onError: error => errors.push(error.message) })
    await next.start(); return next
  }
  bridge = await openBridge()
  const url = await deadline(ready, 'Frontend ready')
  const configured = await agent.client.configureHostExecutor({ executorId: 'native-tool-proof', config: {
    label: 'Native tool execution proof', providerId: 'codex', command: 'codex', args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'], env: {}, injectAgentMuxGuide: false,
  } })
  const toolExecution = { bindingId, resourceHostId: 'resource', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, workspacePath: join(resource.base, 'workspace') }
  const creation = { agentSessionId, createOperationId: randomUUID(), executorId: configured.executor.executorId,
    executorRevision: configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), toolExecution, prompt: 'PRIVATE_ORIGINAL_CONTEXT_7e41: perform the controlled fixture tool operations.' }
  const created = await agent.client.createHostAgentWithDelivery(creation)
  agent.sessions.push(created.session)
  const terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  ownerTerminal = terminal
  terminal.onData(data => { void agent.client.writeAgent({ agentSessionId, expectedRun: created.session.run, data, source: 'terminal-protocol' }).catch(error => errors.push(error.message)) })
  const releaseTerminal = agent.client.onEvent(event => {
    if (event.type === 'terminal-output' && event.run.runId === created.session.run.runId) terminal.write(event.dataBytes)
  }, { observeMessages: false })
  releaseTerminalObserver = releaseTerminal
  const attachment = await agent.client.reattachAgent(agentSessionId, 0, 'raw')
  for (const chunk of attachment.attachment.replay) terminal.write(chunk.dataBytes)
  await until(async () => requests.some(r => JSON.stringify(r.input).includes('call_modify')) && await readFile(join(resource.base,'workspace','note.txt'),'utf8').catch(()=>null) === 'modified\n', 'initial native tools');
  await until(async () => requests.length >= 3, 'initial final request');
  const rollouts = async directory => (await Promise.all((await readdir(directory,{withFileTypes:true})).map(async entry => entry.isDirectory() ? rollouts(join(directory,entry.name)) : entry.name.endsWith('.jsonl') ? [join(directory,entry.name)] : []))).flat();
  let originalPath, originalId;
  await until(async () => {
    for(const path of await rollouts(join(agent.base,'codex','sessions')).catch(()=>[])) {
      const lines = (await readFile(path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      const meta = lines.find(line=>line.type==='session_meta');
      if(meta && JSON.stringify(lines).includes('PRIVATE_ORIGINAL_COMPLETE')) { originalPath=path; originalId=meta.payload.id; return true; }
    }
    return false;
  }, 'real native rollout');
  await until(async()=>{try{return (await readFile(join(resource.base,'workspace','tool-missing-status'),'utf8')).trim().length>0}catch{return false}},'original native amux calls');
  const firstWhoamiText = await readFile(join(resource.base,'workspace','tool-whoami.json'),'utf8');
  const rawCallerless = JSON.parse(await readFile(join(resource.base,'workspace','tool-raw-missing.json'),'utf8'));
  assert.equal(rawCallerless.error.data.code,'AGENT_CAPABILITY_INVALID');
  const firstWhoami = JSON.parse(firstWhoamiText);
  assert.equal(firstWhoami.ok,true); assert.equal(firstWhoami.result.session.agentSessionId,agentSessionId);
  assert.deepEqual(firstWhoami.result.session.run,created.session.run); assert.deepEqual(firstWhoami.result.session.toolExecution,toolExecution);
  assert.equal(firstWhoami.result.session.workspacePath,join(agent.base,'workspace'));
  assert.equal(Number((await readFile(join(resource.base,'workspace','tool-device-status'),'utf8')).trim()) === 0, false, 'managed tool caller must not gain device authority');
  assert.equal(Number((await readFile(join(resource.base,'workspace','tool-missing-status'),'utf8')).trim()) === 0, false, 'missing caller must not become user');
  const firstTranscript = await readFile(originalPath,'utf8');
  assert(firstTranscript.includes('PRIVATE_ORIGINAL_CONTEXT_7e41'));
  const coreObservations=[];
  let current;
  for(let attempt=0;attempt<12;attempt++){
    const observed={read:await agent.client.readAgentSession(agentSessionId),status:await agent.client.statusAgent(agentSessionId),refresh:await agent.client.refreshAgentSession(agentSessionId,created.session.run)};
    coreObservations.push(observed);current=observed.refresh;
    await writeFile(join(root,'core-identity-observations.json'),JSON.stringify(coreObservations,null,2),{mode:0o600});
    if(current.nativeHandle?.kind==='provider'&&current.nativeHandle.sessionId===originalId)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(current.nativeHandle?.sessionId,originalId,'Core native identity capture must confirm actual rollout before native resume');
  assert.deepEqual(current.toolExecution,toolExecution);
  await agent.client.writeAgent({agentSessionId,expectedRun:created.session.run,data:'\x04',source:'user'});
  await until(async()=>{ const status=await agent.client.statusAgent(agentSessionId);return status.run.state==='exited';},'original CLI natural exit');
  releaseTerminalObserver();releaseTerminalObserver=undefined;ownerTerminal.dispose();ownerTerminal=undefined;
  const resumedSession=await agent.client.resumeAgent({agentSessionId,operationId:randomUUID(),prompt:'PRIVATE_RESUMED_CONTEXT_2d19: check original context and resource contents.'});
  assert.equal(resumedSession.agentSessionId,agentSessionId);
  assert.equal(resumedSession.nativeHandle?.sessionId,originalId);
  assert.deepEqual(resumedSession.toolExecution,toolExecution);
  agent.sessions=[resumedSession];const restored={runId:resumedSession.run.runId};
  const resumedTerminal=ownerTerminal=new xterm.Terminal({cols:120,rows:40,allowProposedApi:true});
  resumedTerminal.onData(data=>{void agent.client.writeAgent({agentSessionId,expectedRun:resumedSession.run,data,source:'terminal-protocol'}).catch(error=>errors.push(error.message));});
  releaseTerminalObserver=agent.client.onEvent(event=>{if(event.type==='terminal-output'&&event.run.runId===restored.runId)resumedTerminal.write(event.dataBytes);},{observeMessages:false});
  const attached=await agent.client.reattachAgent(agentSessionId,0,'raw');for(const chunk of attached.attachment.replay)resumedTerminal.write(chunk.dataBytes);
  await until(async()=>requests.some(r=>JSON.stringify(r.input).includes('call_check')), 'resumed native tool output');
  const resumedRequest=requests.find(r=>JSON.stringify(r.input).includes('PRIVATE_RESUMED_CONTEXT_2d19'));
  assert(resumedRequest && JSON.stringify(resumedRequest.input).includes('PRIVATE_ORIGINAL_CONTEXT_7e41'));
  assert(JSON.stringify(resumedRequest.input).includes('PRIVATE_ORIGINAL_COMPLETE'));
  assert(JSON.stringify(resumedRequest.input).includes('call_modify'));
  await until(async()=>(await readFile(originalPath,'utf8')).includes('PRIVATE_RESUMED_COMPLETE'),'resumed same rollout');
  await until(async()=>{try{return (await readFile(join(resource.base,'workspace','tool-whoami-resumed.json'),'utf8')).trim().length>0}catch{return false}},'resumed native amux identity');
  const resumedWhoami=JSON.parse(await readFile(join(resource.base,'workspace','tool-whoami-resumed.json'),'utf8'));
  assert.equal(resumedWhoami.ok,true);assert.equal(resumedWhoami.result.session.agentSessionId,agentSessionId);
  assert.equal(resumedWhoami.result.session.run.runId,restored.runId);assert.deepEqual(resumedWhoami.result.session.toolExecution,toolExecution);
  assert.equal((await readFile(join(resource.base,'workspace','tool-after-owner-restart-status'),'utf8')).trim(),'1');
  assert((await readFile(join(resource.base,'workspace','tool-after-owner-restart.err'),'utf8')).includes('AGENT_TOOL_CONTEXT_UNAVAILABLE'));
  assert.equal(await readFile(join(resource.base,'workspace','tool-after-owner-restart-native'),'utf8'),'native-retained');
  assert(ownerRestartEvidence);
  assert.equal(await readFile(join(resource.base,'workspace','effect-count.txt'),'utf8'),'once\n');
  assert.equal(await readFile(join(resource.base,'workspace','note.txt'),'utf8'),'modified\n');
  await assert.rejects(readFile(join(agent.base,'workspace','note.txt')),{code:'ENOENT'});
  const nativeReplay=await agent.client.readRunReplay({runId:frontend.runId},0,'raw');
  const frames=Buffer.concat(nativeReplay.replay.map(c=>Buffer.from(c.dataBytes))).toString().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  const qualifications=frames.filter(frame=>frame.type==='agent-control-state');
  assert.deepEqual(qualifications.map(frame=>frame.state),['unverified','available','unverified','available','unavailable']);
  assert.equal(qualifications[0].generation,qualifications[1].generation);
  assert.equal(qualifications[2].generation,qualifications[3].generation);
  assert.equal(qualifications[3].generation,qualifications[4].generation);
  assert.notEqual(qualifications[1].generation,qualifications[2].generation);
  const starts=frames.filter(f=>f.payload?.method==='process/start');
  assert.equal(starts.filter(f=>f.payload.params.metadata?.toolCallId==='call_effect').length,1);
  assert.equal(starts.filter(f=>f.payload.params.metadata?.toolCallId==='call_check').length,1);
  assert(starts.every(f=>f.payload.params.metadata.threadId===originalId));
  assert.equal(new Set(starts.map(f=>f.generation)).size,2);
  assert.equal(frames.filter(f=>f.payload?.method==='fs/writeFile'&&f.payload.params.path===pathToFileURL(join(resource.base,'workspace','note.txt')).href).length,1);
  await writeFile(join(root,'native-frames.json'),JSON.stringify(frames,null,2),{mode:0o600});
  await writeFile(join(root,'diagnostics.json'),JSON.stringify(diagnostics,null,2),{mode:0o600});
  assert.deepEqual(errors, [], 'The real execution bridge must have no unconfirmed operations');
  summary = {passed:true,actualMachines:1,controlledOfflineModel:true,ownerRestartEvidence,agentControl:{originalWhoami:firstWhoami.result.session.agentSessionId,resumedWhoami:resumedWhoami.result.session.agentSessionId,callerlessRejected:true,userOnlyRejected:true,ownerChangedRouteUnavailable:true,nativeToolsRetained:true,qualifications},nativeConversationId:originalId,originalPath,originalCoreSession:agentSessionId,firstRun:created.session.run,resumedRun:restored.runId,helperRuns:[frontend.runId,executor.runId],toolWorkspace:join(resource.base,'workspace'),launchWorkspace:join(agent.base,'workspace'),originalContextRetained:true,originalEffectCount:1,nativeInitializations:frames.filter(f=>f.payload?.method==='initialize').map(f=>({generation:f.generation,params:f.payload.params})),errors,scope:'Native remote tools call original Agent control through retained helpers; original conversation resume and Core-owner restart'};
} catch (error) {
  failed = true; primaryFailure = error; errors.push(String(error));
  for (const owner of owners) for (const session of owner.sessions) {
    const replay = await owner.client.readRunReplay(session.run, 0, 'raw').catch(() => null)
    if (replay) await writeFile(join(root, `agent-${session.agentSessionId}.raw`), Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))), { mode: 0o600 })
  }
  await writeFile(join(root, 'diagnostics.json'), JSON.stringify({ diagnostics, error: String(error) }, null, 2), { mode: 0o600 })
  console.error(`Native helper proof failed. Private evidence: ${root}`)
} finally {
  await cleanup.step({ action: 'close-model-endpoint' }, async () => {
    for (const connection of modelSockets) connection.destroy()
    await new Promise(resolve => modelEndpoint.close(resolve))
  })
  await cleanup.step({ action: 'dispose-terminal-observer' }, () => { releaseTerminalObserver?.(); ownerTerminal?.dispose() })
  await cleanup.step({ action: 'close-native-observer' }, () => socket?.close())
  await cleanup.step({ action: 'close-execution-bridge' }, () => bridge?.close())
  try { await cleanup.finish(owners, { failed, error: primaryFailure }) }
  catch (error) {
    const cleanupErrors = cleanup.report.errors.map(value => value.error?.message ?? String(value))
    errors.push(...cleanupErrors)
    await writeFile(join(root, 'summary.json'), JSON.stringify({ ...summary, passed: false, root, errors, cleanup: join(root, 'cleanup.json') }, null, 2) + '\n', { mode: 0o600 })
    throw error
  }
}
await writeFile(join(root, 'summary.json'), JSON.stringify({ ...summary, cleanup: join(root, 'cleanup.json') }, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ passed: true, root, summary: join(root, 'summary.json'), cleanup: join(root, 'cleanup.json'), nativeConversationId: summary.nativeConversationId, modelRequests: requests.length, errors }))

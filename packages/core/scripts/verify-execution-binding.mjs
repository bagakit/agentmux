import { createExecutionProofCleanup } from './fixtures/execution-proof-cleanup.mjs'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { DatabaseSync } from 'node:sqlite'
import xterm from '@xterm/headless'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../dist/hosted-client.js'

// Single machine, controlled Responses model; real CLI, Core and native tool processes.
// This is not the real two-machine/bidirectional Feature acceptance gate.
const observation = process.argv.length === 3 && process.argv[2] === '--observation'
assert(process.argv.length === 2 || observation, 'This bounded public binding proof accepts only --observation.')
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
// macOS Unix socket paths need a short temporary root; no user paths or credentials are reused.
const root = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'amx-binding-')))
const owners = [], diagnostics = []
const observationEvidence = {}
const confirmedEndedHelpers = new Set()
const sourcePaths = ['src/agent-execution-bridge.ts', 'src/agent-execution-coordinator.ts', 'src/agent-execution-executor.ts', 'src/public-rpc-agent-execution.ts', 'src/providers/codex-execution-run.ts']
const fingerprint = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(join(packageRoot, path))).digest('hex')])))
const driver = { path: fileURLToPath(import.meta.url), sha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') }
const sourceHashes = await fingerprint(sourcePaths), compiledHashes = await fingerprint(sourcePaths.map(path => path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js')))
await writeFile(join(root, 'observation-inputs.json'), JSON.stringify({ sourceHashes, compiledHashes, driver, observation }, null, 2))
const cleanup = createExecutionProofCleanup(root)
let success, primaryFailure, failed = false
let ownerTerminal, releaseTerminalObserver, bindingId
const cliReceipts = []
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
   item=call('exec_command',{cmd:quote(process.execPath)+' -e '+quote(code),workdir:workspace,yield_time_ms:1000,max_output_tokens:1000},'call_effect');
  }else if(!resumed&&!input.includes('call_modify')){
   const tool=tools.find(t=>t.name==='apply_patch');
   const patch='*** Begin Patch\n*** Update File: '+join(workspace,'note.txt')+'\n@@\n-initial\n+modified\n*** End Patch';
   if(tool){assert.equal(tool.type,'custom');item={type:'custom_tool_call',call_id:'call_modify',name:'apply_patch',input:patch,...(tool.namespace?{namespace:tool.namespace}:{})};}else{item=call('exec_command',{cmd:"apply_patch <<'PATCH'\n"+patch+"\nPATCH",workdir:workspace,yield_time_ms:1000,max_output_tokens:1000},'call_modify');}
  }else if(resumed&&!input.includes('call_check')){
   item=call('exec_command',{cmd:"cat note.txt effect-count.txt",workdir:workspace,yield_time_ms:1000,max_output_tokens:1000},'call_check');
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
async function startOwner(name, agentOwner) {
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
  return await startCore(owner, agentOwner)
}
async function startCore(owner, agentOwner) {
  const { name, env } = owner
  const runner = `
    import { startHeadlessAgentMux } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/headless-runtime.js')).href)};
    import { connectAgentMuxRpc } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/public-rpc-client.js')).href)};
    import { connectHostedAgentMux } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/hosted-client.js')).href)};
    const rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:process.argv[1]}});
    const agent = await connectHostedAgentMux({rpc}); await agent.connectRuntime();
    const owner = await startHeadlessAgentMux({coreClients:()=>[{hostId:'agent',client:agent}]});
    process.stdout.write(JSON.stringify({operation:'serve',owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\\n');
    const stop=()=>{void owner.stop().then(async()=>{await agent.dispose();await rpc.dispose();process.exit(0)},error=>{process.stderr.write(String(error));process.exit(1)})};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  `
  const coreArgs = agentOwner ? ['--input-type=module', '-e', runner, agentOwner.socketPath]
    : [join(packageRoot, 'dist/headless-runtime-cli.js'), 'serve']
  const core = owner.core = spawn(process.execPath, coreArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'core', core)
  core.stderr.on('data', bytes => diagnostics.push({ owner: name, lane: 'core', bytes: bytes.toString() }))
  const line = await deadline(new Promise((resolve, reject) => {
    let text = ''
    core.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n'))) })
    core.once('exit', () => reject(new Error('Test-owned Core exited before readiness')))
  }), 'Core readiness')
  const receipt = JSON.parse(line)
  owner.socketPath = receipt.socketPath
  owner.rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receipt.socketPath } })
  owner.client = await connectHostedAgentMux({ rpc: owner.rpc })
  await owner.client.connectRuntime()
  return owner
}
async function cli(owner, args) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', `unix:${owner.socketPath}`, ...args],
    { env: owner.env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'cli', child)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  try {
    const [code] = await deadline(once(child, 'close'), 'Compiled CLI response', 60000)
    let packet
    if (stdout.trim()) packet = JSON.parse(stdout)
    else {
      // The public CLI writes its machine failure envelope to stderr. Node's
      // separate warnings are not business receipts and confer no authority.
      const failures = stderr.split('\n').flatMap(line => {
        try { const value = JSON.parse(line); return value?.ok === false && value.operation === args.slice(0, 3).join('.') &&
          typeof value.error?.code === 'string' ? [value] : [] } catch { return [] }
      })
      assert.equal(failures.length, 1, 'Compiled CLI must return one exact machine failure envelope')
      packet = failures[0]
    }
    const receipt = { args, code, packet, stderr }
    cliReceipts.push(receipt)
    await writeFile(join(root, 'cli-receipts.json'), JSON.stringify(cliReceipts, null, 2), { mode: 0o600 })
    return receipt
  } finally {
    if (child.exitCode === null && child.signalCode === null) await cleanup.step({ owner: owner.name, ownerRoot: owner.base, action: 'signal-cli', childPid: child.pid }, () => {
      if (!child.kill('SIGTERM')) throw new Error('The exact CLI child exit is unconfirmed')
    })
  }
}
function readPair(resource, id) {
  const db = new DatabaseSync(join(resource.base, 'state/execution-bindings/bindings.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT binding_intents.input,bindings.record FROM bindings JOIN binding_intents USING(id) WHERE id=?').get(id)
    assert(row, 'The public creation must persist its original pair')
    const record = JSON.parse(row.record)
    return { input: JSON.parse(row.input), ...record }
  } finally { db.close() }
}
async function privateFrames(owner, runId) {
  const replay = await owner.client.readRunReplay({ runId }, 0, 'raw')
  assert.equal(replay.gap, null, 'The bounded proof requires original machine protocol Replay')
  assert.equal(replay.run.runId, runId)
  const text = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
  // A live final partial frame is not yet a machine receipt.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
}
try {
  const agent = await startOwner('agent')
  const resource = await startOwner('resource', agent)
  bindingId = randomUUID()
  const agentSessionId = randomUUID()
  const configured = await agent.client.configureHostExecutor({ executorId: 'native-tool-proof', config: {
    label: 'Native tool execution proof', providerId: 'codex', command: 'codex', args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'], env: {}, injectAgentMuxGuide: false,
  } })
  const toolExecution = { bindingId, resourceHostId: 'local', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, workspacePath: join(resource.base, 'workspace') }
  const creation = { agentSessionId, createOperationId: randomUUID(), executorId: configured.executor.executorId,
    executorRevision: configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), prompt: 'PRIVATE_ORIGINAL_CONTEXT_7e41: perform the controlled fixture tool operations.' }
  const createBinding = { bindingId, agentHostId: 'agent', agentRuntimeId: agent.client.runtimeOwnerIdentity().runtimeId,
    resourceHostId: 'local', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, resourceWorkspacePath: join(resource.base, 'workspace'),
    resourceGrant: { scope: 'host-user', bindingId }, agent: creation }
  const inputPath = join(root, 'create-binding.json'), bindingPath = join(root, 'binding.json')
  await writeFile(inputPath, JSON.stringify(createBinding), { mode: 0o600 })
  await writeFile(bindingPath, JSON.stringify({ bindingId }), { mode: 0o600 })
  const errors = []
  let createReply = await cli(resource, ['agent', 'execution', 'create', '--input', inputPath])
  if (createReply.code !== 0) {
    assert.equal(createReply.packet.error?.code, 'EXECUTION_HELPER_UNAVAILABLE', 'Only the precise original helper readiness gap permits this bounded same-intent retry')
    assert.equal(createReply.packet.error.controlFailure?.disposition, 'not_applied', 'An unknown Agent creation cannot enter the readiness retry path')
    const pendingPair = readPair(resource, bindingId)
    assert(pendingPair.frontend && pendingPair.executor)
    assert.equal(await agent.client.readAgentSession(agentSessionId), null, 'No Agent has been created before the helper endpoint is ready')
    await until(async () => (await privateFrames(agent, pendingPair.frontend.runId)).some(frame => frame.type === 'ready' && typeof frame.url === 'string'), 'Original frontend readiness receipt')
    // Explicit same-intent continuation after the authoritative original ready frame;
    // exactly one retry, retaining the original binding, Session and creation ID.
    createReply = await cli(resource, ['agent', 'execution', 'create', '--input', inputPath])
  }
  assert.equal(createReply.code, 0, JSON.stringify(createReply.packet))
  const created = createReply.packet.result
  assert.equal(created.session.agentSessionId, agentSessionId)
  assert.deepEqual(created.session.toolExecution, toolExecution)
  const originalPair = readPair(resource, bindingId)
  assert.deepEqual(originalPair.input, createBinding)
  const { frontend, executor } = originalPair.bridge
  agent.runs.push(frontend.runId); resource.runs.push(executor.runId)
  const observed = await cli(resource, ['agent', 'execution', 'binding', '--input', bindingPath])
  assert.equal(observed.code, 0); assert.equal(observed.packet.result.bindingId, bindingId)
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
  if (observation) {
    const ready = (await privateFrames(agent, frontend.runId)).find(frame => frame.type === 'ready' && typeof frame.url === 'string')
    assert(ready, 'The exact original frontend publishes its private loopback capability')
    const socket = new WebSocket(ready.url)
    try {
      await deadline(once(socket, 'open'), 'Original native frontend local connection')
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'privateUnsupportedNotification', params: {} }))
      await until(async () => {
        const value = await resource.rpc.call('agent.execution.binding', { bindingId })
        if (!value?.diagnostics?.some(issue => issue.scope === 'request' && issue.code === 'INVALID_NATIVE_MESSAGE')) return false
        assert.equal(value.state, 'connected', 'One native rejection cannot take down the original helper connection')
        observationEvidence.localRejection = value
        return true
      }, 'Public scoped native rejection')
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.close(); await deadline(closed, 'Private diagnostic probe socket close') }
    }
  }
  const rejoined = await cli(resource, ['agent', 'execution', 'rejoin', '--input', bindingPath])
  assert.equal(rejoined.code, 0, JSON.stringify(rejoined.packet))
  assert.equal(rejoined.packet.result.bindingId, bindingId)
  const joinedPair = readPair(resource, bindingId)
  for (const side of ['frontend', 'executor']) {
    assert.equal(joinedPair.bridge[side].runId, originalPair.bridge[side].runId)
    assert.equal(joinedPair.bridge[side].ownerInstanceId, originalPair.bridge[side].ownerInstanceId)
    assert(joinedPair.bridge[side].outputByte >= originalPair.bridge[side].outputByte)
  }
  // Replace only the resource semantic Core process. Its ctxmux owner and both
  // original helper Runs must survive; startup must restore readers without rejoin.
  const identityPath = join(resource.base, 'state', 'semantic-runtime.json')
  const originalIdentityBytes = await readFile(identityPath)
  const beforeRestart = {
    core: resource.client.runtimeOwnerIdentity(), ctxmux: resource.client.runtimeIdentity(),
    agentCore: agent.client.runtimeOwnerIdentity(), daemonPid: resource.native.pid,
    frontend: (await agent.client.readRunReplay({ runId: frontend.runId }, 0, 'raw')).run,
    executor: (await resource.client.readRunReplay({ runId: executor.runId }, 0, 'raw')).run,
  }
  assert.equal(beforeRestart.frontend.state, 'running'); assert.equal(beforeRestart.executor.state, 'running')
  await resource.client.dispose(); await resource.rpc.dispose()
  const originalCore = resource.core, exited = once(originalCore, 'exit')
  originalCore.kill('SIGTERM')
  const [exitCode, exitSignal] = await deadline(exited, 'Original resource Core graceful exit', 10000)
  assert.equal(exitCode, 0); assert.equal(exitSignal, null)
  assert.equal(resource.native.exitCode, null); assert.equal(resource.native.signalCode, null)
  await startCore(resource, agent)
  assert.notEqual(resource.core.pid, originalCore.pid)
  assert.equal(resource.client.runtimeOwnerIdentity().runtimeId, beforeRestart.core.runtimeId)
  assert.notEqual(resource.client.runtimeOwnerIdentity().ownerInstanceId, beforeRestart.core.ownerInstanceId)
  assert.equal(resource.client.runtimeIdentity().instanceId, beforeRestart.ctxmux.instanceId)
  assert.equal(resource.native.pid, beforeRestart.daemonPid)
  assert.deepEqual(agent.client.runtimeOwnerIdentity(), beforeRestart.agentCore)
  assert.deepEqual(await readFile(identityPath), originalIdentityBytes)
  let afterRestartInspection
  await until(async () => {
    afterRestartInspection = await resource.rpc.call('agent.execution.binding', { bindingId })
    return afterRestartInspection?.state === 'connected'
  }, 'Automatic original BindingService reader restore')
  if (observation) { assert.deepEqual(afterRestartInspection.diagnostics, observationEvidence.localRejection.diagnostics); observationEvidence.afterCoreRestart = afterRestartInspection }
  const afterRestart = {
    core: resource.client.runtimeOwnerIdentity(), ctxmux: resource.client.runtimeIdentity(), inspection: afterRestartInspection,
    frontend: (await agent.client.readRunReplay({ runId: frontend.runId }, 0, 'raw')).run,
    executor: (await resource.client.readRunReplay({ runId: executor.runId }, 0, 'raw')).run,
  }
  for (const side of ['frontend', 'executor']) {
    assert.equal(afterRestart[side].runId, beforeRestart[side].runId)
    assert.equal(afterRestart[side].pid, beforeRestart[side].pid)
    assert.equal(afterRestart[side].state, 'running')
  }
  const restoredPair = readPair(resource, bindingId)
  assert.deepEqual(restoredPair.input, createBinding)
  for (const side of ['frontend', 'executor']) {
    assert.equal(restoredPair.bridge[side].runId, originalPair.bridge[side].runId)
    assert.equal(restoredPair.bridge[side].ownerInstanceId, originalPair.bridge[side].ownerInstanceId)
  }
  const afterRestartCli = await cli(resource, ['agent', 'execution', 'binding', '--input', bindingPath])
  assert.equal(afterRestartCli.code, 0, JSON.stringify(afterRestartCli.packet))
  assert.equal(afterRestartCli.packet.result.state, 'connected', JSON.stringify(afterRestartCli.packet.result.diagnostic))
  await writeFile(join(root, 'resource-core-restart.json'), JSON.stringify({ before: beforeRestart, after: afterRestart,
    originalCorePid: originalCore.pid, replacementCorePid: resource.core.pid, exitCode, exitSignal, automaticReadersRestored: true }, null, 2), { mode: 0o600 })
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
  assert.equal(await readFile(join(resource.base,'workspace','effect-count.txt'),'utf8'),'once\n');
  assert.equal(await readFile(join(resource.base,'workspace','note.txt'),'utf8'),'modified\n');
  await assert.rejects(readFile(join(agent.base,'workspace','note.txt')),{code:'ENOENT'});
  const frames = await privateFrames(agent, frontend.runId);
  const starts=frames.filter(f=>f.payload?.method==='process/start');
  assert.equal(starts.filter(f=>f.payload.params.metadata?.toolCallId==='call_effect').length,1);
  assert.equal(starts.filter(f=>f.payload.params.metadata?.toolCallId==='call_check').length,1);
  assert(starts.every(f=>f.payload.params.metadata.threadId===originalId));
  assert.equal(new Set(starts.map(f=>f.generation)).size,2);
  assert.equal(frames.filter(f=>f.payload?.method==='fs/writeFile'&&f.payload.params.path===pathToFileURL(join(resource.base,'workspace','note.txt')).href).length,1);
  const originalOperation = starts.find(frame => frame.payload.params.metadata?.toolCallId === 'call_effect')
  const operationReply = await cli(resource, ['agent', 'execution', 'inspect', '--host', 'local', '--binding', bindingId,
    '--generation', originalOperation.generation, '--request-json', JSON.stringify(originalOperation.payload.id)])
  assert.equal(operationReply.code, 0, JSON.stringify(operationReply.packet))
  assert.equal(operationReply.packet.result.phase, 'completed')
  assert.equal(operationReply.packet.result.nativeRequestId, originalOperation.payload.id)
  assert.equal(operationReply.packet.result.streamGeneration, originalOperation.generation)
  assert(!Object.hasOwn(operationReply.packet.result, 'result'))
  const finalPair = readPair(resource, bindingId)
  assert.equal(finalPair.bridge.frontend.runId, frontend.runId)
  assert.equal(finalPair.bridge.executor.runId, executor.runId)
  const bindingAfterResume = await cli(resource, ['agent', 'execution', 'binding', '--input', bindingPath])
  assert.equal(bindingAfterResume.code, 0, JSON.stringify(bindingAfterResume.packet))
  assert.equal(bindingAfterResume.packet.result.state, 'connected', `Tool service remains unavailable after successful original-session recovery: ${JSON.stringify(bindingAfterResume.packet.result.diagnostic)}`)
  if (observation) {
    assert.deepEqual(bindingAfterResume.packet.result.diagnostics, observationEvidence.localRejection.diagnostics)
    const originalAgent = await agent.client.readAgentSession(agentSessionId)
    const originalExecutor = (await resource.client.runtimeSubject({ runId: executor.runId })).run
    assert.equal(originalExecutor.state, 'running')
    await cleanup.step({ owner: resource.name, action: 'stop-original-helper-for-observation', run: { runId: executor.runId } }, () => resource.client.stopTerminal({ runId: executor.runId }))
    let afterHelperExit
    await until(async () => {
      afterHelperExit = await resource.rpc.call('agent.execution.binding', { bindingId })
      return afterHelperExit?.state === 'unavailable'
    }, 'Public observation of exact helper exit without new protocol frame')
    const stoppedExecutor = (await resource.client.runtimeSubject({ runId: executor.runId })).run
    assert.equal(stoppedExecutor.state, 'exited')
    confirmedEndedHelpers.add(executor.runId)
    resource.runs.splice(resource.runs.indexOf(executor.runId), 1)
    await cleanup.step({ owner: resource.name, action: 'confirm-original-helper-exited', run: { runId: executor.runId } }, async () => stoppedExecutor)
    const retainedAgent = await agent.client.readAgentSession(agentSessionId)
    assert.equal(retainedAgent.agentSessionId, originalAgent.agentSessionId)
    assert.deepEqual(retainedAgent.run, originalAgent.run)
    assert.equal((await agent.client.runtimeSubject({ runId: originalAgent.run.runId })).run.state, 'running')
    assert.equal((await agent.client.runtimeSubject({ runId: frontend.runId })).run.state, 'running')
    const retainedPair = readPair(resource, bindingId)
    assert.equal(retainedPair.bridge.frontend.runId, frontend.runId); assert.equal(retainedPair.bridge.executor.runId, executor.runId)
    const failedRejoin = await cli(resource, ['agent', 'execution', 'rejoin', '--input', bindingPath])
    assert.notEqual(failedRejoin.code, 0, 'An ended original helper cannot be silently replaced by rejoin')
    assert.equal(readPair(resource, bindingId).bridge.executor.runId, executor.runId)
    assert.equal(await readFile(join(resource.base, 'workspace', 'effect-count.txt'), 'utf8'), 'once\n')
    observationEvidence.afterHelperExit = { inspection: afterHelperExit, stoppedExecutor, retainedAgentRun: retainedAgent.run, frontendRun: frontend.runId, failedRejoin: failedRejoin.packet, effectCount: 1 }
  }
  assert.equal(createHash('sha256').update(await readFile(driver.path)).digest('hex'), driver.sha256, 'Original proof driver remains exact')
  assert.deepEqual(await fingerprint(sourcePaths), sourceHashes, 'Observed product source inputs remain exact')
  assert.deepEqual(await fingerprint(Object.keys(compiledHashes)), compiledHashes, 'Observed compiled inputs remain exact')
  assert.deepEqual(errors, [], 'Unexpected native terminal/protocol errors remain')
  await writeFile(join(root,'native-frames.json'),JSON.stringify(frames,null,2),{mode:0o600});
  await writeFile(join(root,'diagnostics.json'),JSON.stringify(diagnostics,null,2),{mode:0o600});
  await writeFile(join(root,'summary.json'),JSON.stringify({observationEvidence,sourceHashes,compiledHashes,driver,actualMachines:1,controlledOfflineModel:true,nativeConversationId:originalId,originalPath,originalCoreSession:agentSessionId,firstRun:created.session.run,resumedRun:restored.runId,helperRuns:[frontend.runId,executor.runId],toolWorkspace:join(resource.base,'workspace'),launchWorkspace:join(agent.base,'workspace'),originalContextRetained:true,originalEffectCount:1,nativeInitializations:frames.filter(f=>f.payload?.method==='initialize').map(f=>({generation:f.generation,params:f.payload.params})),errors,publicCreation:true,resourceCoreRestarted:true,automaticReadersRestored:true,originalHelperPidsRetained:true,bindingAfterResume:bindingAfterResume.packet.result,cliActions:cliReceipts.map(receipt=>receipt.args.slice(0,3).join(' ')),scope:'Single-machine controlled model: compiled CLI public creation/rejoin/inspection, real resource Core restart with automatic original readers, and original Agent Session/native conversation resume; not full remote acceptance'},null,2),{mode:0o600});
  success = {passed:true,evidence:root,nativeConversationId:originalId,modelRequests:requests.length,errors};
} catch (error) {
  failed = true; primaryFailure = error
  await cleanup.step({ action: 'retain-primary-diagnostics' }, async () => {
    for (const owner of owners) for (const session of owner.sessions) {
      const replay = await owner.client.readRunReplay(session.run, 0, 'raw').catch(() => null)
      if (replay) await writeFile(join(root, `agent-${session.agentSessionId}.raw`), Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))), { mode: 0o600 })
    }
    await writeFile(join(root, 'diagnostics.json'), JSON.stringify({ diagnostics, error: String(error) }, null, 2), { mode: 0o600 })
    console.error(`Public execution binding proof failed. Private evidence: ${root}`)
  })
} finally {
  await cleanup.step({ action: 'close-controlled-model' }, async () => {
    for (const connection of modelSockets) connection.destroy()
    await new Promise((resolve, reject) => modelEndpoint.close(error => error ? reject(error) : resolve()))
  })
  await cleanup.step({ action: 'release-terminal-observer' }, () => releaseTerminalObserver?.())
  await cleanup.step({ action: 'dispose-terminal' }, () => ownerTerminal?.dispose())
  // Read only the exact private binding, including a latest Run admitted before an unknown reply.
  const resource = owners.find(owner => owner.name === 'resource'), agent = owners.find(owner => owner.name === 'agent')
  if (bindingId && resource && agent) await cleanup.step({ owner: resource.name, ownerRoot: resource.base, action: 'observe-exact-binding', bindingId }, async () => {
    const retained = readPair(resource, bindingId)
    if (retained.frontend && !agent.runs.includes(retained.frontend.runId)) agent.runs.push(retained.frontend.runId)
    if (retained.executor && !confirmedEndedHelpers.has(retained.executor.runId) && !resource.runs.includes(retained.executor.runId)) resource.runs.push(retained.executor.runId)
    const originalSession = await agent.client.readAgentSession(retained.input.agent.agentSessionId)
    if (originalSession) agent.sessions.push(originalSession)
  })
  await cleanup.finish(owners, { failed, error: primaryFailure })
}
console.log(JSON.stringify({ ...success, cleanup: join(root, 'cleanup.json') }))

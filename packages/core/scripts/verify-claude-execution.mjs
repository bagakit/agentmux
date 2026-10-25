import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../dist/hosted-client.js'
import { createClaudeExecutionProofModel, CLAUDE_PROOF_PNG_BASE64 } from './fixtures/claude-execution-proof-model.mjs'
import { createExecutionProofCleanup } from './fixtures/execution-proof-cleanup.mjs'

assert.equal(process.argv.length, 2, 'This proof accepts no user profile or Session target')
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const root = await realpath(await mkdtemp('/tmp/amx-claude-'))
const sourcePaths = ['src/agent-execution-frontend.ts', 'src/agent-execution-helper-run.ts', 'src/agent-execution-bridge.ts',
  'src/agent-execution-executor.ts', 'src/agent-execution-coordinator.ts', 'src/agent-execution-protocol.ts',
  'src/providers/claude.ts', 'src/providers/claude-tool-execution-launch.ts', 'src/providers/claude-execution-helper.ts',
  'src/providers/claude-execution-run.ts', 'src/providers/claude-execution-protocol.ts', 'src/providers/claude-execution-policy.ts', 'src/providers/claude-execution-shell.ts', 'src/providers/claude-execution-operations.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fingerprint = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(packageRoot, path)))])))
const sourceHashes = await fingerprint(sourcePaths), compiledHashes = await fingerprint(sourcePaths.map(path => path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js')))
const harnessPaths = ['scripts/verify-claude-execution.mjs', 'scripts/fixtures/claude-execution-proof-model.mjs', 'scripts/fixtures/execution-proof-cleanup.mjs']
const harnessHashes = await fingerprint(harnessPaths)
await mkdir(join(root, 'harness'))
for (const path of harnessPaths) await writeFile(join(root, 'harness', path.split('/').at(-1)), await readFile(join(packageRoot, path)))
const driver = { path: fileURLToPath(import.meta.url), sha256: hash(await readFile(fileURLToPath(import.meta.url))) }
await writeFile(join(root, 'inputs.json'), JSON.stringify({ sourceHashes, compiledHashes, harnessHashes, driver }, null, 2))
const cleanup = createExecutionProofCleanup(root), owners = [], cliReceipts = []
let failure, success, bindingId
const wait = async (test, label, ms = 45000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(label + ': observation deadline reached')
}
const deadline = async (promise, label, ms = 30000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const workspace = join(root, 'resource/workspace')
const { model, port, steps, finalNames, modelRequests, diagnostics, releaseFirstAnswer, stopResourceTask, close: closeModel } = await createClaudeExecutionProofModel({ root, workspace, nativeTools: process.env.AGENTMUX_CLAUDE_PROOF_NATIVE_TOOLS === '1' })
async function startOwner(name, agentOwner) {
  const base = join(root, name)
  for (const directory of ['home', 'claude', 'runtime', 'state', 'workspace']) await mkdir(join(base, directory), { recursive: true, mode: 0o700 })
  const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
  Object.assign(env, { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), AGENTMUX_RUNTIME_DIRECTORY: join(base, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(base, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(base, 'state/sessions.json'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'isolated-offline-model-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
  await writeFile(join(base, 'claude', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [join(base, 'workspace')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }), { mode: 0o600 })
  const native = spawn(join(packageRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'), ['--socket', join(base, 'runtime/ctxmux.sock'), '--state-dir', join(base, 'state/ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const owner = { name, base, env, native, runs: [], sessions: [] }; owners.push(owner); cleanup.trackChild(owner, 'native', native)
  native.stderr.on('data', bytes => diagnostics.push({ owner: name, source: 'native', text: bytes.toString() }))
  await deadline(Promise.race([once(native.stdio[3], 'data'), once(native, 'exit').then(() => { throw new Error('Test-owned ctxmux exited before readiness') })]), 'Test-owned ctxmux readiness')
  return await startCore(owner, agentOwner)
}
async function startCore(owner, agentOwner) {
  const runner = `
    import { startHeadlessAgentMux } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/headless-runtime.js')).href)};
    import { connectAgentMuxRpc } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/public-rpc-client.js')).href)};
    import { connectHostedAgentMux } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist/hosted-client.js')).href)};
    const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:process.argv[1]}});const agent=await connectHostedAgentMux({rpc});await agent.connectRuntime();
    const owner=await startHeadlessAgentMux({coreClients:()=>[{hostId:'agent',client:agent}]});
    process.stdout.write(JSON.stringify({operation:'serve',owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\\n');
    process.once('SIGTERM',()=>void owner.stop().then(async()=>{await agent.dispose();await rpc.dispose();process.exit(0)}));`
  const core = owner.core = spawn(process.execPath, agentOwner ? ['--input-type=module', '-e', runner, agentOwner.socketPath] : [join(packageRoot, 'dist/headless-runtime-cli.js'), 'serve'], { env: owner.env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'core', core)
  core.stderr.on('data', bytes => diagnostics.push({ owner: owner.name, source: 'core', text: bytes.toString() }))
  const line = await deadline(new Promise((resolve, reject) => {
    let text = ''; core.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n'))) }); core.once('exit', () => reject(new Error('Test-owned Core exited before readiness')))
  }), 'Test-owned Core readiness')
  const receipt = JSON.parse(line); owner.socketPath = receipt.socketPath
  owner.rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner.socketPath } }); owner.client = await connectHostedAgentMux({ rpc: owner.rpc }); await owner.client.connectRuntime()
  owner.hookEvents ??= []
  owner.releaseHookObservation = owner.client.onEvent(event => { if (event.type === 'agent-status' && event.evidence?.source === 'native-hook') owner.hookEvents.push(event) }, { observeMessages: false })
  return owner
}
async function cli(owner, args) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', `unix:${owner.socketPath}`, ...args], { env: owner.env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'cli', child)
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const [code, signal] = await deadline(once(child, 'close'), 'Real compiled CLI response', 60000)
  const packets = [...stdout.split('\n'), ...stderr.split('\n')].flatMap(line => { try { const value = JSON.parse(line); return typeof value.ok === 'boolean' ? [value] : [] } catch { return [] } })
  assert.equal(packets.length, 1, 'Compiled CLI emits one machine operation envelope')
  const receipt = { args, code, signal, packet: packets[0], stderr }; cliReceipts.push(receipt)
  await writeFile(join(root, 'cli-receipts.json'), JSON.stringify(cliReceipts, null, 2), { mode: 0o600 }); return receipt
}
function pair(owner, id) {
  const db = new DatabaseSync(join(owner.base, 'state/execution-bindings/bindings.sqlite'), { readOnly: true })
  try { const row = db.prepare('SELECT binding_intents.input,bindings.record FROM bindings JOIN binding_intents USING(id) WHERE id=?').get(id); assert(row); return { ...JSON.parse(row.record), input: JSON.parse(row.input) } } finally { db.close() }
}
async function frames(owner, runId) {
  const replay = await owner.client.readRunReplay({ runId }, 0, 'raw'); assert.equal(replay.gap, null); assert.equal(replay.run.runId, runId)
  const text = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function jsonlFiles(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? jsonlFiles(join(directory, entry.name)) : entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []))).flat()
}
try {
  const agent = await startOwner('agent'), resource = await startOwner('resource', agent)
  await writeFile(join(workspace, 'fixture.png'), Buffer.from(CLAUDE_PROOF_PNG_BASE64, 'base64'))
  await writeFile(join(workspace, 'input.txt'), 'PRIVATE_RESOURCE_INPUT\n')
  await writeFile(join(workspace, 'fixture.ipynb'), JSON.stringify({ cells: [{ cell_type: 'code', id: 'cell-original', metadata: {}, source: ['print("original")'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
  const configured = await agent.client.configureHostExecutor({ executorId: 'claude-native-proof', config: { label: 'Claude native execution proof', providerId: 'claude', command: 'claude',
    args: ['--print', '--output-format=stream-json', '--verbose', '--model=claude-sonnet-4-6', '--max-turns=16', process.env.AGENTMUX_CLAUDE_PROOF_NATIVE_TOOLS === '1' ? '--allowedTools=Read,Write,Edit,NotebookEdit,Bash,TaskStop,mcp__amux_exec__*' : '--allowedTools=mcp__amux_exec__*'], env: {}, injectAgentMuxGuide: false } })
  bindingId = randomUUID(); const agentSessionId = randomUUID()
  const creation = { bindingId, agentHostId: 'agent', agentRuntimeId: agent.client.runtimeOwnerIdentity().runtimeId, resourceHostId: 'local', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId,
    resourceWorkspacePath: workspace, resourceGrant: { scope: 'host-user', bindingId }, agent: { agentSessionId, createOperationId: randomUUID(), executorId: configured.executor.executorId,
      executorRevision: configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), prompt: 'PRIVATE_CLAUDE_ORIGINAL_CONTEXT: perform the isolated resource tools.' } }
  const input = join(root, 'create.json'), binding = join(root, 'binding.json'); await writeFile(input, JSON.stringify(creation)); await writeFile(binding, JSON.stringify({ bindingId }))
  let reply = await cli(resource, ['agent', 'execution', 'create', '--input', input])
  if (reply.code !== 0) {
    assert.equal(reply.packet.error?.code, 'EXECUTION_HELPER_UNAVAILABLE'); assert.equal(reply.packet.error.controlFailure?.disposition, 'not_applied')
    const original = pair(resource, bindingId)
    assert.equal(await agent.client.readAgentSession(agentSessionId), null)
    await wait(async () => (await frames(agent, original.frontend.runId)).some(frame => frame.type === 'ready'), 'Original frontend ready')
    reply = await cli(resource, ['agent', 'execution', 'create', '--input', input])
  }
  assert.equal(reply.code, 0, JSON.stringify(reply.packet))
  const created = reply.packet.result.session; assert.equal(created.agentSessionId, agentSessionId); agent.sessions.push(created)
  const original = pair(resource, bindingId), helpers = original.bridge
  agent.runs.push(helpers.frontend.runId); resource.runs.push(helpers.executor.runId)
  await wait(async () => await readFile(join(workspace, 'background.txt'), 'utf8').catch(() => null) === 'background-complete', 'All real resource tools')
  assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'modified\n')
  assert(JSON.stringify(JSON.parse(await readFile(join(workspace, 'fixture.ipynb'), 'utf8')).cells).includes('modified'))
  assert.equal(await readFile(join(workspace, 'effect-count.txt'), 'utf8'), 'once\n')
  await assert.rejects(readFile(join(agent.base, 'workspace/note.txt')), { code: 'ENOENT' })
  let current
  await wait(async () => { current = await agent.client.refreshAgentSession(agentSessionId, created.run); return current.nativeHandle?.kind === 'provider' }, 'Exact Core native identity capture')
  const nativeId = current.nativeHandle.sessionId, transcript = current.nativeHandle.transcriptPath
  assert(transcript && (await readFile(transcript, 'utf8')).includes('PRIVATE_CLAUDE_ORIGINAL_CONTEXT'))
  const rejoined = await cli(resource, ['agent', 'execution', 'rejoin', '--input', binding]); assert.equal(rejoined.code, 0)
  let backgroundTaskId
  await wait(async () => {
    const requests = await frames(agent, helpers.frontend.runId)
    const request = requests.find(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.arguments?.command === steps.find(step => step.id === 'toolu_remote_long_background').input.command)
    if (!request) return false
    const replies = await frames(resource, helpers.executor.runId)
    const reply = replies.find(frame => frame.type === 'response' && frame.generation === request.generation && frame.payload?.id === request.payload.id)
    const text = reply?.payload?.result?.content?.find(item => item.type === 'text')?.text
    if (!text) return false
    backgroundTaskId = JSON.parse(text).backgroundTaskId
    return typeof backgroundTaskId === 'string'
  }, 'Original typed resource background task receipt')
  const beforeRestart = { ctxmux: resource.client.runtimeIdentity(), core: resource.client.runtimeOwnerIdentity(),
    frontend: (await agent.client.readRunReplay({ runId: helpers.frontend.runId }, 0, 'raw')).run,
    executor: (await resource.client.readRunReplay({ runId: helpers.executor.runId }, 0, 'raw')).run }
  await resource.client.dispose(); await resource.rpc.dispose()
  const oldCore = resource.core, closed = once(oldCore, 'close'); oldCore.kill('SIGTERM'); assert.equal((await deadline(closed, 'Graceful original resource Core exit'))[0], 0)
  await startCore(resource, agent)
  assert.equal(resource.client.runtimeIdentity().instanceId, beforeRestart.ctxmux.instanceId)
  assert.equal(resource.client.runtimeOwnerIdentity().runtimeId, beforeRestart.core.runtimeId)
  assert.notEqual(resource.client.runtimeOwnerIdentity().ownerInstanceId, beforeRestart.core.ownerInstanceId)
  await wait(async () => (await resource.rpc.call('agent.execution.binding', { bindingId }))?.state === 'connected', 'Automatic original reader restoration')
  for (const side of ['frontend', 'executor']) {
    const owner = side === 'frontend' ? agent : resource, run = (await owner.client.readRunReplay({ runId: helpers[side].runId }, 0, 'raw')).run
    assert.equal(run.runId, beforeRestart[side].runId); assert.equal(run.pid, beforeRestart[side].pid); assert.equal(run.state, 'running')
  }
  releaseFirstAnswer()
  await wait(async () => (await agent.client.statusAgent(agentSessionId)).run.state === 'exited', 'Original print CLI natural exit')
  assert((await readFile(transcript, 'utf8')).includes(finalNames.first))
  stopResourceTask(backgroundTaskId)
  const resumed = await agent.client.resumeAgent({ agentSessionId, operationId: randomUUID(), prompt: 'PRIVATE_CLAUDE_RESUMED_CONTEXT: confirm original resource and conversation.' })
  agent.sessions = [resumed]; assert.equal(resumed.agentSessionId, agentSessionId); assert.equal(resumed.nativeHandle?.sessionId, nativeId)
  assert.deepEqual(resumed.toolExecution, created.toolExecution)
  await wait(async () => (await readFile(transcript, 'utf8')).includes(finalNames.resumed), 'Original native conversation resumed tools')
  const resumedRequest = modelRequests.find(value => JSON.stringify(value.body.messages).includes('PRIVATE_CLAUDE_RESUMED_CONTEXT'))
  assert(JSON.stringify(resumedRequest.body.messages).includes('PRIVATE_CLAUDE_ORIGINAL_CONTEXT'))
  assert(JSON.stringify(resumedRequest.body.messages).includes(finalNames.first))
  assert.equal(await readFile(join(workspace, 'effect-count.txt'), 'utf8'), 'once\n')
  await assert.rejects(readFile(join(workspace, 'long-background-forbidden.txt')), { code: 'ENOENT' })
  const machine = await frames(agent, helpers.frontend.runId), effects = machine.filter(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.name === 'Bash' && frame.payload.params.arguments?.command === steps.find(step => step.id === 'toolu_remote_effect').input.command)
  assert.equal(effects.length, 1, 'Original effect has one native request')
  const stops = machine.filter(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.name === 'TaskStop' && frame.payload.params.arguments?.task_id === backgroundTaskId)
  assert.equal(stops.length, 1, 'The resumed Agent submits one original resource task stop')
  const stopReceipt = await cli(resource, ['agent', 'execution', 'inspect', '--host', 'local', '--binding', bindingId, '--generation', stops[0].generation, '--request-json', JSON.stringify(stops[0].payload.id)])
  assert.equal(stopReceipt.code, 0); assert.equal(stopReceipt.packet.result.phase, 'completed')
  const exact = effects[0], inspected = await cli(resource, ['agent', 'execution', 'inspect', '--host', 'local', '--binding', bindingId, '--generation', exact.generation, '--request-json', JSON.stringify(exact.payload.id)])
  assert.equal(inspected.code, 0); assert.equal(inspected.packet.result.phase, 'completed'); assert.equal(inspected.packet.result.nativeRequestId, exact.payload.id)
  const observed = await cli(resource, ['agent', 'execution', 'binding', '--input', binding]); assert.equal(observed.code, 0); assert.equal(observed.packet.result.state, 'connected')
  const observedHooks = agent.hookEvents.filter(event => event.agentSessionId === agentSessionId)
  for (const name of ['PreToolUse', 'PostToolUse']) assert(observedHooks.some(event => event.detail === name && typeof event.evidence.hookReceiptId === 'string'), 'The original Core observer must receive ' + name)
  await writeFile(join(root, 'core-observer-hooks.json'), JSON.stringify(observedHooks, null, 2), { mode: 0o600 })
  const finalPair = pair(resource, bindingId); assert.equal(finalPair.bridge.frontend.runId, helpers.frontend.runId); assert.equal(finalPair.bridge.executor.runId, helpers.executor.runId)
  assert.deepEqual(await fingerprint(harnessPaths), harnessHashes); assert.deepEqual(await fingerprint(sourcePaths), sourceHashes); assert.deepEqual(await fingerprint(Object.keys(compiledHashes)), compiledHashes); assert.equal(hash(await readFile(driver.path)), driver.sha256)
  await writeFile(join(root, 'native-frames.json'), JSON.stringify(machine, null, 2), { mode: 0o600 })
  await writeFile(join(root, 'summary.json'), JSON.stringify({ passed: true, sourceHashes, compiledHashes, harnessHashes, driver, actualMachines: 1, controlledOfflineModel: true, actualNativeCli: 'Claude Code 2.1.314', explicitTestToolGrants: { native: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'TaskStop'], transport: 'mcp__amux_exec__*', productionAutoAllowClaim: false },
    originalCoreSession: agentSessionId, nativeConversationId: nativeId, transcript, originalContextRetained: true, originalEffectCount: 1, resourceBackgroundStopped: true, backgroundStoppedAfterNativeResume: true, backgroundTaskId, coreObserverHooksConfirmed: true, resourceCoreRestarted: true,
    automaticReadersRestored: true, originalHelperPidsRetained: true, originalHelpers: helpers, firstRun: created.run, resumedRun: resumed.run,
    resourceTools: steps.map(step => step.name), resourceWorkspace: workspace, launchWorkspace: join(agent.base, 'workspace'), publicCreation: true,
    cliActions: cliReceipts.map(value => value.args.slice(0, 3).join(' ')), errors: [], scope: 'Single machine, two isolated real Core/ctxmux owners with actual Claude MCP/native CLI and an offline controlled Anthropic model. This does not qualify two-machine execution, interactive approval or full Provider parity.' }, null, 2), { mode: 0o600 })
  success = { passed: true, evidence: root, originalCoreSession: agentSessionId, nativeConversationId: nativeId, modelRequests: modelRequests.length }
} catch (error) {
  failure = error
  for (const owner of owners) for (const session of owner.sessions) {
    const replay = await owner.client?.readRunReplay(session.run, 0, 'raw').catch(() => null)
    if (replay) await writeFile(join(root, `agent-${session.agentSessionId}.raw`), Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))), { mode: 0o600 })
  }
  await writeFile(join(root, 'failure.json'), JSON.stringify({ message: String(error), stack: error.stack, diagnostics }, null, 2), { mode: 0o600 })
} finally {
  releaseFirstAnswer()
  await cleanup.step({ action: 'close-controlled-model' }, closeModel)
  const resource = owners.find(owner => owner.name === 'resource'), agent = owners.find(owner => owner.name === 'agent')
  if (bindingId && resource && agent) await cleanup.step({ action: 'observe-exact-binding', bindingId }, async () => {
    const original = pair(resource, bindingId)
    if (original.frontend) agent.runs.push(original.frontend.runId)
    if (original.executor) resource.runs.push(original.executor.runId)
    const session = await agent.client.readAgentSession(original.input.agent.agentSessionId); if (session) agent.sessions.push(session)
  })
  await cleanup.finish(owners, { failed: Boolean(failure), error: failure })
}
console.log(JSON.stringify({ ...success, cleanup: join(root, 'cleanup.json') }))

import { createExecutionProofCleanup } from './fixtures/execution-proof-cleanup.mjs'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import xterm from '@xterm/headless'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../dist/hosted-client.js'
import { AgentExecutionBridge } from '../dist/agent-execution-bridge.js'
import { durableWriteFile } from '../dist/durable-write.js'

assert.equal(process.argv.length, 2, 'This bounded helper proof accepts no flags and is not the full cross-host Agent acceptance gate.')
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/amx-native-execution-')
const owners = [], diagnostics = []
const cleanup = createExecutionProofCleanup(root)
let success, primaryFailure, failed = false
let bridge, socket, ownerTerminal, releaseTerminalObserver
const deadline = (promise, label, ms = 30000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]).finally(() => clearTimeout(timer))
}
async function startOwner(name) {
  const base = join(root, name)
  for (const dir of ['home', 'codex', 'runtime', 'state', 'workspace']) await mkdir(join(base, dir), { recursive: true, mode: 0o700 })
  const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
  Object.assign(env, { HOME: join(base, 'home'), CODEX_HOME: join(base, 'codex'), AGENTMUX_RUNTIME_DIRECTORY: join(base, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(base, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(base, 'state', 'sessions.json') })
  await writeFile(join(base, 'codex', 'config.toml'), 'cli_auth_credentials_store = "file"\nmodel = "offline-model"\nmodel_provider = "offline"\n[model_providers.offline]\nname = "Offline native transport proof"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n' + `\n[projects.${JSON.stringify(join(root, 'resource', 'workspace'))}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
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
  owner.endpoint = 'unix:' + receipt.socketPath
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
  const errors = []
  const openBridge = async () => {
    const next = new AgentExecutionBridge({ state, ports: { frontend: agent.client, executor: resource.client },
      persist: async value => { await durableWriteFile(join(root, 'bridge.json'), JSON.stringify(value), { mode: 0o600 }); state = value },
      onFrame: async (side, frame) => { if (side === 'frontend' && frame.type === 'ready') readyResolve(frame.url); else diagnostics.push({ side, frame }) },
      onError: error => errors.push(error.message) })
    await next.start(); return next
  }
  bridge = await openBridge()
  const url = await deadline(ready, 'Frontend ready')
  socket = new WebSocket(url)
  const waiting = new Map()
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString())
    if (Object.hasOwn(value, 'id') && waiting.has(value.id)) { const callback = waiting.get(value.id); waiting.delete(value.id); callback(value) }
  })
  await deadline(once(socket, 'open'), 'Native socket open')
  let id = 0
  const call = async (method, params) => {
    const key = ++id
    const result = new Promise(resolve => waiting.set(key, resolve))
    socket.send(JSON.stringify({ id: key, method, params }))
    const response = await deadline(result, `Native ${method} response`)
    assert(!response.error, JSON.stringify(response.error))
    return response.result
  }
  const initialized = await call('initialize', { clientName: 'agentmux-native-execution-proof', resumeSessionId: null })
  assert.equal(initialized.environmentInfo.cwd, pathToFileURL(await realpath(join(resource.base, 'workspace'))).href)
  socket.send(JSON.stringify({ method: 'initialized', params: {} }))
  const marker = join(resource.base, 'workspace', 'marker.txt')
  const writeRequestId = id + 1
  await call('fs/writeFile', { path: pathToFileURL(marker).href, dataBase64: Buffer.from('resource only\n').toString('base64') })
  assert.equal(await readFile(marker, 'utf8'), 'resource only\n')
  await assert.rejects(readFile(join(agent.base, 'workspace', 'marker.txt')), { code: 'ENOENT' })
  // Obtain the operation identity from its actual native machine frame. Never
  // infer the stream generation from the socket URL or a displayed Agent state.
  const originalReplay = await agent.client.readRunReplay({ runId: frontend.runId }, 0, 'raw')
  assert.equal(originalReplay.gap, null)
  const originalFrames = Buffer.concat(originalReplay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  const writes = originalFrames.filter(frame => frame.type === 'request' && frame.payload?.method === 'fs/writeFile' &&
    frame.payload.id === writeRequestId && frame.payload.params?.path === pathToFileURL(marker).href)
  assert.equal(writes.length, 1, 'The original completed native write must have exactly one machine-protocol identity')
  const originalWrite = writes[0]
  const operationKey = { bindingId, streamGeneration: originalWrite.generation, nativeRequestId: originalWrite.payload.id }
  assert.equal(typeof operationKey.nativeRequestId, 'number')
  const [sdkInspection, rpcInspection] = await Promise.all([
    resource.client.inspectAgentExecutionOperation(operationKey),
    resource.rpc.call('agent.execution.inspect', { hostId: 'local', ...operationKey }),
  ])
  assert(sdkInspection, 'The completed original operation must not be reported as an empty journal')
  assert.deepEqual(rpcInspection, sdkInspection)
  assert.deepEqual(Object.keys(sdkInspection).sort(), ['bindingId', 'streamGeneration', 'nativeRequestId', 'payloadDigest',
    'payloadBytes', 'phase', 'revision', 'outcome', 'resultDigest', 'resultBytes'].sort(), 'Public inspection exposes metadata only')
  assert.equal(sdkInspection.phase, 'completed')
  assert.equal(sdkInspection.outcome, 'response-recorded')
  assert.equal(sdkInspection.bindingId, operationKey.bindingId)
  assert.equal(sdkInspection.streamGeneration, operationKey.streamGeneration)
  assert.equal(sdkInspection.nativeRequestId, operationKey.nativeRequestId)
  const originalPayload = Buffer.from(JSON.stringify(originalWrite.payload))
  assert.equal(sdkInspection.payloadDigest, 'sha256:' + createHash('sha256').update(originalPayload).digest('hex'))
  assert.equal(sdkInspection.payloadBytes, originalPayload.byteLength)
  assert.match(sdkInspection.resultDigest, /^sha256:[0-9a-f]{64}$/u)
  assert(Number.isSafeInteger(sdkInspection.resultBytes) && sdkInspection.resultBytes > 0)
  const inspectCli = async nativeRequestId => {
    const executing = promisify(execFile)(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', resource.endpoint,
      'agent', 'execution', 'inspect', '--host', 'local', '--binding', operationKey.bindingId,
      '--generation', operationKey.streamGeneration, '--request-json', JSON.stringify(nativeRequestId)],
    { cwd: join(resource.base, 'workspace'), env: resource.env, timeout: 15000, maxBuffer: 64 * 1024 })
    cleanup.trackChild(resource, 'cli', executing.child)
    const output = await executing
    const envelope = JSON.parse(output.stdout)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.operation, 'agent.execution.inspect')
    return envelope.result
  }
  const cliInspection = await inspectCli(operationKey.nativeRequestId)
  assert.deepEqual(cliInspection, sdkInspection, 'The compiled CLI must consume the same retained operation as the SDK and public RPC')
  const otherTypedKey = { ...operationKey, nativeRequestId: String(operationKey.nativeRequestId) }
  const [otherSdk, otherRpc, otherCli] = await Promise.all([
    resource.client.inspectAgentExecutionOperation(otherTypedKey),
    resource.rpc.call('agent.execution.inspect', { hostId: 'local', ...otherTypedKey }),
    inspectCli(otherTypedKey.nativeRequestId),
  ])
  assert.deepEqual([otherSdk, otherRpc, otherCli], [null, null, null], 'A JSON string ID must not alias the completed numeric request')
  assert.deepEqual(await resource.client.inspectAgentExecutionOperation(operationKey), sdkInspection, 'Read-only inspection must not advance the operation')
  assert.equal(await readFile(marker, 'utf8'), 'resource only\n')
  const inspectionEvidence = join(root, 'operation-inspection.json')
  await writeFile(inspectionEvidence, JSON.stringify({ actualMachines: 1, operationKey, sdk: sdkInspection, rpc: rpcInspection,
    cli: cliInspection, distinctStringId: { nativeRequestId: otherTypedKey.nativeRequestId, result: otherCli } }, null, 2), { mode: 0o600 })
  // Close only the observer. Both native endpoints and their original Runs remain.
  await bridge.close()
  socket.send(JSON.stringify({ id: ++id, method: 'fs/readFile', params: { path: pathToFileURL(marker).href } }))
  const offlineId = id
  const offlineResult = new Promise(resolve => waiting.set(offlineId, resolve))
  bridge = await openBridge()
  const continued = await deadline(offlineResult, 'Original socket continued after reader reconnect')
  assert(!continued.error)
  const commandPath = join(resource.base, 'workspace', 'command.txt')
  const processId = randomUUID()
  await call('process/start', { processId, argv: ['/bin/sh', '-c', 'printf command > "$1"', 'proof', commandPath],
    cwd: pathToFileURL(join(resource.base, 'workspace')).href, env: {}, tty: false, pipeStdin: false })
  const read = await call('process/read', { processId, afterSeq: 0, waitMs: 1000, maxBytes: 65536 })
  assert.equal(await readFile(commandPath, 'utf8'), 'command')
  const closed = once(socket, 'close'); socket.close(); await closed
  const configured = await agent.client.configureHostExecutor({ executorId: 'native-tool-proof', config: {
    label: 'Native tool execution proof', providerId: 'codex', command: 'codex', args: ['--no-alt-screen'], env: {}, injectAgentMuxGuide: false,
  } })
  const toolExecution = { bindingId, resourceHostId: 'resource', resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, workspacePath: join(resource.base, 'workspace') }
  const creation = { agentSessionId, createOperationId: randomUUID(), executorId: configured.executor.executorId,
    executorRevision: configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), toolExecution }
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
  assert.deepEqual(created.session.toolExecution, toolExecution)
  assert.equal((await agent.client.statusAgent(agentSessionId)).run.state, 'running')
  await assert.rejects(agent.client.createHostAgentWithDelivery({ ...creation, toolExecution: { ...toolExecution, resourceHostId: 'another' } }))
  await assert.rejects(agent.client.createHostAgentWithDelivery({ ...creation, toolExecution: undefined }))
  // Confirm the ordinary CLI's native requests on the declared machine channel,
  // never by matching its screen text. No account or model prompt is used.
  let nativeRequests = []
  const expires = Date.now() + 10000
  while (Date.now() < expires) {
    const replay = await agent.client.readRunReplay({ runId: frontend.runId }, 0, 'raw')
    assert.equal(replay.gap, null)
    const text = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString('utf8')
    const frames = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    nativeRequests = frames.filter(frame => frame.type === 'request' && frame.payload?.method === 'environmentConfig/read' &&
      frame.payload.params?.cwd === pathToFileURL(join(resource.base, 'workspace')).href)
    if (nativeRequests.length) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!nativeRequests.length) {
    const replay = await agent.client.readRunReplay({ runId: frontend.runId }, 0, 'raw')
    const frames = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    diagnostics.push({ nativeRequests: frames.filter(frame => frame.type === 'request').map(frame => ({ generation: frame.generation, method: frame.payload?.method, path: frame.payload?.params?.path })) })
  }
  assert(nativeRequests.length > 0, 'Ordinary Agent CLI did not address its resource workspace through native execution')
  assert.equal(errors.length, 0, errors.join('\n'))
  success = { scope: 'isolated-two-Core-native-helper-proof', actualMachines: 1,
    providerVersion: initialized.environmentInfo.executorVersion, helperRuns: [frontend.runId, executor.runId],
    fileOnResource: true, commandOnResource: true, originalSocketAfterReaderDetach: true,
    publicOperationInspection: { operationKey, phase: sdkInspection.phase, sdkRpcCliAgree: true, metadataOnly: true, typedIdPreserved: true, evidence: inspectionEvidence },
    originalNativeSessionId: initialized.sessionId, ordinaryAgentCreatedThroughHostedCore: true, exactBindingRetained: true, fullAgentAcceptance: false }
} catch (error) {
  failed = true; primaryFailure = error
  await cleanup.step({ action: 'retain-primary-diagnostics' }, async () => {
    for (const owner of owners) for (const session of owner.sessions) {
      const replay = await owner.client.readRunReplay(session.run, 0, 'raw').catch(() => null)
      if (replay) await writeFile(join(root, `agent-${session.agentSessionId}.raw`), Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))), { mode: 0o600 })
    }
    await writeFile(join(root, 'diagnostics.json'), JSON.stringify({ diagnostics, error: String(error) }, null, 2), { mode: 0o600 })
    console.error(`Native helper proof failed. Private evidence: ${root}`)
  })
} finally {
  await cleanup.step({ action: 'release-terminal-observer' }, () => releaseTerminalObserver?.())
  await cleanup.step({ action: 'dispose-terminal' }, () => ownerTerminal?.dispose())
  await cleanup.step({ action: 'close-native-socket' }, async () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close'); socket.close(); await closed
    }
  })
  await cleanup.step({ action: 'close-bridge-reader' }, () => bridge?.close())
  await cleanup.finish(owners, { failed, error: primaryFailure })
}
console.log(JSON.stringify({ ...success, evidence: root, cleanup: join(root, 'cleanup.json') }))

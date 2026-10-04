import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentProviderRegistry, agentPromptCondition } from '../../../packages/core/dist/index.js'
import { connectAgentMuxRpc } from '../../../packages/core/dist/public-rpc-client.js'

// Test-owned real Desktop, Core, Runtime and pinned Provider. No Renderer queue or permission
// seed is used for sends: native keys admit the original intent and native hooks own waiting.
const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(import.meta.url), execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receiptPath = process.argv.find(value => value.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
const probeRoot = process.argv.find(value => value.startsWith('--probe-root='))?.slice('--probe-root='.length)
const diagnosticOnly = process.argv.includes('--steer-recovery-diagnostic')
const typedCrossCore = process.argv.includes('--typed-response-cross-core')
const typedFirstHook = process.argv.includes('--typed-response-first-hook')
const startupFirstSend = process.argv.includes('--startup-first-send')
const startupRestoredOnly = process.argv.includes('--startup-restored-first-send')
const finalQualification = process.argv.includes('--steer-recovery-final') || !(diagnosticOnly || typedCrossCore || startupFirstSend || startupRestoredOnly)
const startupQualification = startupFirstSend || startupRestoredOnly
assert.ok(!(startupFirstSend && startupRestoredOnly), 'Startup proof triggers have distinct qualification scopes')
assert.ok(!finalQualification || !(startupQualification || diagnosticOnly || typedCrossCore), 'Final GUI recovery qualification has a distinct Source and Native scope')
assert.ok(!startupQualification || !(diagnosticOnly || typedCrossCore), 'Startup first Send is a distinct Native qualification')
assert.ok(!typedFirstHook || typedCrossCore, 'First-Hook qualification must use the two-Core Native mode')
assert.ok(!(diagnosticOnly && typedCrossCore), 'Diagnostic and two-Core qualification are distinct proof modes')
for (const arg of process.argv.slice(2)) assert.ok(arg === '--steer-recovery' || arg === '--steer-recovery-diagnostic' || arg === '--typed-response-cross-core' || arg === '--typed-response-first-hook' || arg === '--startup-first-send' || arg === '--startup-restored-first-send' || arg === '--steer-recovery-final' || arg.startsWith('--receipt-path=') || arg.startsWith('--probe-root='), 'Unknown bounded native option: ' + arg)
assert.ok(receiptPath && probeRoot && process.env.AGENTMUX_STEER_RECOVERY_BUILD_RECEIPT)
const root = await realpath(await mkdtemp(join(probeRoot, 'sr-')))
const userData = join(root, 'ui'), runtime = join(root, 'rt'), workspace = join(root, 'ws'), codexHome = join(root, 'home')
const id = 'private-steer-recovery', tabId = 'recovery-tab', regionId = 'recovery-agent', fileId = 'recovery-file', workspaceId = 'recovery-workspace'
const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtime,
  AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'), AGENTMUX_SPATIAL_STATE_STORE: join(runtime, 'state', 'spatial.json'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: codexHome }
for (const name of Object.keys(env)) if (/^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name)) delete env[name]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: env.AGENTMUX_STATE_DIRECTORY,
  AGENTMUX_SPATIAL_STATE_STORE: env.AGENTMUX_SPATIAL_STATE_STORE, AGENTMUX_MESSAGE_QUEUE_PATH: env.AGENTMUX_MESSAGE_QUEUE_PATH, CODEX_HOME: codexHome })
for (const dir of [userData, runtime, join(runtime, 'state/ctxmux'), workspace, codexHome]) await mkdir(dir, { recursive: true, mode: 0o700 })
const report = { schema: 'agentmux.steer-recovery-native.v1', passed: false, userRunTouched: false, sharedSourceWritten: false,
  root, phases: [], diagnosticOnly, typedCrossCore, typedFirstHook, startupFirstSend, startupRestoredOnly, finalQualification, boundary: 'A actual Desktop native resume; B real permission on that recovered Run; independent Desktop restart is separate.' }
const progress = async stage => { report.stage = stage; await writeFile(receiptPath, JSON.stringify(report, null, 2)); console.log('private_native_stage=' + stage) }
const responseClaims = []
const pendingTransitions = []
class ObservedResponseStore extends AgentMuxFileAgentSessionStore {
  async compareAndSwap(...args) {
    const result = await super.compareAndSwap(...args), next = args[1]
    if (next?.pendingInteraction?.response) responseClaims.push({ observedAt: Date.now(), response: structuredClone(next.pendingInteraction.response) })
    if (typedFirstHook && (args[0]?.pendingInteraction || next?.pendingInteraction)) pendingTransitions.push({ observedAt: Date.now(),
      expected: { run: structuredClone(args[0]?.run), pendingInteraction: structuredClone(args[0]?.pendingInteraction), hookReceipt: structuredClone(args[0]?.hookReceipt) },
      next: { run: structuredClone(next?.run), pendingInteraction: structuredClone(next?.pendingInteraction), hookReceipt: structuredClone(next?.hookReceipt) } })
    return result
  }
}
const store = new (typedCrossCore ? ObservedResponseStore : AgentMuxFileAgentSessionStore)(join(userData, 'agent-sessions.json'))
const build = JSON.parse(await readFile(process.env.AGENTMUX_STEER_RECOVERY_BUILD_RECEIPT, 'utf8'))
assert.equal(build.privateRoot, repository)
assert.equal(build.compiled['apps/desktop/out/main/index.js'], sha(await readFile(join(desktop, 'out/main/index.js'))))
assert.equal(build.compiled['packages/core/dist/index.js'], sha(await readFile(join(repository, 'packages/core/dist/index.js'))))
report.buildReceipt = process.env.AGENTMUX_STEER_RECOVERY_BUILD_RECEIPT
const requests = [], held = new Set(), electronChildren = new Set(), electronDiagnostics = new Map()
let permissionIssued = false, failure, client, typedPeer, daemon, daemonClosed, first, second
let restorationFailure
let daemonError = '', output = '', backendError
const until = async (label, read, budget = 35_000) => {
  const end = Date.now() + budget
  do { if (backendError) throw backendError; const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 30)) } while (Date.now() < end)
  throw new Error('Private recovery proof timed out: ' + label)
}
const textOf = request => request.input?.filter(item => item.role === 'user').at(-1)?.content?.map(part => part.text ?? '').join('') ?? ''
const backend = createServer(async (request, response) => {
  try {
  let body = ''; for await (const chunk of request) body += chunk
  if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end('{"data":[]}'); return }
  const value = JSON.parse(body), user = textOf(value)
  if (!user.includes('PRIVATE_') || user.startsWith('Generate a concise')) { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return }
  requests.push(value)
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = item => response.write('event: ' + item.type + '\ndata: ' + JSON.stringify(item) + '\n\n')
  const responseId = 'private_response_' + requests.length
  event({ type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } })
  if (user.includes('PRIVATE_PERMISSION_SETUP') && !permissionIssued) {
    const tool = value.tools?.find(item => item.type === 'function' && item.name === 'exec_command')
    assert.ok(tool?.parameters?.properties?.cmd, 'Actual pinned CLI must advertise its official exec_command schema')
    assert.ok(JSON.stringify(tool.parameters.properties.sandbox_permissions).includes('require_escalated'))
    report.nativeTool = { name: tool.name, schema: tool.parameters }
    permissionIssued = true
    const arguments_ = JSON.stringify({ cmd: typedFirstHook || finalQualification ? 'sleep 0.2; printf PRIVATE_PERMISSION_PROBE' : 'printf PRIVATE_PERMISSION_PROBE', sandbox_permissions: 'require_escalated', justification: 'Private recovery fixture approval' })
    const item = { type: 'function_call', id: 'private_tool_item_' + requests.length, call_id: 'private_approval_call_' + requests.length, name: tool.name, arguments: arguments_, status: 'completed' }
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
    event({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: arguments_ })
    event({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: arguments_ })
    event({ type: 'response.output_item.done', output_index: 0, item })
    event({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } })
    response.end(); return
  }
  if (user.includes('PRIVATE_PERMISSION_SETUP') && (!typedCrossCore || !value.input?.some(item => item.type === 'function_call_output'))) { held.add(response); response.once('close', () => held.delete(response)); return }
  const text = 'PRIVATE_FINISHED_' + requests.length
  const item = { type: 'message', id: 'private_assistant_' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
  event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text })
  event({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text })
  event({ type: 'response.output_item.done', output_index: 0, item })
  event({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } })
  response.end()
  } catch (error) { backendError = error; response.end() }
})
await new Promise(done => backend.listen(0, '127.0.0.1', done))
const canonical = async () => (await store.load()).find(item => item.kind === 'agent' && item.agentSessionId === id)
async function cdpConnect(url, openTimeoutMs) {
  const socket = new WebSocket(url); await new Promise((done, fail) => {
    const timer = openTimeoutMs === undefined ? undefined : setTimeout(() => { socket.close(); fail(new Error('Private diagnostic CDP open timeout')) }, openTimeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  let serial = 0; const pending = new Map()
  socket.addEventListener('message', ({ data }) => { const value = JSON.parse(data), request = pending.get(value.id); if (!request) return; pending.delete(value.id); clearTimeout(request.timer); value.error ? request.fail(new Error(value.error.message)) : request.done(value.result) })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Private CDP closed')) }; pending.clear() })
  const call = (method, params = {}) => new Promise((done, fail) => { const requestId = ++serial, timer = setTimeout(() => { pending.delete(requestId); fail(new Error('Private CDP timeout: ' + method)) }, 10_000); pending.set(requestId, { done, fail, timer }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  return { call, close: () => socket.close(), async evaluate(expression) { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value } }
}
async function launch(label, seed) {
  const ready = join(root, 'ready-' + label + '.json')
  const probeEnvironment = diagnosticOnly ? { NODE_OPTIONS: '--import=' + pathToFileURL(build.diagnosticProbe.path).href,
    AGENTMUX_PRIVATE_PREPARE_PROBE_ROOT: root, AGENTMUX_PRIVATE_PREPARE_PROBE_REPOSITORY: repository,
    AGENTMUX_PRIVATE_PREPARE_PROBE_SESSION: id } : {}
  const child = spawn(require('electron'), [join(desktop, 'out/main/index.js'), '--remote-debugging-port=0'], { cwd: desktop, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env,
    ...probeEnvironment, AGENTMUX_DESKTOP_READY_FILE: ready, AGENTMUX_DESKTOP_RECOVERY_REPORT: join(root, 'desktop-' + label + '.json'), ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: JSON.stringify(seed) } : {}) } })
  electronChildren.add(child)
  const startup = { label, pid: child.pid, startedAt: Date.now(), readyPath: ready, probeEnabled: diagnosticOnly, stderr: '' }
  electronDiagnostics.set(child, startup)
  let debuggerUrl, diagnostic = ''
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-16384); startup.stderr = diagnostic; startup.stderrObservedAt = Date.now(); debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(diagnostic)?.[1] })
  startup.debugger = () => debuggerUrl
  await until(label + ' ready', async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(diagnostic); try { return JSON.parse(await readFile(ready, 'utf8')) } catch { return false } })
  const endpoint = new URL(await until(label + ' debugger', () => debuggerUrl))
  const target = await until(label + ' renderer', async () => (await (await fetch('http://' + endpoint.host + '/json/list')).json()).find(item => item.type === 'page' && item.url.startsWith('file:')))
  const cdp = await cdpConnect(target.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable'); await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until(label + ' original Conversation editor', () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${regionId}"] .composer [contenteditable="true"]'))`))
  return { child, cdp }
}
const scope = `[data-workbench-region-id="${regionId}"] .composer [contenteditable="true"]`
async function draft(cdp, body) {
  assert.equal(await cdp.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(scope)});input.focus();return document.activeElement===input })()`), true)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
  await cdp.call('Input.insertText', { text: body })
  await until('actual original Composer draft', () => cdp.evaluate(`document.querySelector(${JSON.stringify(scope)})?.textContent===${JSON.stringify(body)}`))
}
async function send(cdp) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 4 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 4 })
}
async function sendNativeSetup(cdp, body) {
  const previous = (await canonical()).terminalPromptSubmission?.submissionId
  await draft(cdp, body); await send(cdp)
  const digest = createHash('sha256').update(body).digest('base64url')
  const current = await until(body + ' actual GUI/Main setup submission', async () => {
    const value = await canonical(), phase = value?.terminalPromptSubmission
    return phase?.submissionId !== previous && phase?.promptDigest === digest && phase.submit.acknowledged && value
  }, 75_000)
  assert.equal(current.promptCompletionAdmission?.intent?.execution, 'immediate')
  await until(body + ' actual Native setup request', () => {
    const count = requests.filter(request => textOf(request) === body).length
    assert.ok(count <= 1); return count === 1
  })
  return { body, operationId: current.terminalPromptSubmission.submissionId, phase: current.terminalPromptSubmission,
    entryPoint: 'actual GUI Cmd+Enter -> existing Main/Core owner', nativeRequestCount: 1 }
}
async function selectWaitingOriginal(cdp, body) {
  await draft(cdp, body)
  // Pending UI deliberately exposes queueing, not direct Send. The public pending operation
  // is the real trusted user's existing production caller for selecting this exact original.
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const original = await until(body + ' actual Enter queue entry', async () => (await stored(cdp))?.agentSteerQueues?.[id]?.find(entry => entry.text === body))
  assert.equal(original.promptCondition, null); assert.equal(original.execution, undefined)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
  let publicChoice
  try { publicChoice = await rpc.call('message.pending.send', { agentSessionId: id, pendingId: original.operationId }) }
  finally { await rpc.dispose() }
  assert.equal(publicChoice.pendingId, original.operationId); assert.equal(publicChoice.disposition, 'unconfirmed')
  assert.equal(publicChoice.message?.delivery, 'not-submitted')
  const selected = await until(body + ' actual public-selected original', async () => {
    const entry = (await stored(cdp))?.agentSteerQueues?.[id]?.find(entry => entry.operationId === original.operationId)
    return entry?.execution === 'immediate' && entry
  })
  assert.equal(selected.promptCondition, null); assert.equal(selected.text, body)
  return { selected, publicChoice }
}
async function stored(cdp) { return cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1'))?.state`) }
async function postSendEmptyNativeComposer(marker, accepted, calledAt) {
  const turnId = accepted.nativeRecords[0]?.payload?.internal_chat_message_metadata_passthrough?.turn_id
  assert.equal(typeof turnId, 'string', 'The actual original Native user record must carry its turn identity')
  const nativeEnd = await until('matching actual Native task completion after original first Send', async () => {
    const bytes = await readFile(accepted.nativeHandle.transcriptPath), rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const userIndex = rows.findIndex(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user' &&
      row.payload.internal_chat_message_metadata_passthrough?.turn_id === turnId && row.payload.content?.some(part => part.text === marker))
    assert.ok(userIndex >= 0)
    const started = rows.slice(0, userIndex).find(row => row.type === 'event_msg' && row.payload?.type === 'task_started' && row.payload.turn_id === turnId)
    const completed = rows.slice(userIndex + 1).filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete' && row.payload.turn_id === turnId)
    assert.ok(completed.length <= 1); if (!started || completed.length !== 1) return false
    const path = receiptPath + '.' + accepted.operationId + '.completed.native.jsonl'
    await writeFile(path, bytes)
    return { turnId, userIndex, started, completed: completed[0], path, sha256: sha(bytes) }
  })
  const done = await until('new authenticated matching native turn-end after original first Send', async () => {
    const value = await canonical(), end = value?.hookReceipt
    return value?.run.runId === accepted.run.runId && value?.semanticStatus?.state === 'done' &&
      end?.run.runId === accepted.run.runId && end.lifecycleEvent === 'turn-end' && end.observedAt >= calledAt &&
      (!end.nativeTurnId || end.nativeTurnId === turnId) && end.id !== accepted.typedSubmission.prepare?.previousReceiptId && value
  })
  assert.deepEqual(done.nativeHandle, accepted.nativeHandle)
  await client.refreshAgentSession(id, done.run)
  const run = (await client.statusAgent(id)).run
  const throughFence = Math.max(run.latestOutputBytes, done.hookReceipt.outputCursorBytes ?? 0)
  let snapshot
  const throughByte = await client.screenEvidence.wait(client.agentSession(id), throughFence, false, screen => {
    snapshot = screen.snapshot(); return new AgentProviderRegistry().get('codex').inspectPromptExecution(snapshot) === 'idle'
  }, { timeoutMs: 10000, requireCompleteFrame: true, timeoutMessage: 'Original first Send did not leave a complete empty ordinary composer', terminalMessage: 'Private native Run ended' })
  assert.ok(throughByte >= throughFence)
  return { observedAt: Date.now(), nativeEnd, hookReceipt: done.hookReceipt, run, throughFence, throughByte, snapshot, context: 'idle' }
}
async function nativeAccepted(marker, operationId) {
  const current = await until(marker + ' original Core typed submit', async () => {
    const value = await canonical()
    if (value?.terminalPromptDelivery?.submissionId === operationId && value.terminalPromptDelivery.state === 'unverified') {
      const error = new Error('Actual Core original delivery is unconfirmed: ' + value.terminalPromptDelivery.reason)
      error.code = 'PRIVATE_CORE_DELIVERY_UNCONFIRMED'; throw error
    }
    return value?.terminalPromptSubmission?.submissionId === operationId && value.terminalPromptSubmission.submit.acknowledged && value
  }, 75_000)
  const records = await until(marker + ' real native record', async () => {
    const bytes = await readFile(current.nativeHandle.transcriptPath, 'utf8')
    await writeFile(receiptPath + '.' + operationId + '.native.jsonl', bytes)
    const rows = bytes.split('\n').filter(Boolean).map(line => JSON.parse(line))
    const found = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user' &&
      row.payload.content?.some(part => typeof part.text === 'string' && part.text.includes(marker)))
    assert.ok(found.length <= 1, 'One original operation must not duplicate native user input')
    return found.length === 1 && found
  })
  await until(marker + ' exact native backend input', () => {
    const count = requests.filter(request => textOf(request) === marker).length
    assert.ok(count <= 1, 'Actual native CLI must not send the original body twice')
    return count === 1
  })
  await client.refreshAgentSession(id, current.run)
  await client.screenEvidence.wait(client.agentSession(id), 0, false, screen => new AgentProviderRegistry().get('codex').inspectPromptExecution(screen.snapshot()) !== 'unavailable', { timeoutMs: 10_000, timeoutMessage: 'native draft did not clear', terminalMessage: 'private Run exited', requireCompleteFrame: true })
  return { operationId, run: current.run, nativeHandle: current.nativeHandle, mode: current.promptCompletionAdmission?.intent?.execution,
    typedSubmission: current.terminalPromptSubmission, nativeRecords: records, nativeDraftCleared: true }
}
async function captureStartupFailureFacts() {
  if (!diagnosticOnly) return
  const facts = { capturedAt: Date.now(), boundary: 'Read-only current startup observations; no wait, input, fallback or retry.', children: [], traces: [] }
  report.startupFailureFacts = facts
  for (const [child, record] of electronDiagnostics) {
    const { debugger: debuggerAddress, ...startup } = record
    const current = { ...startup, observedAt: Date.now(), exitCode: child.exitCode, signalCode: child.signalCode, debuggerUrl: debuggerAddress() }
    try { const bytes = await readFile(record.readyPath); current.readyFile = { bytes: bytes.toString('utf8'), sha256: sha(bytes) } }
    catch (error) { current.readyFileError = diagnosticError(error) }
    if (current.debuggerUrl) {
      try {
        const endpoint = new URL(current.debuggerUrl)
        current.targets = await (await fetch('http://' + endpoint.host + '/json/list', { signal: AbortSignal.timeout(4_000) })).json()
        const target = current.targets.find(item => item.type === 'page' && item.url.startsWith('file:')) ?? current.targets.find(item => item.type === 'page')
        if (target) {
          const observed = await cdpConnect(target.webSocketDebuggerUrl, 4_000)
          try { current.renderer = await observed.evaluate(`({url:location.href,readyState:document.readyState,text:document.body?.innerText,hasApi:Boolean(window.agentmux),workbench:localStorage.getItem('agentmux-workbench-v1')})`) }
          finally { observed.close() }
        }
      } catch (error) { current.rendererObservationError = diagnosticError(error) }
    }
    facts.children.push(current)
  }
  for (const name of await readdir(root)) if (/^prepare-calls\.\d+\.jsonl$/.test(name)) {
    const bytes = await readFile(join(root, name)), destination = receiptPath + '.startup.' + name
    await writeFile(destination, bytes); facts.traces.push({ source: join(root, name), destination, sha256: sha(bytes), rawBytes: bytes.length })
  }
  try { const bytes = await readFile(store.path), destination = receiptPath + '.startup.store.json'; await writeFile(destination, bytes); facts.store = { path: destination, sha256: sha(bytes) } }
  catch (error) { facts.storeError = diagnosticError(error) }
  try {
    const value = await canonical(); facts.canonical = value
    if (value?.nativeHandle?.transcriptPath) {
      const bytes = await readFile(value.nativeHandle.transcriptPath), destination = receiptPath + '.startup.native.jsonl'
      await writeFile(destination, bytes); facts.native = { source: value.nativeHandle.transcriptPath, destination, sha256: sha(bytes) }
    }
  } catch (error) { facts.nativeObservationError = diagnosticError(error) }
  report.startupFailureFacts = facts
  await progress('startup-failure-facts-captured-before-cleanup')
}
async function proveTypedResponseCrossCore(initial) {
  report.schema = typedFirstHook ? 'agentmux.typed-response-first-hook-native.v1' : 'agentmux.typed-response-cross-core-native.v1'
  report.qualifiedScope = typedFirstHook
    ? 'Actual SDK two Core at the first observed official PermissionRequest on one real private Native Run; Desktop recovery and original selected pending remain unqualified.'
    : 'Actual SDK two Core on one real private Native Run; Desktop recovery and original selected pending remain unqualified.'
  if (!typedFirstHook) report.earlyHookReadinessWindowRepaired = false
  await until('first Core actual native done readiness', async () => {
    const value = await canonical(); return value?.semanticStatus?.state === 'done' && value.terminalPromptReadiness?.readyThroughByte !== undefined && value
  })
  const before = (await client.statusAgent(id)).run, legitimateCursor = client.agentInputCursors.get(id)
  assert.equal(before.runId, initial.run.runId); assert.equal(legitimateCursor, before.acceptedInputBytes)
  report.initialLocalAck = { run: before, cursor: legitimateCursor, handshake: initial.terminalHandshake }
  typedPeer = new AgentMuxClient({ store }); await typedPeer.connect(); await typedPeer.refreshAgentSession(id, initial.run)
  const setupId = randomUUID(), body = 'PRIVATE_PERMISSION_SETUP_TWO_CORE'
  await typedPeer.submitAgentPrompt({ ...agentPromptCondition(typedPeer.agentSession(id)), agentSessionId: id, operationId: setupId, prompt: body })
  let hookObservedAt
  const waiting = await until('actual cross-Core native PermissionRequest', async () => {
    const value = await canonical()
    if (value?.pendingInteraction?.request?.kind !== 'permission') return false
    hookObservedAt = Date.now(); return value
  })
  const request = waiting.pendingInteraction.request
  // The first-Hook path has no fixture Runtime read or progress-file await between
  // observing the official request and calling the public typed response method.
  const authority = typedFirstHook ? undefined : (await client.statusAgent(id)).run
  const expectedCursor = typedFirstHook ? waiting.terminalPromptSubmission?.submit?.inputByteRange.endByte : authority.acceptedInputBytes
  assert.equal((authority ?? waiting.run).runId, initial.run.runId); assert.ok(expectedCursor > legitimateCursor)
  assert.equal(client.agentInputCursors.get(id), legitimateCursor)
  if (typedFirstHook) {
    assert.equal(waiting.terminalPromptSubmission?.submit?.acknowledged, true)
    assert.equal(request.evidence.source, 'native-hook'); assert.equal(request.evidence.run.runId, initial.run.runId)
    assert.equal(request.nativeToolCallId, 'private_approval_call_2')
  }
  report.crossCoreCounterexample = { setupId, setupSubmission: waiting.terminalPromptSubmission, request,
    localCursor: legitimateCursor, authority: authority?.acceptedInputBytes, expectedCursor, run: authority ?? waiting.run,
    ...(typedFirstHook ? { cursorOracleSource: 'Actual peer setup acknowledged submit range, not a fixture fresh Runtime read' } : {}) }
  if (!typedFirstHook) await progress('typed-cross-core-real-request-and-stale-local-cursor')
  // This setup explicitly qualifies Native consumption only after the real pane.
  // It does not repair the early Hook window or the Desktop first-send boundary.
  let approvalSnapshot, approvalThroughByte
  if (!typedFirstHook) approvalThroughByte = await client.screenEvidence.wait(client.agentSession(id), authority.latestOutputBytes, false, screen => {
    approvalSnapshot = screen.snapshot(); const text = approvalSnapshot.lines.map(line => line.text).join('\n')
    return text.includes('Would you like to run the following command?') && text.includes('Press enter to confirm or esc to cancel') && text.includes('PRIVATE_PERMISSION_PROBE')
  }, { timeoutMs: 10_000, requireCompleteFrame: true, timeoutMessage: 'Actual complete native approval pane unavailable', terminalMessage: 'Private Run ended before native approval pane' })
  const option = request.options.find(item => item.kind === 'allow-once'); assert.ok(option)
  const response = { kind: 'permission', requestId: request.id, decision: { outcome: 'selected', optionId: option.id } }
  const firstHookFacts = typedFirstHook ? { hookObservedAt, nativeHookObservedAt: request.evidence.observedAt,
    request: structuredClone(request), outputPrefixAtCall: output, responseClaims, pendingTransitions,
    boundary: 'First observed authenticated PermissionRequest; no fixture pane, transport or status wait before public SDK call' } : undefined
  if (firstHookFacts) { report.firstHookResponse = firstHookFacts; firstHookFacts.callAt = Date.now() }
  await client.respondAgentInteraction({ agentSessionId: id, expectedRun: initial.run, response })
  if (firstHookFacts) {
    firstHookFacts.returnedAt = Date.now()
    firstHookFacts.afterReturn = await canonical(); firstHookFacts.afterReturnObservedAt = Date.now()
    const pending = firstHookFacts.afterReturn?.pendingInteraction
    assert.equal(pending?.request.id, request.id, 'A genuine ACK-known pending window must be observed; absence cannot qualify this fixture')
    assert.equal(pending.response?.acknowledged, true, 'Typed bytes must be ACKed while original native request is still pending')
    assert.equal(pending.nativeCompleted, undefined, 'The measured ACK-only window must precede native completion')
    await progress('typed-first-hook-actual-ACK-known-pending-window')
  }
  const frozen = responseClaims.find(item => item.response.value.requestId === request.id)?.response
  assert.ok(frozen); assert.equal(frozen.inputByteRange.startByte, expectedCursor)
  if (typedFirstHook) for (const claim of responseClaims.filter(item => item.response.value.requestId === request.id)) {
    const { acknowledged: _ack, ...identity } = claim.response, { acknowledged: _frozenAck, ...frozenIdentity } = frozen
    assert.deepEqual(identity, frozenIdentity, 'The same typed response identity and original range must remain frozen through completion')
  }
  const settled = await until('cross-Core answer native completion', async () => {
    const value = await canonical(); return !value?.pendingInteraction && value?.semanticStatus?.state === 'done' && value
  })
  const after = (await client.statusAgent(id)).run
  assert.equal(after.runId, (authority ?? before).runId); assert.equal(after.pid, (authority ?? before).pid)
  assert.equal(after.acceptedInputBytes, frozen.inputByteRange.endByte)
  if (firstHookFacts) {
    const completion = pendingTransitions.find(item => item.expected.pendingInteraction?.request.id === request.id &&
      item.expected.pendingInteraction.response?.acknowledged === true && item.next.pendingInteraction?.request.id !== request.id &&
      item.next.hookReceipt?.eventName === 'PostToolUse' && item.next.hookReceipt.run.runId === initial.run.runId)
    assert.ok(completion, 'The original pending request must settle through actual corresponding native PostToolUse, never ACK alone')
    firstHookFacts.completionTransition = completion; firstHookFacts.settled = settled
    let snapshot
    const throughByte = await client.screenEvidence.wait(client.agentSession(id), after.latestOutputBytes, false, screen => {
      snapshot = screen.snapshot(); return new AgentProviderRegistry().get('codex').inspectPromptExecution(snapshot) === 'idle'
    }, { timeoutMs: 10_000, requireCompleteFrame: true, timeoutMessage: 'Ordinary native empty composer unavailable after exact tool completion', terminalMessage: 'Private Run ended before empty composer observation' })
    firstHookFacts.nativeEmptyComposer = { observedAt: Date.now(), throughByte, snapshot, inspection: 'idle' }
  }
  const nativeBytes = await readFile(settled.nativeHandle.transcriptPath)
  const nativePath = receiptPath + '.typed-response.native.jsonl'; await writeFile(nativePath, nativeBytes)
  const rows = nativeBytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const userRows = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user' && row.payload.content?.some(part => part.text === body))
  const toolRows = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call_output' && row.payload.call_id === 'private_approval_call_2')
  const actualToolReplies = requests.flatMap(value => value.input?.filter(item => item.type === 'function_call_output' && item.call_id === 'private_approval_call_2') ?? [])
  assert.equal(userRows.length, 1); assert.equal(toolRows.length, 1); assert.equal(actualToolReplies.length, 1)
  if (typedFirstHook) assert.equal(toolRows[0].payload.call_id, request.nativeToolCallId)
  assert.ok(toolRows[0].payload.output.includes('PRIVATE_PERMISSION_PROBE'))
  assert.equal(requests.filter(value => textOf(value) === body).length, 2) // setup and the actual tool-output continuation share original user input
  report.phases.push({ phase: typedFirstHook ? 'T008-first-Hook-two-Core-native-typed-response-only' : 'T007-two-Core-native-typed-response-only', passed: true, initialRun: initial.run,
    nativeHandle: settled.nativeHandle, approvalThroughByte, approvalSnapshot, frozen, responseClaims, afterRun: after,
    nativePath, nativeSha256: sha(nativeBytes), userRows, toolRows, actualToolReplies, ...(typedFirstHook ? { firstHookFacts } : {}),
    entryPoint: 'public SDK submitAgentPrompt through second Core; public SDK respondAgentInteraction through original Core' })
  if (typedFirstHook) report.typedResponseFirstHook = { passed: true, qualifiedScope: report.qualifiedScope, fixtureApprovalPaneWaitUsed: false,
    actualAckPendingWindowObserved: true, nativeCompletedAndOrdinaryEmptyComposerObserved: true }
  else report.typedResponseCrossCore = { passed: true, qualifiedScope: report.qualifiedScope, earlyHookReadinessWindowRepaired: false }
  report.passed = true; await progress(typedFirstHook ? 'typed-first-hook-actual-native-consumed-once' : 'typed-cross-core-actual-native-consumed-once')
}
const diagnosticError = error => ({ name: error?.name, message: error?.message, code: error?.code, detail: error?.detail })
async function captureFirstSendDiagnostic(cdp, failure) {
  const capturedAt = Date.now(), value = await canonical()
  const storeBytes = await readFile(store.path), nativeBytes = await readFile(value.nativeHandle.transcriptPath)
  const storeSnapshot = receiptPath + '.first-send.store.json', nativeSnapshot = receiptPath + '.first-send.native.jsonl'
  await writeFile(storeSnapshot, storeBytes); await writeFile(nativeSnapshot, nativeBytes)
  const traces = []
  if (failure) await until('actual first-send invocation has returned its retained error', async () => (await stored(cdp)).agentSteerQueues?.[id]?.some(entry => entry.operationId === report.originalSelection.operationId && entry.error), 5_000)
  for (const name of await readdir(root)) if (/^prepare-calls\.\d+\.jsonl$/.test(name)) {
    const bytes = await readFile(join(root, name)), destination = receiptPath + '.' + name
    await writeFile(destination, bytes); traces.push({ source: join(root, name), destination, sha256: sha(bytes),
      records: bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) })
  }
  const actualRun = (await client.statusAgent(id)).run
  assert.equal(actualRun.runId, value.run.runId)
  const provider = new AgentProviderRegistry().get(value.providerId)
  const originalProviderContext = traces.flatMap(trace => trace.records).filter(record => record.run?.runId === actualRun.runId)
    .flatMap(record => record.events ?? []).find(event => event.stage === 'provider.readPromptExecutionEvidence.call')?.data?.context
  assert.ok(Array.isArray(originalProviderContext?.args) && originalProviderContext.processId === actualRun.pid,
    'Post-failure Provider observation must reuse the actual first-call launch args for this exact Run PID')
  const baseContext = { args: originalProviderContext.args, workspacePath: value.workspacePath,
    ...(value.hostId === 'local' && actualRun.pid !== null ? { processId: actualRun.pid } : {}), nativeHandle: value.nativeHandle }
  const exactPredecessor = value.nativePromptPredecessor?.run.runId === value.run.runId &&
    value.retiredRuns.at(-1)?.runId === value.nativePromptPredecessor.previousRun.runId
  const context = { ...baseContext, ...(exactPredecessor ? { nativePromptPredecessor: value.nativePromptPredecessor } : {}) }
  const observation = async read => { const observedAt = Date.now(); try { return { observedAt, value: await read() } } catch (error) { return { observedAt, error: diagnosticError(error) } } }
  const currentFrame = await observation(async () => {
    await client.refreshAgentSession(id, value.run)
    let snapshot
    const throughByte = await client.screenEvidence.wait(client.agentSession(id), actualRun.latestOutputBytes, false, screen => { snapshot = screen.snapshot(); return true },
      { timeoutMs: 10_000, timeoutMessage: 'Read-only complete current Run frame unavailable', terminalMessage: 'Private Run ended during diagnostic', requireCompleteFrame: true })
    return { throughByte, snapshot, context: provider.inspectPromptExecution(snapshot) }
  })
  const originalEvidence = await observation(() => provider.readPromptExecutionEvidence(baseContext))
  const boundEvidence = await observation(() => provider.readPromptExecutionEvidence(context))
  const transport = await observation(() => provider.verifyPromptExecutionTransport({ ...context,
    ...(boundEvidence.value ? { nativeSourceId: boundEvidence.value.sourceId } : {}) }))
  report.firstSendDiagnostic = { capturedAt, storeSnapshot: { path: storeSnapshot, sha256: sha(storeBytes) }, nativeSnapshot: { path: nativeSnapshot, sha256: sha(nativeBytes) }, failure: diagnosticError(failure),
    boundary: 'Post-failure reads have their own observedAt; only preload events describe the original called preparation path.',
    session: { agentSessionId: value.agentSessionId, run: value.run, nativeHandle: value.nativeHandle,
      nativePromptPredecessor: value.nativePromptPredecessor, retiredRuns: value.retiredRuns,
      hookReceipt: value.hookReceipt, terminalHandshake: value.terminalHandshake,
      terminalPromptReadiness: value.terminalPromptReadiness, promptCompletionAdmission: value.promptCompletionAdmission,
      terminalPromptSubmission: value.terminalPromptSubmission, terminalPromptDelivery: value.terminalPromptDelivery },
    actualRun, exactPredecessor, originalEvidence, boundEvidence, transport, traces,
    rendererOriginal: (await stored(cdp)).agentSteerQueues?.[id], currentFrame }
  assert.ok(traces.some(trace => trace.records.some(record => record.events?.some(event => event.stage === 'coordinator.submitOwnedInputPlan.call'))),
    'First-send diagnostic must capture the actual private Hosted Core owner; an unloaded probe cannot qualify it')
  await progress('A-first-send-read-only-diagnostic-captured')
}
async function killDesktop(value) {
  if (!value) return
  value.cdp.close()
  if (value.child.exitCode === null && value.child.signalCode === null) { const exited = once(value.child, 'exit'); process.kill(-value.child.pid, 'SIGKILL'); await exited }
  value.child.stderr.destroy()
}

try {
  await progress('private-runtime-start')
  const executable = process.env.AGENTMUX_REAL_CODEX_COMMAND ?? 'codex'
  assert.equal((await execute(executable, ['--version'])).stdout.trim(), 'codex-cli 0.160.1')
  report.provider = { command: executable, version: 'codex-cli 0.160.1', nativeApproval: 'actual advertised exec_command + require_escalated', wire: 'local Responses server' }
  const daemonPath = join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
  daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state/ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  daemon.stderr.on('data', bytes => { daemonError += bytes }); daemonClosed = once(daemon, 'close'); void daemonClosed.catch(() => {})
  await Promise.race([once(daemon.stdio[3], 'data'), daemonClosed.then(() => { throw new Error(daemonError) })])
  const args = ['--no-alt-screen', '-s', 'read-only', '-a', 'on-request', '-c', 'model_provider="private_recovery"', '-c', 'model="private-recovery"',
    '-c', 'model_providers.private_recovery.name="Private recovery"', '-c', `model_providers.private_recovery.base_url="http://127.0.0.1:${backend.address().port}/v1"`,
    '-c', 'model_providers.private_recovery.wire_api="responses"', '-c', 'model_providers.private_recovery.requires_openai_auth=false', '-c', 'model_providers.private_recovery.supports_websockets=false',
    '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false', '-c', 'features.memories=false', '-c', 'features.chronicle=false', '-c', 'features.hooks=true', '-c', `projects={"${workspace}"={trust_level="trusted"}}`]
  client = new AgentMuxClient({ store }); await client.connect()
  client.onEvent(event => { if (event.type === 'terminal-output') output += event.data ?? '' })
  const initial = await client.createAgent({ agentSessionId: id, createOperationId: randomUUID(), providerId: 'codex', executorId: 'private-recovery', commandOverride: executable, args,
    workspacePath: workspace, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false, ...(startupFirstSend ? {} : { prompt: 'PRIVATE_INITIAL_SETUP' }), cols: 120, rows: 40 })
  if (startupFirstSend) {
    // Native identity is the prerequisite, not pane/transport readiness. There is no
    // fixture status, source, screen, key or progress-file await before the first submit.
    let nativeIdentityObservedAt
    const identified = await until('first real authenticated native SessionStart identity', async () => {
      const value = await canonical()
      if (!value?.nativeHandle || value.hookReceipt?.lifecycleEvent !== 'session-start') return false
      nativeIdentityObservedAt = Date.now(); return value
    })
    const operationId = randomUUID(), prompt = 'PRIVATE_INITIAL_FIRST_SEND'
    const phase = { phase: 'I-initial-native-first-public-immediate-Send', nativeIdentityObservedAt,
      hookReceipt: identified.hookReceipt, nativeHandle: identified.nativeHandle, run: initial.run, operationId,
      prompt, calledAt: Date.now() }
    report.phases.push(phase)
    await client.submitAgentPrompt({ ...agentPromptCondition(identified), agentSessionId: id, operationId, prompt, execution: 'immediate' })
    phase.returnedAt = Date.now()
    phase.accepted = await nativeAccepted(prompt, operationId)
    phase.emptyComposer = await postSendEmptyNativeComposer(prompt, phase.accepted, phase.calledAt)
    assert.equal(phase.accepted.mode, 'immediate')
    assert.equal(phase.accepted.run.runId, initial.run.runId)
    assert.deepEqual(phase.accepted.nativeHandle, identified.nativeHandle)
    phase.passed = true
    await progress('initial-first-public-immediate-Send-accepted')
  }
  const originalAttachment = await client.reattachAgent(initial.agentSessionId, 0)
  output += originalAttachment.attachment.replay.map(event => event.data ?? '').join('')
  await progress('initial-native-created')
  const original = await until('original durable native handle and done', async () => { const value = await canonical(); return value?.nativeHandle && value.semanticStatus?.state === 'done' && value })
  await progress('initial-native-done')
  if (typedCrossCore) { await proveTypedResponseCrossCore(initial) } else {
  const ownedRun = (await client.statusAgent(id)).run
  assert.equal(ownedRun.runId, original.run.runId); assert.ok(Number.isSafeInteger(ownedRun.pid) && ownedRun.pid > 1)
  const { nativeProcessBirth } = await import('../../../packages/core/dist/agent-native-process.js')
  const originalBirth = await nativeProcessBirth(ownedRun.pid, AbortSignal.timeout(4000))
  assert.ok(originalBirth)
  assert.equal(await nativeProcessBirth(ownedRun.pid, AbortSignal.timeout(4000)), originalBirth)
  // Test-owned external SIGTERM keeps the durable Session eligible for native resume.
  // Core Stop deliberately retires it and would test a different user intent.
  process.kill(ownedRun.pid, 'SIGTERM')
  await until('private original CLI ended without retiring Session', async () => {
    const value = await canonical(), run = (await client.listRuns()).find(item => item.runId === original.run.runId)
    return value?.agentSessionId === id && run?.state === 'exited'
  })
  report.originalProcess = { pid: ownedRun.pid, birth: originalBirth, externalSignal: 'SIGTERM', explicitCoreRetirement: false }
  await progress('original-cli-ended')
  // The old application is gone in the actual recovery scenario. Release its test-owned
  // managed Hook ingress before Desktop becomes the lifecycle owner; a second live owner
  // would correctly refuse native resume and test a different conflict.
  await client.dispose()
  client = undefined
  await progress('original-creator-hook-owner-released')
  // A just-completed Session is legitimately auto-resumed by the one-day startup policy.
  // This private durable checkpoint models unavailable idle age, which must remain on demand.
  // Only that optional age is removed; the actual native identity, done receipt and Inputs stay.
  const { normalizeStoredAgentSession } = await import('../../../packages/core/dist/agent-session-store.js')
  const normalizedChanges = (before, after, path = '') => {
    if (JSON.stringify(before) === JSON.stringify(after)) return []
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [{ path, before, after }]
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key =>
      normalizedChanges(before[key], after[key], path ? path + '.' + key : key))
  }
  const checkpointAttempts = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const checkpoint = await canonical(), observedAt = Date.now()
    assert.equal(checkpoint.agentSessionId, id); assert.deepEqual(checkpoint.run, original.run)
    assert.deepEqual(checkpoint.nativeHandle, original.nativeHandle)
    assert.equal(checkpoint.semanticStatus?.state, 'done')
    assert.equal(report.originalProcess.explicitCoreRetirement, false)
    const { stateEnteredAt, ...unknownAge } = checkpoint.semanticStatus
    const deferredCheckpoint = { ...checkpoint, semanticStatus: unknownAge }
    const storeBytes = await readFile(store.path), nativeBytes = await readFile(checkpoint.nativeHandle.transcriptPath)
    const attemptPath = receiptPath + '.cold-start-attempt-' + attempt
    await writeFile(attemptPath + '.store.json', storeBytes); await writeFile(attemptPath + '.native.jsonl', nativeBytes)
    await writeFile(attemptPath + '.expected.json', JSON.stringify(checkpoint, null, 2))
    await writeFile(attemptPath + '.desired.json', JSON.stringify(deferredCheckpoint, null, 2))
    const record = { attempt, observedAt, snapshotPath: attemptPath, expected: normalizeStoredAgentSession(checkpoint),
      desired: normalizeStoredAgentSession(deferredCheckpoint), storeSha256: sha(storeBytes), nativeSha256: sha(nativeBytes) }
    checkpointAttempts.push(record)
    report.coldStartCheckpoint = { kind: 'test-owned-missing-idle-age', attempts: checkpointAttempts,
      originalStatus: checkpoint.semanticStatus, deferredStatus: unknownAge, preservedRun: checkpoint.run, nativeHandle: checkpoint.nativeHandle,
      boundary: 'Only optional idle age is removed from an exact fresh private snapshot. No queue, interaction, input receipt, ACK or Provider execution fact is seeded.' }
    await progress('cold-start-checkpoint-attempt-' + attempt)
    try {
      await store.compareAndSwap(checkpoint, deferredCheckpoint)
      record.applied = true; break
    } catch (error) {
      record.error = diagnosticError(error)
      const current = await canonical(); record.currentObservedAt = Date.now()
      record.actualNormalizedChanges = normalizedChanges(record.expected, normalizeStoredAgentSession(current))
      await writeFile(attemptPath + '.actual.json', JSON.stringify(current, null, 2))
      await progress('cold-start-checkpoint-attempt-' + attempt + '-rejected')
      if (error.code !== 'STALE_AGENT_SESSION' || attempt === 3) throw error
      // Only this test-owned prelaunch snapshot is reacquired. Every current fact is
      // retained; a changed Session/Run/native identity or non-done state fails above.
    }
  }
  await writeFile(join(workspace, 'neighbor.txt'), 'Original neighboring work survives\n')
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { 'private-recovery': { providerId: 'codex', label: 'Private native', command: executable, args, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false } },
    workspaces: [{ id: workspaceId, name: 'Private native recovery', hostId: 'local', path: workspace, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config))
  const tab = { id: tabId, workspaceId, primaryRegionId: regionId, layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', regionId }, second: { type: 'leaf', regionId: fileId } }, activeRegionId: regionId },
    regions: { [regionId]: { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: id }, [fileId]: { regionId: fileId, kind: 'file', workspaceId, path: 'neighbor.txt' } } }
  const workbench = { tabs: { [tabId]: tab }, layouts: { [workspaceId]: { root: { type: 'leaf', groupId: 'recovery-group' }, groups: [{ id: 'recovery-group', tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: 'recovery-group' } } }
  const adapterPath = join(root, 'spatial-adapter.mjs')
  const built = await createRequire(require.resolve('vite/package.json'))('esbuild').build({ entryPoints: [join(desktop, 'src/renderer/src/lib/desktop-spatial-state.ts')], outfile: adapterPath, bundle: true, platform: 'node', format: 'esm', metafile: true, alias: { '@agentmux/layout': join(repository, 'packages/layout/src/index.ts') }, logLevel: 'silent' })
  assert.ok(Object.keys(built.metafile.inputs).length > 0)
  const { desktopSpatialGraph } = await import(pathToFileURL(adapterPath).href)
  await new AgentMuxSpatialStateStore().commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [], ...workbench, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const seed = { version: 1, state: { activeWorkspaceId: workspaceId, mainSurface: 'workbench', viewModes: { [id]: 'conversation' },
    agentComposerDrafts: { [id]: 'Original draft before recovery' }, agentSteerQueues: {}, restoredWorkbench: workbench } }
  first = await launch('first', seed)
  await first.cdp.evaluate('window.agentmux.sessions.snapshot()')
  await progress('original-desktop-conversation-ready')
  // Desktop has now connected its real RuntimeController. A late SDK observer can share
  // Runtime facts, but cannot preempt the application's Hook ingress during startup.
  client = new AgentMuxClient({ store }); await client.connect()
  client.onEvent(event => { if (event.type === 'terminal-output') output += event.data ?? '' })
  const before = await stored(first.cdp)
  assert.equal(before.viewModes[id], 'conversation')
  assert.equal((await canonical()).run.runId, original.run.runId, 'Cold boot must not restore a stopped CLI before actual Send')
  await draft(first.cdp, 'PRIVATE_RECOVERED_UI_BODY'); const recoveredFirstSendCalledAt = Date.now(); await send(first.cdp)
  const firstIntent = await until('actual UI original recovery operation', async () => (await stored(first.cdp))?.agentSteerQueues?.[id]?.find(entry => entry.text === 'PRIVATE_RECOVERED_UI_BODY'))
  assert.equal(firstIntent.execution, 'immediate'); assert.ok(firstIntent.promptCondition !== undefined)
  report.originalSelection = firstIntent
  await progress('A-original-selection-captured')
  let restored
  try {
    restored = await nativeAccepted('PRIVATE_RECOVERED_UI_BODY', firstIntent.operationId)
    assert.notEqual(restored.run.runId, original.run.runId)
    assert.equal(restored.nativeHandle.sessionId, original.nativeHandle.sessionId)
    assert.equal(restored.mode, 'immediate')
    report.phases.push({ phase: 'A-native-resume-original-UI-Send', passed: true, originalRun: original.run, originalNativeHandle: original.nativeHandle, intent: firstIntent, accepted: restored })
    await progress('A-native-original-selection-accepted')
  } catch (error) {
    if (error.code !== 'PRIVATE_CORE_DELIVERY_UNCONFIRMED') throw error
    restorationFailure = error
    if (startupQualification || finalQualification) throw error
    const current = await canonical(), retained = (await stored(first.cdp)).agentSteerQueues[id].find(entry => entry.operationId === firstIntent.operationId)
    assert.notEqual(current.run.runId, original.run.runId); assert.equal(current.nativeHandle.sessionId, original.nativeHandle.sessionId)
    assert.equal(retained.execution, 'immediate'); assert.ok(retained.promptCondition !== null)
    restored = { run: current.run, nativeHandle: current.nativeHandle }
    report.phases.push({ phase: 'A-native-resume-original-UI-Send', passed: false, originalRun: original.run, intent: retained,
      continuity: restored, unconfirmed: current.terminalPromptDelivery, boundary: 'Original selection is preserved; A did not prove native acceptance. B and C remain separate real cases.' })
    if (diagnosticOnly) { await captureFirstSendDiagnostic(first.cdp, restorationFailure); throw restorationFailure }
    await client.refreshAgentSession(id, current.run)
    try {
      let snapshot
      const throughByte = await client.screenEvidence.wait(client.agentSession(id), 0, false, screen => { snapshot = screen.snapshot(); return true }, { timeoutMs: 10_000,
        timeoutMessage: 'Read-only current Run frame unavailable after A rejection', terminalMessage: 'private Run exited', requireCompleteFrame: true })
      report.phases.at(-1).currentFrame = { throughByte, snapshot, context: new AgentProviderRegistry().get('codex').inspectPromptExecution(snapshot) }
    } catch (observation) { report.phases.at(-1).currentFrameUnavailable = observation.message }
    await progress('A-original-unconfirmed-retained-not-replayed')
  }

  if (diagnosticOnly) { await captureFirstSendDiagnostic(first.cdp); throw new Error('Diagnostic-only A capture completed; B/C are not qualified by this run.') }

  if (startupQualification) {
    report.phases.find(phase => phase.phase === 'A-native-resume-original-UI-Send').emptyComposer = await postSendEmptyNativeComposer('PRIVATE_RECOVERED_UI_BODY', restored, recoveredFirstSendCalledAt)
    assert.equal(report.phases.find(phase => phase.phase === 'A-native-resume-original-UI-Send')?.passed, true)
    if (startupFirstSend) {
      assert.equal(report.phases.find(phase => phase.phase === 'I-initial-native-first-public-immediate-Send')?.passed, true)
      report.startupFirstSend = { passed: true, initialTrigger: 'First Core-owned authenticated SessionStart/nativeHandle',
        restoredTrigger: 'Original GUI Cmd+Enter after on-demand native resume',
        boundary: 'Two actual startup eligibility triggers only; create-return before native identity, permission and Desktop restart remain unqualified.' }
    } else {
      report.startupRestoredFirstSend = { passed: true, trigger: 'Original GUI Cmd+Enter after on-demand native resume',
        boundary: 'Restored first Send only. Genuine PRIVATE_INITIAL_SETUP history is retained; initial blank startup, permission and Desktop restart remain unqualified.' }
    }
    report.passed = true
  } else {
  if (finalQualification) {
    report.phases.find(phase => phase.phase === 'A-native-resume-original-UI-Send').emptyComposer = await postSendEmptyNativeComposer('PRIVATE_RECOVERED_UI_BODY', restored, recoveredFirstSendCalledAt)
    // Observe the real existing Main/Hosted publication. This private listener neither
    // changes product state nor seeds permission/queue facts, and never receives hot bytes.
    await first.cdp.evaluate(`(() => {
      const proof = { events: [], dropped: 0 };
      proof.dispose = window.agentmux.sessions.onEvent(value => {
        if(value.type !== 'core' || value.hostId !== 'local' || value.event.type !== 'agent-session' || value.event.session.agentSessionId !== ${JSON.stringify(id)}) return;
        if(proof.events.length === 200) { proof.dropped++; return; }
        proof.events.push({ observedAt: Date.now(), session: structuredClone(value.event.session) });
      });
      window.__privateRecoveryCompletionProof = proof;
      return true;
    })()`)
  }
  // On the actual recovered Run, an actual native approval request must pause the original UI
  // intent; its actual typed answer, rather than Esc or a GUI flag, is the wake owner.
  await client.refreshAgentSession(id, restored.run)
  const permissionSetup = await sendNativeSetup(first.cdp, 'PRIVATE_PERMISSION_SETUP')
  const permission = await until('actual native PermissionRequest', async () => { const value = await canonical(); return value?.pendingInteraction?.request?.kind === 'permission' && value.pendingInteraction.request })
  await progress('B-real-native-permission')
  assert.equal(permission.evidence.source, 'native-hook')
  await until('actual permission projected into original Renderer', () => first.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="recovery-agent"] [data-pending-interaction] .agent-interaction'))`))
  const cursorBefore = (await client.statusAgent(id)).run.acceptedInputBytes
  assert.ok(Number.isSafeInteger(cursorBefore) && cursorBefore >= 0, 'Native input cursor must be known before proving zero dispatch')
  const { selected: waiting, publicChoice } = await selectWaitingOriginal(first.cdp, 'PRIVATE_WAITING_ORIGINAL_UI_BODY')
  assert.equal(waiting.execution, 'immediate'); assert.equal(waiting.promptCondition, null)
  assert.equal((await client.statusAgent(id)).run.acceptedInputBytes, cursorBefore)
  assert.equal(requests.filter(request => textOf(request).includes(waiting.text)).length, 0)
  const decision = permission.options.find(option => option.kind === (finalQualification ? 'allow-once' : 'reject-once'))
  assert.ok(decision, 'Actual typed native approval must expose its declared decision option')
  const response = { kind: 'permission', requestId: permission.id, decision: { outcome: 'selected', optionId: decision.id } }
  const typedCalledAt = Date.now()
  await first.cdp.evaluate(`window.agentmux.sessions.respondInteraction(${JSON.stringify({ kind: 'agent', hostId: 'local', agentSessionId: id, run: restored.run })},${JSON.stringify(response)})`)
  const typedReturnedAt = Date.now()
  let typedCompletion
  if (finalQualification) {
    typedCompletion = { request: permission, response, typedCalledAt, typedReturnedAt, afterReturn: await canonical() }
    report.guiTypedCompletion = typedCompletion
    const pending = typedCompletion.afterReturn?.pendingInteraction
    assert.equal(pending?.request.id, permission.id, 'Actual GUI typed ACK window must preserve its pending native owner')
    assert.equal(pending.response?.acknowledged, true)
    assert.equal(pending.nativeCompleted, undefined)
    assert.equal(pending.response.value.requestId, permission.id)
    assert.equal(pending.response.value.kind, 'permission')
    assert.equal(pending.response.value.optionId, decision.id)
    assert.equal(pending.response.inputByteRange.startByte, cursorBefore)
    typedCompletion.frozenResponse = structuredClone(pending.response)
    const events = await until('GUI typed pending disappears through actual corresponding PostToolUse', async () => {
      const observed = await first.cdp.evaluate(`({events:window.__privateRecoveryCompletionProof.events,dropped:window.__privateRecoveryCompletionProof.dropped})`)
      assert.equal(observed.dropped, 0)
      const completed = observed.events.find(item => item.session.run.runId === restored.run.runId &&
        item.session.pendingInteraction?.request.id !== permission.id &&
        !item.session.pendingInteraction?.additionalRequests?.some(request => request.id === permission.id) &&
        item.session.hookReceipt?.eventName === 'PostToolUse' && item.session.hookReceipt.run.runId === restored.run.runId)
      return completed && { observedAt: Date.now(), ...observed, completionEvent: completed }
    })
    const claims = events.events.filter(item => item.session.pendingInteraction?.request.id === permission.id && item.session.pendingInteraction.response)
    assert.ok(claims.some(item => item.session.pendingInteraction.response.acknowledged === true))
    const { acknowledged: _ack, ...frozenIdentity } = typedCompletion.frozenResponse
    for (const claim of claims) {
      const { acknowledged: _claimAck, ...identity } = claim.session.pendingInteraction.response
      assert.deepEqual(identity, frozenIdentity)
    }
    typedCompletion.publicMainEvents = events
    const native = await until('actual exact GUI permission Native call outcome', async () => {
      const bytes = await readFile(restored.nativeHandle.transcriptPath)
      const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      const calls = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call' && row.payload.call_id === permission.nativeToolCallId)
      const outcomes = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call_output' && row.payload.call_id === permission.nativeToolCallId)
      assert.ok(calls.length <= 1 && outcomes.length <= 1)
      if (calls.length !== 1 || outcomes.length !== 1) return false
      assert.equal(calls[0].payload.name, 'exec_command')
      assert.equal(JSON.parse(calls[0].payload.arguments).cmd, 'sleep 0.2; printf PRIVATE_PERMISSION_PROBE')
      assert.ok(JSON.stringify(outcomes[0].payload.output).includes('PRIVATE_PERMISSION_PROBE'))
      const path = receiptPath + '.gui-typed-completion.native.jsonl'
      await writeFile(path, bytes)
      return { observedAt: Date.now(), path, sha256: sha(bytes), calls, outcomes }
    })
    typedCompletion.native = native
    const backendCarriers = await until('exact native permission outcome in actual backend history', () => {
      const values = requests.flatMap((value, requestIndex) => (value.input?.filter(item => item.type === 'function_call_output' && item.call_id === permission.nativeToolCallId) ?? [])
        .map(outcome => ({ requestIndex, latestUser: textOf(value), outcome })))
      return values.length && values
    })
    // Subsequent ordinary prompts may carry old tool results as legitimate history.
    // Native execution uniqueness is established by the one actual source outcome above.
    assert.equal(new Set(backendCarriers.map(item => JSON.stringify(item.outcome))).size, 1)
    assert.ok(JSON.stringify(backendCarriers[0].outcome.output).includes('PRIVATE_PERMISSION_PROBE'))
    typedCompletion.backendHistoryCarriers = backendCarriers
  }
  const resumed = await nativeAccepted(waiting.text, waiting.operationId)
  assert.equal(resumed.run.runId, restored.run.runId); assert.equal(resumed.mode, 'immediate')
  report.phases.push({ phase: 'B-native-permission-clear-resumes-original-selection', request: permission, beforeInputBytes: cursorBefore, waiting, publicChoice,
    permissionSetup, ...(typedCompletion ? { typedCompletion } : {}), entryPoint: 'real GUI bare Enter queue -> public message.pending.send exact original -> real typed permission answer', accepted: resumed })
  await progress('B-original-selection-accepted-after-native-answer')

  // A persisted original selection remains inspectable after SIGKILL but receives no automatic
  // license from boot. Establish it with actual Send while the native request is still answerable.
  permissionIssued = false
  await client.refreshAgentSession(id, restored.run)
  const bootSetup = await sendNativeSetup(first.cdp, 'PRIVATE_PERMISSION_SETUP_SECOND')
  const bootPermission = await until('second real permission', async () => { const value = await canonical(); return value?.pendingInteraction?.request?.id !== permission.id && value?.pendingInteraction?.request?.kind === 'permission' && value.pendingInteraction.request })
  const { selected: bootIntent, publicChoice: bootChoice } = await selectWaitingOriginal(first.cdp, 'PRIVATE_PAUSED_AFTER_BOOT')
  assert.equal(bootIntent.execution, 'immediate'); assert.equal(bootIntent.promptCondition, null)
  await draft(first.cdp, 'New unsent draft survives independent Desktop restart')
  const graphBefore = await new AgentMuxSpatialStateStore().read()
  const savedBefore = await until('durable original draft before SIGKILL', async () => { const value = await stored(first.cdp); return value?.agentComposerDrafts?.[id] === 'New unsent draft survives independent Desktop restart' && value })
  const nativeRunBefore = (await client.statusAgent(id)).run
  assert.ok(Number.isSafeInteger(nativeRunBefore.acceptedInputBytes) && nativeRunBefore.acceptedInputBytes >= 0)
  const resumedBirth = await nativeProcessBirth(nativeRunBefore.pid, AbortSignal.timeout(4000)); assert.ok(resumedBirth)
  const firstPid = first.child.pid
  await killDesktop(first); first = undefined
  second = await launch('second')
  assert.notEqual(second.child.pid, firstPid)
  const after = await until('independently restored original queue', async () => { const value = await stored(second.cdp); return value?.agentSteerQueues?.[id]?.some(entry => entry.operationId === bootIntent.operationId && entry.awaitingExplicitSend === true) && value })
  assert.equal(after.viewModes[id], 'conversation')
  assert.equal(after.agentComposerDrafts[id], savedBefore.agentComposerDrafts[id])
  assert.deepEqual(after.agentSteerQueues[id].map(({ awaitingExplicitSend, status, ...entry }) => entry), savedBefore.agentSteerQueues[id].map(({ awaitingExplicitSend, status, ...entry }) => entry))
  assert.deepEqual((await new AgentMuxSpatialStateStore().read()).graph, graphBefore.graph)
  assert.equal((await client.statusAgent(id)).run.acceptedInputBytes, nativeRunBefore.acceptedInputBytes)
  assert.equal((await client.statusAgent(id)).run.pid, nativeRunBefore.pid)
  assert.equal(await nativeProcessBirth(nativeRunBefore.pid, AbortSignal.timeout(4000)), resumedBirth)
  assert.equal((await canonical()).pendingInteraction.request.id, bootPermission.id)
  assert.equal(requests.filter(request => textOf(request).includes(bootIntent.text)).length, 0)
  report.phases.push({ phase: 'C-independent-Desktop-boot-pauses-original-choice', firstPid, secondPid: second.child.pid, intent: bootIntent, publicChoice: bootChoice, beforeRun: nativeRunBefore,
    bootSetup, automaticInputBytes: 0, draft: after.agentComposerDrafts[id], graph: graphBefore, restoredIntent: after.agentSteerQueues[id],
    bootAuthorization: 'awaitingExplicitSend', originalStoredCausePreserved: true,
    storedCauseFieldPresence: after.agentSteerQueues[id].map(entry => ({ operationId: entry.operationId,
      fields: Object.fromEntries(['error', 'errorCode', 'detail', 'controlFailure'].map(key => [key, Object.hasOwn(entry, key)])) })),
    causeBoundary: 'All original stored queue fields are compared. Absent fields do not prove durable structured cause facts.' })
  if (restorationFailure) throw restorationFailure
  report.steerRecovery = { passed: true }; report.passed = true
  if (finalQualification) report.steerRecoveryFinal = { passed: true, scope: 'Fresh complete Main GUI A/B/C only; separate T008 protocol qualification is required', actualNativeCompletionObserved: true, originalPendingResumedOnce: true, restartAutomaticInputBytes: 0 }
  }
  }
} catch (error) {
  failure = error; report.failure = { name: error.name, message: error.message, code: error.code, detail: error.detail, stack: error.stack }
  report.diagnostics = { daemonError, canonical: await canonical().then(value => value && { run: value.run, semanticStatus: value.semanticStatus, pendingInteraction: value.pendingInteraction, nativeHandle: value.nativeHandle, terminalPromptDelivery: value.terminalPromptDelivery, terminalPromptSubmission: value.terminalPromptSubmission }), requestCount: requests.length }
  if (finalQualification && first) report.finalCompletionEvents = await first.cdp.evaluate(`({events:window.__privateRecoveryCompletionProof?.events,dropped:window.__privateRecoveryCompletionProof?.dropped})`).catch(error => ({ unavailable: error.message }))
  if (first) report.diagnostics.renderer = await first.cdp.evaluate(`({queued:JSON.parse(localStorage.getItem('agentmux-workbench-v1'))?.state?.agentSteerQueues?.[${JSON.stringify(id)}],visible:document.querySelector('[data-workbench-region-id="recovery-agent"]')?.innerText})`).catch(error => ({ unavailable: error.message }))
  await captureStartupFailureFacts().catch(error => { report.startupCaptureError = diagnosticError(error) })
  await progress('failed-before-cleanup')
} finally {
  await killDesktop(first); await killDesktop(second)
  // launch may fail before it can return its CDP pair. All children belong to this exact
  // fixture; reap these as well so a failed ready check cannot hold the cleanup open.
  for (const child of electronChildren) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGKILL'); await exited }
    child.stderr.destroy()
  }
  await progress('private-desktops-stopped')
  try { const current = await canonical(); if (current && client) { await client.refreshAgentSession(id, current.run); await client.stopAgent(id, current.run) } } catch (error) { report.cleanupError = error.message }
  await progress('private-native-stopped')
  await typedPeer?.dispose()
  await client?.dispose()
  await progress('private-core-disposed')
  backend.closeAllConnections(); await new Promise(done => backend.close(done))
  if (daemon) { daemon.kill('SIGTERM'); await daemonClosed }
  await writeFile(receiptPath + '.output.bin', output)
  await writeFile(receiptPath + '.requests.json', JSON.stringify(requests, null, 2))
  report.cleanup = { privateDesktopProcessesStopped: true, privateRunStopError: report.cleanupError ?? null, privateDaemonStopped: true }
  await writeFile(receiptPath, JSON.stringify(report, null, 2))
  if (!failure && !report.cleanupError) await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: report.passed, receiptPath, failure: report.failure?.message }))
if (failure || report.cleanupError) process.exitCode = 1

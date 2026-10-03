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
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, agentPromptCondition } from '../../dist/index.js'
import { AgentMuxControlServer } from '../../dist/public-rpc-server.js'
import { readCodexPromptExecutionEvidence } from '../../dist/providers/codex-prompt-execution-evidence.js'
const execute = promisify(execFile), evidence = process.argv[2]
const resumeBoundary = process.argv.includes('--resume-boundary')
const root = await realpath(await mkdtemp(upstreamFixtureDisplayPath("tmp/amux-restored-message-")))
await mkdir(evidence, { recursive: true })
for (const directory of ['runtime', 'durable', 'workspace', 'codex-home']) await mkdir(join(root, directory), { mode: 0o700 })
const oldCommand = process.env.AGENTMUX_TEST_OLD_CODEX_COMMAND
const currentCommand = process.env.AGENTMUX_TEST_CURRENT_CODEX_COMMAND ?? 'codex'
// All endpoints, hooks, native homes and Runs are test-owned. A caller's current
// Agent capability is deliberately absent from the local-user public CLI.
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) delete process.env[name]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json') })
assert(oldCommand, 'Official integrity-bound 0.159.0 intake is required; do not rewrite a new rollout header')
const report = { schema: 'agentmux.restored-message-native.v1', passed: false, root, phases: [], defaults: [] }
const until = async (description, predicate, timeout = 20_000) => {
  const end = Date.now() + timeout
  do { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < end)
  throw new Error('Private restored Native timeout: ' + description)
}
const daemon = spawn(fileURLToPath(new URL('../../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
  ['--socket', join(root, 'runtime/ctxmux.sock'), '--state-dir', join(root, 'durable/ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
const daemonClosed = once(daemon, 'close'); let daemonError = ''; daemon.stderr.on('data', bytes => { daemonError += bytes })
const requests = [], responses = new Set()
const lastText = request => request.input?.filter(item => item.role === 'user').at(-1)?.content?.map(item => item.text ?? '').join('')
const backend = createServer(async (request, response) => {
  let body = ''; for await (const bytes of request) body += bytes
  if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end('{"data":[]}'); return }
  const value = JSON.parse(body), text = lastText(value)
  // Native title generation is a separate model request, not a user turn.
  if (text?.startsWith('Generate a concise, single-line task title')) { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return }
  if (!text?.includes('PRIVATE_')) { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return }
  const index = requests.length; requests.push({ ...value, privateRequestUrl: request.url }); responses.add(response); response.once('close', () => responses.delete(response))
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = item => response.write('event: ' + item.type + '\ndata: ' + JSON.stringify(item) + '\n\n'), id = 'private_response_' + index
  event({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
  if (text.includes('PRIVATE_BUSY_AT_CRASH')) return
  const answer = 'PRIVATE_DONE_' + index, item = { type: 'message', id: 'private_assistant_' + index, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
  event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: answer })
  event({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: answer })
  event({ type: 'response.output_item.done', output_index: 0, item })
  event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } }); response.end()
})
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
const provider = new AgentProviderRegistry().get('codex'), sessions = []
let client, server, current, output = ''
const args = ['--no-alt-screen', '-s', 'read-only', '-a', 'never', '-c', 'model_provider="private_delivery"', '-c', 'model="private-delivery"',
  '-c', 'model_providers.private_delivery.name="Private delivery"', '-c', `model_providers.private_delivery.base_url="http://127.0.0.1:${backend.address().port}/v1"`,
  '-c', 'model_providers.private_delivery.wire_api="responses"', '-c', 'model_providers.private_delivery.requires_openai_auth=false',
  '-c', 'model_providers.private_delivery.supports_websockets=false', '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false',
  '-c', 'features.memories=false', '-c', 'features.chronicle=false', '-c', 'features.hooks=true', '-c', `projects={"${join(root, 'workspace')}"={trust_level="trusted"}}`]
const nativeContext = session => ({ processId: undefined, args, workspacePath: session.workspacePath, nativeHandle: session.nativeHandle })
const screenReady = async session => client.screenEvidence.wait(session, 0, false,
  screen => provider.inspectPromptExecution(screen.snapshot()) === 'idle', { timeoutMs: 20_000, timeoutMessage: 'private native idle composer', terminalMessage: 'private exit', requireCompleteFrame: true })
const cli = async (session, body, execution, operation) => {
  const argv = [fileURLToPath(new URL('../../bin/agentmux', import.meta.url)), '--endpoint', 'unix://' + server.path, 'agent', 'send', '--to-session', session.agentSessionId, '--text', body, '--execution', execution, '--operation-id', operation]
  try { const result = await execute(process.execPath, argv, { env: process.env, timeout: 50_000, maxBuffer: 1024 * 1024 }); return { code: 0, ...result, result: JSON.parse(result.stdout).result } }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
}
const observeDefault = async (session, body, phase) => {
  const before = requests.length, reply = await cli(session, body, 'default', phase)
  assert.equal(reply.code, 0, reply.stderr)
  await until(phase + ' native acceptance', () => requests.length > before && lastText(requests.at(-1)).includes(body))
  await until(phase + ' persisted native end', async () => (await readCodexPromptExecutionEvidence(nativeContext(client.agentSession(session.agentSessionId))))?.state === 'ended')
  await screenReady(client.agentSession(session.agentSessionId))
  const final = client.screenEvidence.evidence.get(session.agentSessionId).evidence.screen.composerText('›')
  const state = client.agentSession(session.agentSessionId)
  report.defaults.push({ phase, body, cliReply: reply.result.delivery, inputAck: state.terminalPromptSubmission?.submit.acknowledged,
    nativeUserAccepted: true, requestIndex: requests.length - 1, finalComposer: final, runId: state.run.runId })
  assert.equal(final, '', 'Byte ACK must be reported separately from an actual empty composer')
}
try {
  await Promise.race([once(daemon.stdio[3], 'data'), daemonClosed.then(() => { throw new Error(daemonError) })])
  report.oldVersion = (await execute(oldCommand, ['--version'])).stdout.trim(); assert.equal(report.oldVersion, 'codex-cli 0.159.0')
  report.currentVersion = (await execute(currentCommand, ['--version'])).stdout.trim(); assert.equal(report.currentVersion, 'codex-cli 0.160.1')
  client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), providers: [provider] }); await client.connect()
  client.onEvent(event => { if (event.type === 'terminal-output') output += event.data ?? '' })
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] }); await server.start()
  current = await client.createAgent({ agentSessionId: 'private-current-default', createOperationId: 'private-current-default-create', providerId: 'codex', executorId: 'codex',
    workspacePath: join(root, 'workspace'), commandOverride: currentCommand, env: { CODEX_HOME: join(root, 'codex-home') }, args,
    prompt: 'PRIVATE_CURRENT_INITIALIZED', injectAgentMuxGuide: false, cols: 120, rows: 40 })
  sessions.push(current.agentSessionId); await client.reattachAgent(current.agentSessionId, 0)
  await until('current initial persisted end', async () => {
    const s = client.agentSession(current.agentSessionId)
    return s.nativeHandle && (await readCodexPromptExecutionEvidence(nativeContext(s)))?.state === 'ended'
  })
  await observeDefault(current, 'PRIVATE_CURRENT_INITIALIZED_DEFAULT', 'current-initialized-default')
  const currentOld = client.agentSession(current.agentSessionId), currentOldRun = (await client.statusAgent(current.agentSessionId)).run
  process.kill(-currentOldRun.pid, 'SIGKILL')
  await until('current default old Run ended', async () => (await client.statusAgent(currentOld.agentSessionId)).run.state !== 'running')
  const currentRestored = await client.ensureAgentContinuity({ agentSessionId: currentOld.agentSessionId, expectedRun: currentOld.run, operationId: 'current-default-recover',
    commandOverride: currentCommand, env: { CODEX_HOME: join(root, 'codex-home') }, args, cols: 120, rows: 40 })
  assert.equal(currentRestored.kind, 'resumed'); current = currentRestored.session
  // Exercise the production SDK immediately upon continuity's return, before
  // waiting for an initialized frame/native end. ACK, native user and composer
  // are distinct observations; this diagnostic never replays unknown input.
  const coldBody = 'PRIVATE_CURRENT_COLD_RESTORED_DEFAULT', coldIndex = requests.length
  let defaultError
  try { await client.submitAgentPrompt({ ...agentPromptCondition(current), agentSessionId: current.agentSessionId,
    operationId: 'current-cold-default', prompt: coldBody, execution: 'default', allowUncertainTurn: true }) } catch (error) { defaultError = { code: error.code, message: error.message } }
  const coldNativeAccepted = await until('cold default native user', () => requests.slice(coldIndex).some(r => lastText(r).includes(coldBody)), 10_000).then(() => true, () => false)
  await screenReady(client.agentSession(current.agentSessionId))
  const coldCurrent = client.agentSession(current.agentSessionId), coldComposer = client.screenEvidence.evidence.get(current.agentSessionId).evidence.screen.composerText('›')
  report.defaults.push({ phase: 'current-cold-restored-default-without-initialized-wait', body: coldBody, inputAck: coldCurrent.terminalPromptSubmission?.submit.acknowledged,
    nativeUserAccepted: coldNativeAccepted, finalComposer: coldComposer, runId: current.run.runId, error: defaultError })
  assert.equal(coldNativeAccepted, true, 'If Native did not accept a byte-ACKed body, report causal evidence before any implementation repair')
  assert.equal(coldComposer, '')
  await client.stopAgent(current.agentSessionId, current.run)
  for (const kind of resumeBoundary ? ['ended', 'working'] : ['ended']) {
    const id = 'private-old-creator-' + kind, index = requests.length
    current = await client.createAgent({ agentSessionId: id, createOperationId: 'private-create-' + kind, providerId: 'codex', executorId: 'codex',
      workspacePath: join(root, 'workspace'), commandOverride: oldCommand, env: { CODEX_HOME: join(root, 'codex-home') }, args,
      prompt: kind === 'working' ? 'PRIVATE_BUSY_AT_CRASH' : 'PRIVATE_INITIAL_DONE', injectAgentMuxGuide: false, cols: 120, rows: 40 })
    sessions.push(id); await client.reattachAgent(id, 0)
    await until('old native starts + authentic hook', () => requests.length > index && client.agentSession(id).nativeHandle?.kind === 'provider')
    if (kind === 'ended') {
      await until('old native persisted end', async () => (await readCodexPromptExecutionEvidence(nativeContext(client.agentSession(id))))?.state === 'ended')
      await observeDefault(current, 'PRIVATE_OLD_ORDINARY', 'old-unsupported-current-default')
    }
    const old = client.agentSession(id), oldRun = (await client.statusAgent(id)).run
    const path = old.nativeHandle.transcriptPath, creator = JSON.parse((await readFile(path, 'utf8')).split('\n')[0])
    assert.equal(creator.payload.cli_version, '0.159.0')
    const oldEvidence = await readCodexPromptExecutionEvidence(nativeContext(old))
    assert.equal(oldEvidence.state, kind === 'working' ? 'working' : 'ended')
    const cursor = oldRun.acceptedInputBytes
    await assert.rejects(provider.verifyPromptExecutionTransport({ ...nativeContext(old), processId: oldRun.pid, nativeSourceId: oldEvidence.sourceId }),
      error => error.code === 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' && error.message.includes('0.159.0'))
    const unsupported = await cli(old, 'PRIVATE_OLD_IMMEDIATE_REFUSED', 'immediate', 'old-immediate-refused-' + kind)
    assert.equal(unsupported.code, 1); assert.equal(JSON.parse(unsupported.stderr).error.detail, 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED')
    assert.equal((await client.statusAgent(id)).run.acceptedInputBytes, cursor)
    report.phases.push({ phase: 'old-current-writer-refused-' + kind, original: oldEvidence, nativeHeaderVersion: creator.payload.cli_version, reply: unsupported })
    // Simulate loss of only the test-owned native process group. Do not call
    // Core.stopAgent: an explicit user retirement must never become auto-resume.
    assert(oldRun.pid > 0); process.kill(-oldRun.pid, 'SIGKILL')
    await until('old private Run ended', async () => (await client.statusAgent(id)).run.state !== 'running')
    const previous = await readFile(path, 'utf8'); await writeFile(join(evidence, kind + '-old-rollout.jsonl'), previous)
    if (kind === 'working') assert.equal((await readCodexPromptExecutionEvidence(nativeContext(old))).state, 'working', 'Crash must not synthesize an aborted/completed native turn')
    const recovered = await client.ensureAgentContinuity({ agentSessionId: id, expectedRun: old.run, operationId: 'private-recover-' + kind,
      commandOverride: currentCommand, env: { CODEX_HOME: join(root, 'codex-home') }, args, cols: 120, rows: 40 })
    assert.equal(recovered.kind, 'resumed'); current = recovered.session
    assert.equal(current.agentSessionId, id); assert.equal(current.nativeHandle.sessionId, old.nativeHandle.sessionId); assert.notEqual(current.run.runId, old.run.runId)
    await screenReady(current)
    const currentRun = (await client.statusAgent(id)).run, context = { ...nativeContext(current), processId: currentRun.pid }
    const evidenceBefore = await readCodexPromptExecutionEvidence(context); context.nativeSourceId = evidenceBefore.sourceId
    const started = performance.now(); assert.equal(await provider.verifyPromptExecutionTransport(context), true)
    const firstProbeMs = performance.now() - started, steady = performance.now(); assert.equal(await provider.verifyPromptExecutionTransport(context), true)
    const steadyProbeMs = performance.now() - steady
    const body = 'PRIVATE_RESTORED_FIRST_' + kind.toUpperCase(), requestBefore = requests.length
    const sent = await cli(current, body, 'immediate', 'restored-first-' + kind)
    report.phases.push({ phase: 'restored-first-' + kind, nativeEvidenceBefore: evidenceBefore, nativeCurrentScreen: 'idle',
      oldRun: old.run, newRun: current.run, nativeSessionId: current.nativeHandle.sessionId, pid: currentRun.pid, firstProbeMs, steadyProbeMs, reply: sent })
    assert.equal(sent.code, 0, sent.stderr)
    await until('first restored owned native input', () => requests.length > requestBefore && lastText(requests.at(-1)).includes(body))
    await until('first restored native Stop', () => client.agentSession(id).hookReceipt?.eventName === 'Stop')
    await screenReady(client.agentSession(id)); assert.equal(client.screenEvidence.evidence.get(id).evidence.screen.composerText('›'), '')
    assert.equal(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]).payload.cli_version, '0.159.0')
    const accepted = client.agentSession(id); assert.equal(accepted.terminalPromptSubmission.prepare.context, 'idle'); assert.equal(accepted.promptCompletionAdmission.intent.execution, 'immediate')
    assert.equal(accepted.terminalPromptSubmission.prepare.interrupt, undefined)
    assert.equal(requests.length, requestBefore + 1)
    await observeDefault(accepted, 'PRIVATE_RESTORED_DEFAULT_' + kind.toUpperCase(), 'restored-default-' + kind)
    const liveCount = requests.length, liveBody = 'PRIVATE_LIVE_CURRENT_' + kind.toUpperCase()
    const live = await cli(client.agentSession(id), liveBody, 'immediate', 'live-old-creator-' + kind); assert.equal(live.code, 0, live.stderr)
    await until('live supported current old-creator accepted', () => requests.length === liveCount + 1 && lastText(requests.at(-1)).includes(liveBody))
    report.phases.push({ phase: 'live-current-old-creator-' + kind, sameRun: (await client.statusAgent(id)).run.runId === current.run.runId, originalHeader: '0.159.0', nativeUserAccepted: true })
    await client.stopAgent(id, current.run)
  }
  report.passed = true
} catch (error) {
  report.failure = { message: error.message, code: error.code, session: current && client?.agentSession(current.agentSessionId),
    requestCount: requests.length, requests: requests.map(r=>({url:r.privateRequestUrl,lastUser:lastText(r)})), lastUser: requests.length ? lastText(requests.at(-1)) : null }
  await writeFile(join(evidence, 'native-failure-output.bin'), output); throw error
} finally {
  const errors = []
  for (const id of sessions) try { const s = client.agentSessions().find(s => s.agentSessionId === id); if (s) await client.stopAgent(id, s.run) } catch (error) { errors.push(error.message) }
  await server?.stop(); await client?.dispose(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve))
  daemon.kill('SIGTERM'); await daemonClosed
  report.cleanup = { privateDaemonStopped: true, privateRunsStopped: errors.length === 0, errors }
  await writeFile(join(evidence, 'native-proof.json'), JSON.stringify(report, null, 2) + '\n')
  if (report.passed && !errors.length) await rm(root, { recursive: true, force: true })
}

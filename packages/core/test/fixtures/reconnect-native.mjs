import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '../../dist/index.js'

const root = process.argv[2]
assert(root?.startsWith('/'), 'A test-owned absolute directory is required')
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) delete process.env[name]
const runtime = join(root, 'runtime'), durable = join(root, 'durable'), workspace = join(root, 'workspace')
for (const directory of [runtime, durable, workspace]) await mkdir(directory, { recursive: true, mode: 0o700 })
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: durable,
  AGENTMUX_AGENT_SESSION_STORE: join(root, 'unused-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
const backend = join(root, 'daemon.sock'), endpoint = join(runtime, 'ctxmux.sock')
const daemon = spawn(fileURLToPath(new URL('../../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
  ['--socket', backend, '--state-dir', join(durable, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
const daemonClosed = once(daemon, 'close'); void daemonClosed.catch(() => {})
let readiness = '', daemonError = '', fault = false, failedNativeExchanges = 0
daemon.stdio[3].on('data', bytes => { readiness += bytes })
daemon.stderr.on('data', bytes => { daemonError += bytes })
const sockets = new Set(), connections = [], states = []
const track = socket => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
  return socket
}
// This proxy neither parses nor edits Native bytes. Its live listener distinguishes
// unavailable protocol observation from a dead endpoint, so Core cannot bootstrap
// a replacement daemon and accidentally "prove" recovery by starting a new owner.
const proxy = createServer({ allowHalfOpen: true }, front => {
  track(front)
  connections.push({ at: Date.now(), fault })
  if (fault) {
    front.once('data', () => { failedNativeExchanges += 1; front.destroy() })
    return
  }
  const back = track(createConnection({ path: backend, allowHalfOpen: true }))
  front.pipe(back); back.pipe(front)
  front.once('close', () => back.destroy())
  // Let pipe/end flush the response before FIN; destroying front on a clean
  // backend close would discard buffered Native receipts (especially Stop).
  back.once('error', () => front.destroy())
})
const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
const wait = async (description, check, timeout = 10000) => {
  const end = Date.now() + timeout
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
  throw new Error('Native reconnect proof timeout: ' + description)
}
let client, run, off, report
let liveOutput = '', inputCursor = 0
try {
  await wait('exact daemon readiness', () => {
    if (daemon.exitCode !== null) throw new Error('Private daemon exited: ' + daemonError)
    return readiness.includes('\n')
  })
  proxy.listen(endpoint); await once(proxy, 'listening')
  client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  off = client.onEvent(event => {
    if (event.type === 'connection-state') states.push({ state: event.state, at: Date.now() })
    if (event.type === 'terminal-output') liveOutput += event.data
  })
  await client.connect()
  const originalIdentity = client.runtimeIdentity(), ready = JSON.parse(readiness.split('\n')[0])
  assert.equal(ready.schema, 'ctxmux.daemon-ready.v1')
  assert.equal(originalIdentity.instanceId, ready.daemon_instance)
  // This is a real generic terminal Run, not a synthetic Provider Session or Level B resume.
  run = await client.createTerminal({ createOperationId: 'reconnect-native-create', workspacePath: workspace,
    command: process.execPath, args: [fileURLToPath(new URL('./run-kernel-workload.mjs', import.meta.url)), 'echo', 'reconnect-native'], cols: 80, rows: 24 })
  const initialAttachment = await client.attachTerminal(run.runId, 0)
  inputCursor = initialAttachment.run.acceptedInputBytes
  assert(Number.isSafeInteger(inputCursor) && inputCursor >= 0, 'Use the attached authoritative Input cursor')
  const write = async label => {
    const data = label + '\n', expectedByte = inputCursor
    const receipt = await client.writeTerminal(run, { ownerInstanceId: originalIdentity.instanceId, operationId: label, expectedByte, data })
    assert.deepEqual(receipt.appliedByteRange, { startByte: expectedByte, endByte: expectedByte + Buffer.byteLength(data) })
    inputCursor = receipt.acceptedThroughByte
    await wait('live output ' + label, () => liveOutput.includes('run-kernel-input:' + label))
  }
  await write('before-outage')
  const beforeRun = (await client.listRuns()).find(item => item.runId === run.runId)
  assert.equal(beforeRun.acceptedInputBytes, inputCursor)
  fault = true
  const outageAt = Date.now()
  for (const socket of sockets) socket.destroy()
  await wait('real connection loss', () => states.some(item => item.state === 'lost'))
  await wait('fast window exhausted into real low-frequency recovery', () => states.some(item => item.state === 'retrying'), 45000)
  const retrying = states.find(item => item.state === 'retrying')
  assert(failedNativeExchanges >= 6, 'The real Native handshake must fail through all six fast attempts')
  assert(retrying.at - outageAt >= 30000, 'The real exponential waits, rather than a test override, must elapse')
  assert(!gone(daemon.pid), 'The original daemon must survive the protocol outage')
  assert(!gone(run.pid), 'The original Run process must survive the protocol outage')
  const restoredEndpointAt = Date.now()
  fault = false
  // No connect(), restart, or input is issued here. Recovery must come from the
  // actual 30-second scheduler after the fast window has already ended.
  await wait('automatic low-frequency recovery', () => states.some(item => item.state === 'restored'), 40000)
  const restored = states.find(item => item.state === 'restored')
  assert(restored.at - retrying.at >= 29000, 'Restoration must be triggered by the real low-frequency timer')
  assert.equal(client.runtimeIdentity().instanceId, originalIdentity.instanceId)
  const restoredRun = (await client.listRuns()).find(item => item.runId === run.runId)
  assert(restoredRun)
  assert.equal(restoredRun.pid, run.pid)
  assert.equal(restoredRun.state, 'running')
  assert.equal(restoredRun.acceptedInputBytes, inputCursor, 'Recovery must not replay or inject input')
  // Terminal consumers explicitly reattach their view; the public Run and ordered
  // byte owner are unchanged. Provider Session automatic attachment has separate tests.
  const attachment = await client.attachTerminal(run.runId, 0)
  const beforeReplay = attachment.replay.map(chunk => chunk.data).join('')
  assert.equal(beforeReplay.split('run-kernel-input:before-outage').length - 1, 1)
  await write('after-low-frequency-recovery')
  const finalAttachment = await client.readRunReplay(run, 0)
  const finalReplay = finalAttachment.replay.map(chunk => chunk.data).join('')
  for (const label of ['before-outage', 'after-low-frequency-recovery']) assert.equal(finalReplay.split('run-kernel-input:' + label).length - 1, 1)
  const finalRun = (await client.listRuns()).find(item => item.runId === run.runId)
  assert.equal(finalRun.acceptedInputBytes, inputCursor)
  report = { schema: 'agentmux.reconnect-native.v1', daemonPid: daemon.pid, runId: run.runId, runPid: run.pid,
    instanceId: originalIdentity.instanceId, endpoint, backend, states, failedNativeExchanges,
    fastWindowMs: retrying.at - outageAt, slowWindowMs: restored.at - retrying.at,
    restoredEndpointAt, acceptedInputBytes: inputCursor, originalOwnerAndRunRetained: true,
    orderedInputAndLiveOutput: true, inputReplayCount: 0, claim: 'generic-terminal-run' }
  await client.stopTerminal(run)
  await wait('exact Run cleanup', () => gone(run.pid))
} finally {
  fault = false
  if (client) { if (run) await client.stopTerminal(run).catch(() => {}); off?.(); await client.dispose().catch(() => {}) }
  for (const socket of sockets) socket.destroy()
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve))
  if (run && !gone(run.pid)) { try { process.kill(-run.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  await Promise.race([daemonClosed, new Promise(resolve => setTimeout(resolve, 3000))])
  if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await daemonClosed }
  assert(gone(daemon.pid), 'The exact test-owned daemon must be gone')
  if (run) assert(gone(run.pid), 'The exact test-owned Run must be gone')
}
if (report) {
  report.exactChildrenGone = true
  await writeFile(join(root, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}

import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '../../dist/index.js'

const execute = promisify(execFile), root = process.argv[2]
assert(root && root.startsWith('/'), 'This fixture requires its test-owned absolute directory')
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) delete process.env[name]
const runtime = join(root, 'runtime'), durable = join(root, 'durable'), workspace = join(root, 'workspace'), storePath = join(root, 'sessions.json')
for (const path of [runtime, durable, workspace]) await mkdir(path, { recursive: true, mode: 0o700 })
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: durable,
  AGENTMUX_AGENT_SESSION_STORE: join(root, 'unused-runtime-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
const daemon = spawn(fileURLToPath(new URL('../../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
  ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(durable, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
const closed = once(daemon, 'close'); void closed.catch(() => {})
let daemonError = '', readiness = ''
daemon.stderr.on('data', bytes => { daemonError += bytes })
daemon.stdio[3].on('data', bytes => { readiness += bytes })
const wait = async (description, check, timeout = 10000) => {
  const end = Date.now() + timeout
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 15)) } while (Date.now() < end)
  throw new Error('Private capacity proof timeout: ' + description)
}
const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
const runs = [], output = new Map(), cursors = new Map(), operations = []
let client, off, writing
try {
  await wait('exact daemon child readiness', () => {
    if (daemon.exitCode !== null) throw new Error('Private daemon exited: ' + daemonError)
    return readiness.includes('\n')
  })
  // The live Run owner uses its own empty semantic projection. Capacity records below
  // are durable identity fixtures, not a claim that these echo programs are Codex Sessions.
  client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  await client.connect()
  const runtimeIdentity = client.runtimeIdentity()
  const readyReceipt = JSON.parse(readiness.split('\n')[0])
  assert.equal(readyReceipt.schema, 'ctxmux.daemon-ready.v1')
  assert.equal(runtimeIdentity.instanceId, readyReceipt.daemon_instance, 'The public Runtime is the exact daemon child that published readiness')
  off = client.onEvent(event => {
    if (event.type === 'terminal-output') output.set(event.run.runId, (output.get(event.run.runId) ?? '') + event.data)
  })
  for (let index = 0; index < 2; index++) {
    const run = await client.createTerminal({ createOperationId: `capacity-create-${index}`, workspacePath: workspace,
      command: process.execPath, args: [fileURLToPath(new URL('./run-kernel-workload.mjs', import.meta.url)), 'echo', `capacity-${index}`], cols: 80, rows: 24 })
    runs.push(run); cursors.set(run.runId, run.acceptedInputBytes)
    const snapshot = await client.attachTerminal(run.runId, 0)
    output.set(run.runId, snapshot.replay.map(chunk => chunk.data).join('') + (output.get(run.runId) ?? ''))
  }
  assert.notEqual(runs[0].runId, runs[1].runId)
  assert.notEqual(runs[0].pid, runs[1].pid)
  const exchange = async phase => {
    for (const [index, run] of runs.entries()) {
      const text = `capacity-${index}-${phase}`, expectedByte = cursors.get(run.runId), data = `${text}\n`
      const receipt = await client.writeTerminal(run, { ownerInstanceId: runtimeIdentity.instanceId,
        operationId: text, expectedByte, data })
      assert.equal(receipt.appliedByteRange.startByte, expectedByte)
      assert.equal(receipt.acceptedThroughByte, expectedByte + Buffer.byteLength(data))
      cursors.set(run.runId, receipt.acceptedThroughByte)
      await wait('ordered echo ' + text, () => (output.get(run.runId) ?? '').includes('run-kernel-input:' + text))
      assert(!(output.get(runs[1 - index].runId) ?? '').includes('run-kernel-input:' + text), 'Another Run received this input')
      operations.push({ runId: run.runId, phase, ...receipt })
    }
  }
  await exchange('before-growth')
  const worker = fileURLToPath(new URL('./session-capacity-worker.mjs', import.meta.url))
  const workerEnv = { ...process.env, AGENTMUX_CAPACITY_RUN_IDS: JSON.stringify(runs.map(run => run.runId)), AGENTMUX_CAPACITY_WORKSPACE: workspace, AGENTMUX_CAPACITY_PUBLIC_READ: '1' }
  let finished = false
  writing = execute(process.execPath, [worker, storePath, 'write'], { env: workerEnv, timeout: 45000, maxBuffer: 2 * 1024 * 1024 }).finally(() => { finished = true })
  void writing.catch(() => {})
  let growthRounds = 0
  while (!finished) { await exchange(`during-growth-${growthRounds++}`); await new Promise(resolve => setTimeout(resolve, 30)) }
  const written = JSON.parse((await writing).stdout.trim())
  assert.equal(written.count, 280)
  assert.equal(written.first.run.runId, runs[0].runId)
  assert.equal(written.last.agentSessionId, 'semantic-279')
  const bytes = (await stat(storePath)).size
  assert(bytes > 1024 * 1024)
  const originalBytes = await readFile(storePath)
  const reread = JSON.parse((await execute(process.execPath, [worker, storePath, 'read'], { env: workerEnv, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim())
  assert.notEqual(reread.pid, written.pid)
  assert.equal(reread.firstRegistered, 'semantic-0')
  assert.deepEqual(reread.first, written.first)
  assert.equal(reread.publicRestoration.count, 280)
  // Public Session receipts deliberately omit ingress credentials; semantic facts must survive intact.
  const { hookBindingId, hookToken, ...publicFirst } = written.first
  assert.deepEqual(reread.publicRestoration.first, publicFirst)
  assert.deepEqual(await readFile(storePath), originalBytes)
  await exchange('after-process-recovery')
  const inventory = await client.listRuns()
  for (const run of runs) assert(inventory.some(item => item.runId === run.runId && item.pid === run.pid && item.state === 'running'))
  const report = { schema: 'agentmux.session-capacity-native.v1', daemonPid: daemon.pid, runtimeIdentity,
    runs: runs.map(run => ({ runId: run.runId, pid: run.pid })), count: reread.count, bytes,
    writerPid: written.pid, readerPid: reread.pid, restoredSessionId: reread.firstRegistered, restoredRunId: reread.first.run.runId,
    publicCoreRestoration: true, growthRounds, operations: operations.length, orderedInputAndIndependentOutput: true }
  for (const run of runs) await client.stopTerminal(run)
  await wait('test-owned Run cleanup', () => runs.every(run => gone(run.pid)))
  report.childrenGone = true
  console.log(JSON.stringify(report))
} finally {
  if (writing) await writing.catch(() => {})
  if (client) {
    for (const run of runs) await client.stopTerminal(run).catch(() => {})
    off?.(); await client.dispose().catch(() => {})
  }
  for (const run of runs) if (!gone(run.pid)) { try { process.kill(-run.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
  if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await closed }
  assert(gone(daemon.pid), 'The exact test-owned daemon must be gone before its directory is removed')
}

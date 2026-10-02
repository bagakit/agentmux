import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = join(root, '.tmp/ctxmux-p22-qualification')
await mkdir(evidence, { recursive: true })
const input = JSON.parse(await readFile(join(evidence, 'input.json'), 'utf8'))
const artifactRoot = join(root, 'packages/core/vendor/ctxmux/darwin-arm64')
const daemonPath = join(artifactRoot, 'bin/ctxmuxd')
const manifest = JSON.parse(await readFile(join(artifactRoot, 'manifest.json'), 'utf8'))
assert.equal(manifest.source.commit, input.sourceCommit)
assert.equal(manifest.product.protocol, 22)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(digest(await readFile(daemonPath)), manifest.binaries.find(item => item.name === 'ctxmuxd').sha256)
const cliVersion = execFileSync(join(artifactRoot, 'bin/ctxmux'), ['--version'], { encoding: 'utf8' }).trim()
assert.match(cliVersion, /protocol 22/u)
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-p22-core-"))
const runtimeDirectory = join(privateRoot, 'runtime'), stateDirectory = join(privateRoot, 'state')
await mkdir(runtimeDirectory, { recursive: true }); await mkdir(stateDirectory, { recursive: true })
for (const key of Object.keys(process.env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key) || key === 'NODE_OPTIONS') delete process.env[key]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: stateDirectory,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') })
const socketPath = join(runtimeDirectory, 'ctxmux.sock')
// Fixture-only public policy: enough to fund two Attachment rings, below this finite Output burst.
const policy = { live_event_bytes: 524288 }
const daemon = spawn(daemonPath, ['--socket', socketPath, '--state-dir', join(stateDirectory, 'ctxmux'),
  '--resource-limits', JSON.stringify(policy), '--readiness-fd', '3'], {
  detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: process.env
})
let readiness = '', spawnError
const stderr = []
daemon.once('error', error => { spawnError = error })
daemon.stdio[3].on('data', data => { readiness += data.toString() })
daemon.stderr.on('data', data => { if (stderr.length < 8) stderr.push(data.toString().slice(0, 1024)) })
const delay = ms => new Promise(done => setTimeout(done, ms))
async function wait(read, label, budget = 15000) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(10) }
  throw new Error(`Private p22 proof timed out: ${label}`)
}
const exited = child => child.exitCode !== null || child.signalCode !== null
const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
let client, failure, report
const ownedRuns = [], gaps = [], outputs = new Map(), ended = []
const liveCursors = new Map(), gappedRuns = new Set()
let slowReadPauseCount = 0
try {
  await wait(() => { if (spawnError) throw spawnError; if (exited(daemon)) throw new Error(`Private daemon startup failed: ${stderr.join('')}`); return readiness.includes('\n') }, 'native readiness')
  const ready = JSON.parse(readiness.split('\n')[0]); assert.equal(ready.schema, 'ctxmux.daemon-ready.v1')
  const { AgentMuxClient, AgentMuxMemoryAgentSessionStore } = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href)
  client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() }); await client.connect()
  const native = await client.runtimeDiagnostics()
  const { CtxmuxClient } = await import(pathToFileURL(join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
  const sdk = new CtxmuxClient({ socketPath }); const nativeIdentity = await sdk.runtimeInfo()
  assert.equal(nativeIdentity.daemonInstanceId, ready.daemon_instance)
  assert.equal(native.ctxmux.serving.protocolVersion, 22)
  assert.equal(native.ctxmux.bundled.sourceCommit, input.sourceCommit)
  assert.equal(native.ctxmux.serving.instanceId, nativeIdentity.daemonInstanceId)
  // The serving contract does not claim source provenance. Its exact spawned image is separately hash-bound above.
  assert.equal(native.ctxmux.serving.sourceCommit, null)
  client.onEvent(event => {
    if (event.type === 'terminal-output') {
      assert.equal(event.dataBytes.byteLength, event.evidence.outputByteRange.endByte - event.evidence.outputByteRange.startByte)
      if (!gappedRuns.has(event.run.runId) && liveCursors.has(event.run.runId)) assert.equal(event.evidence.outputByteRange.startByte, liveCursors.get(event.run.runId))
      liveCursors.set(event.run.runId, event.evidence.outputByteRange.endByte)
      const pieces = outputs.get(event.run.runId) ?? []; pieces.push(event); outputs.set(event.run.runId, pieces)
      if (event.run.runId === ownedRuns[0]?.runId && event.data.startsWith('BBBB') && slowReadPauseCount === 0) {
        slowReadPauseCount++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
      }
    } else if (event.type === 'agent-error' && event.code === 'OUTPUT_GAP') { gaps.push(event); gappedRuns.add(event.evidence.run?.runId) }
    else if (event.type === 'process-state' && event.state !== 'running') ended.push(event)
  })
  const workload = join(privateRoot, 'finite-burst.mjs')
  await writeFile(workload, `import readline from 'node:readline';\nconst name=process.argv[2];\nprocess.stdout.write('P22_READY:'+name+'\\n');\nfor await(const line of readline.createInterface({input:process.stdin})){if(line==='burst'){process.stdout.write(Buffer.alloc(2*1024*1024,66));process.stdout.write('\\nP22_BURST_DONE\\n')}else if(line==='quit'){process.exit(0)}else process.stdout.write(name+':'+line+'\\n')}\n`)
  for (const name of ['A', 'B']) {
    const run = await client.createTerminal({ createOperationId: `p22-native-${name}`, workspacePath: privateRoot,
      command: process.execPath, args: [workload, name] }); assert.ok(run.pid); ownedRuns.push(run)
    await wait(async () => (await client.readRunReplay(run, 0)).replay.some(chunk => chunk.data.includes(`P22_READY:${name}`)), `${name} original output`)
    const attached = await client.attachTerminal(run.runId, 0, 'raw'); assert.equal(attached.run.pid, run.pid)
    const chunks = attached.replay
    assert.ok(chunks.length > 0)
    let cursor = 0; for (const chunk of chunks) { assert.equal(chunk.startByte, cursor); cursor = chunk.endByte }
    assert.equal(cursor, attached.run.latestOutputBytes); liveCursors.set(run.runId, cursor)
  }
  const [a, b] = ownedRuns
  const write = async (run, operationId, expectedByte, data) => {
    const result = await client.writeTerminal(run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId, expectedByte, data })
    assert.deepEqual(result.appliedByteRange, { startByte: expectedByte, endByte: expectedByte + Buffer.byteLength(data) })
    assert.equal(result.acceptedThroughByte, expectedByte + Buffer.byteLength(data)); return result
  }
  const aInput = await write(a, 'p22-a-input', 0, 'initial\n')
  const bInput = await write(b, 'p22-b-input', 0, 'healthy\n')
  await wait(() => outputs.get(a.runId)?.some(event => event.data.includes('A:initial')), 'A real live response')
  await wait(() => outputs.get(b.runId)?.some(event => event.data.includes('B:healthy')), 'B real live response')
  const burst = await write(a, 'p22-finite-burst', aInput.acceptedThroughByte, 'burst\n')
  const gapEvent = await wait(() => gaps.find(event => event.evidence.run?.runId === a.runId), 'actual public Core Gap')
  const gap = gapEvent.evidence.outputGap
  assert.equal(gap.kind, 'live-stream')
  assert.equal(gap.observation.runId, a.runId)
  assert.equal(gap.observation.runtime.daemonInstanceId, native.ctxmux.serving.instanceId)
  assert.equal(gap.observation.runtime.runtimeId, nativeIdentity.runtimeId)
  assert.equal(gap.observation.origins.daemon, true)
  assert.equal(gap.observation.missingOutputBytes, null)
  assert.ok(Object.values(gap.causes).some(Boolean))
  assert.ok(gap.observation.recoveryAfterByte < gap.latestOutputBytes)
  await wait(async () => (await client.readRunReplay(a, 0)).replay.some(chunk => chunk.data.includes('P22_BURST_DONE')), 'finite burst retained Replay')
  const full = await client.readRunReplay(a, 0, 'raw')
  assert.equal(full.gap, null, 'finite Output remains below unchanged original retention')
  const fullBytes = Buffer.concat(full.replay.map(chunk => Buffer.from(chunk.dataBytes)))
  assert.equal(fullBytes.length, full.run.latestOutputBytes)
  const recoveryAfterByte = gap.observation.recoveryAfterByte
  await client.releaseRunAttachment(a)
  const recovered = await client.attachTerminal(a.runId, recoveryAfterByte, 'raw')
  assert.equal(recovered.gap, null); assert.equal(recovered.run.pid, a.pid)
  let cursor = recoveryAfterByte
  for (const chunk of recovered.replay) { assert.equal(chunk.startByte, cursor); cursor = chunk.endByte }
  assert.equal(cursor, full.run.latestOutputBytes)
  assert.deepEqual(Buffer.concat(recovered.replay.map(chunk => Buffer.from(chunk.dataBytes))), fullBytes.subarray(recoveryAfterByte))
  assert.equal(ended.length, 0, 'Gap must not invent child exit')
  // Release the large event ring before the small fresh controls; this is explicit reader recovery, not Input replay.
  await client.releaseRunAttachment(a)
  await client.attachTerminal(a.runId, full.run.latestOutputBytes, 'raw')
  const afterA = await write(a, 'p22-a-after-gap', burst.acceptedThroughByte, 'still-live\n')
  const afterB = await write(b, 'p22-b-after-gap', bInput.acceptedThroughByte, 'still-healthy\n')
  await wait(() => outputs.get(a.runId)?.some(event => event.data.includes('A:still-live')), 'A live after Gap')
  await wait(() => outputs.get(b.runId)?.some(event => event.data.includes('B:still-healthy')), 'B live after Gap')
  for (const run of ownedRuns) { const current = (await client.readRunReplay(run, 0)).run; assert.equal(current.pid, run.pid); assert.equal(current.state, 'running'); assert.equal(current.nativeService.owner.type, 'serving') }
  report = { passed: true, userRuntimeTouched: false, protocol: 22, sourceCommit: input.sourceCommit,
    cliVersion, privateRoot, daemonPid: daemon.pid, policy, nativeIdentity,
    serving: native.ctxmux.serving, nativeExecutableSha256: digest(await readFile(daemonPath)),
    runs: ownedRuns.map(run => ({ runId: run.runId, pid: run.pid })), gap: gapEvent,
    gapCount: gaps.length, slowReadPauseCount, exactReplay: { recoveryAfterByte, throughByte: cursor, bytes: fullBytes.length, sha256: digest(fullBytes) },
    orderedLiveBeforeGap: true, inputReceipts: [aInput, bInput, burst, afterA, afterB], liveEvents: [...outputs.values()].reduce((n, items) => n + items.length, 0) }
} catch (error) { failure = error }
const cleanupErrors = []
if (client) {
  for (const run of ownedRuns) {
    try { const current = (await client.readRunReplay(run, 0)).run; assert.equal(current.pid, run.pid); await client.stopTerminal(run) }
    catch (error) { cleanupErrors.push(error) }
  }
  try { await client.dispose() } catch (error) { cleanupErrors.push(error) }
}
try {
  if (!exited(daemon)) daemon.kill('SIGTERM')
  await wait(() => exited(daemon), 'private daemon exit', 5000)
} catch (error) { cleanupErrors.push(error) }
for (const run of ownedRuns) {
  try { await wait(() => gone(run.pid), 'owned child exit', 5000) } catch (error) { cleanupErrors.push(error) }
}
if (cleanupErrors.length === 0) await rm(privateRoot, { recursive: true, force: true })
const cleanupFailure = cleanupErrors.length ? new AggregateError(cleanupErrors, 'Exact private cleanup unconfirmed') : undefined
const receipt = { ...(report ?? { passed: false, userRuntimeTouched: false, protocol: 22, sourceCommit: input.sourceCommit }),
  cleanup: { rootRemoved: !cleanupFailure, remaining: cleanupFailure ? [String(cleanupFailure)] : [] },
  ...(failure ? { error: failure.stack } : {}) }
await writeFile(join(evidence, 'core-gap-runtime.json'), JSON.stringify(receipt, null, 2) + '\n')
if (failure || cleanupFailure) throw new AggregateError([failure, cleanupFailure].filter(Boolean), 'Private p22 Core proof failed')
console.log('Actual p22 Core Gap, Input, ordered Live/Replay and exact private cleanup passed.')

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRemoteDesktopProof } from './remote-runtime-native-proof.mjs'
import { desktopInput, importInstalledCore, installSdkConsumer, ownerControl, readFarmInput, repositoryRoot, ssh, target, writeReceipt } from './remote-runtime-farm-proof.mjs'

const input = await readFarmInput()
const evidence = path.join(repositoryRoot, '.tmp/remote-terminal-reading', ("run-" + (globalThis.crypto.randomUUID()) + ""))
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-farm-reading-'))
const receipt = { schema: 'agentmux.remote-terminal-reading-proof.v1', passed: false, transport: 'ssh',
  packageIdentity: input.packageIdentity, phases: [], noise: [], cleanup: {},
  limitations: ['A live private terminal and a real native Agent share the original remote semantic owner.',
    'Trusted Chromium wheel/key input; no physical trackpad latency or infinite terminal retention is claimed.'] }
const runs = [], events = []
let consumer, client, main, unsubscribe, noise = [], ownerStopped = false
const stopped = new Set()
const wait = async (label, read) => {
  const deadline = Date.now() + 30000
  do { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)) } while (Date.now() < deadline)
  throw Error(`Remote terminal observation timed out: ${label}`)
}
const producer = String.raw`
process.stdin.setRawMode(true); process.stdin.resume();
let first = '';
for(let i=0;i<4000;i++){const head='FARM_ROW_'+String(i).padStart(4,'0');first+=head+'x'.repeat(78-head.length)+'\r\n';}
process.stdout.write(first);
process.stdin.on('data', data=>{
  if(data.includes(112))process.stdout.write('FARM_TERMINAL_INPUT\r\n');
});
process.on('SIGUSR2',()=>process.stdout.write('FARM_OFFLINE_TAIL\r\n'));
`
const noiseProducer = String.raw`setInterval(()=>process.stdout.write('UNRELATED_BYTE_ONLY\r\n'),50);process.stdin.resume();`
try {
  await fs.mkdir(evidence, { recursive: true })
  consumer = await installSdkConsumer(input, evidence)
  const { connectSshAgentMux } = await importInstalledCore(consumer)
  client = await connectSshAgentMux({ target: target(input), expectedRuntimeId: input.expectedRuntimeId })
  const agent = await client.statusAgent(input.agentSessionId)
  assert.deepEqual([agent.run.runId, agent.run.pid, agent.session.nativeHandle], [input.runId, input.pid, input.nativeHandle])
  main = await client.createTerminal({ createOperationId: `farm-reading-${Date.now()}`, workspacePath: input.remoteWorkspace,
    command: input.nodePath, args: ['--input-type=module', '-e', producer], cols: 180, rows: 35 })
  runs.push(main)
  unsubscribe = client.onEvent(event => { if (event.type === 'terminal-output') events.push({ runId: event.run.runId, bytes: event.dataBytes.byteLength }) })
  const replay = await wait('large original VT output', async () => {
    const value = await client.readRunReplay(main, 0, 'terminal')
    return value.run.latestOutputBytes >= 320000 ? value : null
  })
  assert.equal(replay.run.state, 'running'); assert.equal(replay.run.pid, main.pid)
  assert.ok(replay.run.latestOutputBytes > 256 * 1024, 'The actual transfer exceeds a single JSON-RPC frame')
  const raw = await client.readRunReplay(main, 0, 'raw')
  assert.ok(raw.replay.length > 0, 'An actual remote consumer reads the original ordered bytes')
  const rawBytes = Buffer.concat(raw.replay.map(event => Buffer.from(event.dataBytes)))
  assert.ok(rawBytes.byteLength > 256 * 1024, 'Original ordered bytes cross the JSON-RPC frame boundary')
  assert.ok(rawBytes.includes(Buffer.from('FARM_ROW_0000')) && rawBytes.includes(Buffer.from('FARM_ROW_3999')),
    'The actual raw consumer receives both ends of the original history')
  const original = await client.attachTerminal(main.runId, 0, 'terminal')
  assert.equal(original.terminal.type, 'basic-vt', 'Terminal consumers restore the native checkpoint')
  assert.ok(original.terminal.restoreBytes.byteLength > 0, 'The actual VT checkpoint contains restoration bytes')
  assert.equal(original.terminal.checkpoint.runId, main.runId)
  assert.ok(original.terminal.checkpoint.throughByte > 0 &&
    original.terminal.checkpoint.throughByte <= original.run.latestOutputBytes)
  const terminalBytes = Buffer.concat([Buffer.from(original.terminal.restoreBytes),
    ...original.replay.map(event => Buffer.from(event.dataBytes))])
  assert.ok(terminalBytes.includes(Buffer.from('FARM_ROW_0000')) && terminalBytes.includes(Buffer.from('FARM_ROW_3999')),
    'The actual VT checkpoint and its ordered tail retain both ends of the original history')
  receipt.original = { run: original.run,
    rawBytes: rawBytes.byteLength,
    checkpoint: { ...original.terminal.checkpoint, restoreBytes: original.terminal.restoreBytes.byteLength },
    rawReplayRanges: raw.replay.map(event => ({ startByte: event.startByte, endByte: event.endByte, bytes: event.dataBytes.byteLength })),
    replayRanges: original.replay.map(event => ({ startByte: event.startByte, endByte: event.endByte, bytes: event.dataBytes.byteLength })) }
  const nativeInput = desktopInput(input)
  nativeInput.terminalReading = { sessionId: main.runId, runId: main.runId, pid: main.pid,
    tabId: 'farm-terminal-tab', regionId: 'farm-terminal-region', workspaceId: nativeInput.identity.workspaceId,
    firstMarker: 'FARM_ROW_0000', lastMarker: 'FARM_ROW_3999', inputMarker: 'FARM_TERMINAL_INPUT', inputText: 'p',
    offlineText: 'e', offlineMarker: 'FARM_OFFLINE_TAIL' }
  receipt.desktop = await runRemoteDesktopProof({ privateRoot, evidence: path.join(evidence, 'desktop'), input: nativeInput,
    ownerCommand: async operation => {
      if (operation === 'terminal-noise-start') {
        assert.equal(noise.length, 0)
        const before = events.length
        for (let i = 0; i < 7; i++) {
          const run = await client.createTerminal({ createOperationId: `farm-unrelated-${Date.now()}-${i}`, workspacePath: input.remoteWorkspace,
            command: input.nodePath, args: ['--input-type=module', '-e', noiseProducer] })
          runs.push(run); noise.push(run)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
        const observed = await client.listRuns()
        const output = events.slice(before)
        assert.equal(output.filter(event => noise.some(run => run.runId === event.runId)).length, 0,
          'Unattached Runs must not deliver irrelevant bytes to this consumer')
        const work = noise.map(run => observed.find(item => item.runId === run.runId))
        assert.equal(work.length, 7); assert.ok(work.every(run => run && run.state === 'running' && run.latestOutputBytes > 0))
        const fact = { unrelated: work.map(run => ({ runId: run.runId, pid: run.pid, outputBytes: run.latestOutputBytes })), unrelatedByteDeliveries: 0 }
        receipt.noise.push(fact); return fact
      }
      if (operation === 'terminal-noise-stop') {
        for (const run of noise) { await client.stopTerminal(run); stopped.add(run.runId) }
        noise = []; return { stopped: true }
      }
      if (operation === 'stop') ownerStopped = true
      const value = await ownerControl(input, operation, [main.pid])
      if (operation === 'restart') ownerStopped = false
      if (operation === 'stop') {
        // The semantic owner has exited and both native Run PIDs were rechecked. Only then
        // trigger output in this proof's own producer; delivery must replay across the outage.
        await ssh(input, [input.nodePath, '-e', "process.kill(Number(process.argv[1]), 'SIGUSR2')", String(main.pid)])
        return { ...value, offlineOutputTrigger: { pid: main.pid, signal: 'SIGUSR2', afterOwnerShutdown: true } }
      }
      return value
    } })
  assert.equal(receipt.noise.length, 2, 'Both ordinary Desktop phases exercise seven actual unrelated Runs')
  const after = (await client.listRuns()).find(run => run.runId === main.runId)
  assert.ok(after); assert.equal(after.pid, main.pid); assert.equal(after.state, 'running')
  const originalAgent = await client.statusAgent(input.agentSessionId)
  assert.deepEqual([originalAgent.run.runId, originalAgent.run.pid, originalAgent.session.nativeHandle], [input.runId, input.pid, input.nativeHandle])
  receipt.surviving = { terminal: after, agent: originalAgent.session, owner: client.runtimeOwnerIdentity() }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  if (ownerStopped) {
    try { await ownerControl(input, 'restart'); ownerStopped = false }
    catch (error) { errors.push(`Private semantic owner recovery: ${error.message}`) }
  }
  for (const run of runs) {
    if (stopped.has(run.runId)) continue
    try { await client.stopTerminal(run); stopped.add(run.runId) }
    catch (error) { errors.push(`Stopping test Run ${run.runId}: ${error.message}`) }
  }
  try { if (main) await client.releaseRunAttachment(main) }
  catch (error) { errors.push(`Releasing test reader: ${error.message}`) }
  unsubscribe?.()
  try { await client?.dispose(); if (consumer) await fs.rm(consumer.root, { recursive: true, force: true }); await fs.rm(privateRoot, { recursive: true, force: true }) }
  catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, stoppedTestRunIds: [...stopped], retainedOriginalAgent: input.agentSessionId,
    retainedRemoteScope: input.scopeRoot }
  await writeReceipt(evidence, receipt)
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json') }))

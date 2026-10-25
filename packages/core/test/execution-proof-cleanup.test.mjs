import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionProofCleanup } from '../scripts/fixtures/execution-proof-cleanup.mjs'

async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'amx-cleanup-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const owner = { name: 'exact-test-owner', base: root, sessions: [], runs: [], client: {
    stopAgent: async (...args) => calls.push(['agent', ...args]), stopTerminal: async ref => calls.push(['terminal', ref]),
    dispose: async () => calls.push(['client-dispose']),
  }, rpc: { dispose: async () => calls.push(['rpc-dispose']) } }
  return { root, owner, calls, cleanup: createExecutionProofCleanup(root, options), receipt: async () => JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8')) }
}
const session = (agentSessionId, runId) => ({ agentSessionId, run: { runId } })

test('stops only the latest recorded Run of each original SID, deduplicates exact helper Runs and records owner facts', async t => {
  const f = await fixture(t)
  f.owner.sessions = [session('one', 'old'), session('other', 'other-run'), session('one', 'resumed')]
  f.owner.runs = ['helper', 'helper']
  await assert.doesNotReject(f.cleanup.finish([f.owner]))
  assert.deepEqual(f.calls.filter(call => call[0] === 'agent'), [['agent', 'one', { runId: 'resumed' }], ['agent', 'other', { runId: 'other-run' }]])
  assert.deepEqual(f.calls.filter(call => call[0] === 'terminal'), [['terminal', { runId: 'helper' }]])
  const receipt = await f.receipt()
  assert.equal(receipt.passed, true); assert.deepEqual(receipt.errors, [])
  assert(receipt.records.every(record => record.owner === f.owner.name && record.ownerRoot === f.root && record.state === 'completed'))
})

test('waits for actual close, not exit or a successful signal request', async t => {
  const f = await fixture(t), child = new EventEmitter()
  child.pid = 101; child.exitCode = null; child.signalCode = null
  let signalled
  const killed = new Promise(resolve => { signalled = resolve })
  child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal); signalled(); return true }
  f.cleanup.trackChild(f.owner, 'core', child)
  let completed = false
  const finish = assert.doesNotReject(f.cleanup.finish([f.owner])).then(() => { completed = true })
  await killed; await Promise.resolve()
  assert.equal(completed, false)
  child.emit('close', null, 'SIGTERM'); await finish
  assert.equal(completed, true)
  assert.deepEqual((await f.receipt()).records.find(record => record.kind === 'child'), {
    kind: 'child', owner: f.owner.name, ownerRoot: f.root, lane: 'core', childPid: 101,
    closed: true, exitCode: null, signal: 'SIGTERM', errors: [], signalRequested: 'SIGTERM',
  })
})

test('retains the exact primary failure while recording every teardown failure and continuing cleanup', async t => {
  const f = await fixture(t), original = new Error('business assertion failed')
  f.owner.sessions = [session('same', 'last')]
  f.owner.client.stopAgent = async () => { throw new Error('stop reply lost') }
  f.owner.client.dispose = async () => { throw new Error('dispose failed') }
  await f.cleanup.step({ action: 'extra-teardown' }, () => { throw new Error('extra failed') })
  await assert.rejects(f.cleanup.finish([f.owner], { failed: true, error: original }), error => error === original)
  const receipt = await f.receipt()
  assert.equal(receipt.passed, false); assert.equal(receipt.primaryFailure.message, original.message)
  assert.deepEqual(receipt.errors.map(error => error.action), ['extra-teardown', 'stop-agent', 'dispose-client'])
  assert(f.calls.some(call => call[0] === 'rpc-dispose'))
})

test('an unclosed registered child is unknown and cannot certify cleanup', async t => {
  const f = await fixture(t, { timeoutMs: 10 }), child = new EventEmitter()
  child.pid = 102; child.exitCode = 0; child.signalCode = null
  child.kill = () => { throw new Error('Do not signal an exited process') }
  f.cleanup.trackChild(f.owner, 'core', child)
  await assert.rejects(f.cleanup.finish([f.owner]), /cleanup is unconfirmed/)
  const receipt = await f.receipt()
  assert.equal(receipt.passed, false); assert.equal(receipt.records.find(record => record.kind === 'child').closed, false)
  assert.equal(receipt.errors[0].action, 'close-child')
})

test('registers a real child at spawn and confirms its own close before success', async t => {
  const f = await fixture(t)
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
  f.cleanup.trackChild(f.owner, 'core', child)
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  await once(child.stdout, 'data')
  await assert.doesNotReject(f.cleanup.finish([f.owner]))
  const receipt = await f.receipt(), result = receipt.records.find(record => record.kind === 'child')
  assert.equal(receipt.passed, true); assert.equal(result.childPid, child.pid); assert.equal(result.closed, true); assert.equal(result.signal, 'SIGTERM')
})

test('keeps already closed earlier Core instances in the same exact owner receipt without resignalling', async t => {
  const f = await fixture(t), child = new EventEmitter()
  child.pid = 103; child.exitCode = null; child.signalCode = null
  child.kill = () => { throw new Error('Original exited Core must not be signalled') }
  f.cleanup.trackChild(f.owner, 'core', child); f.cleanup.trackChild(f.owner, 'core', child)
  child.exitCode = 0; child.emit('close', 0, null)
  await assert.doesNotReject(f.cleanup.finish([f.owner]))
  assert.equal((await f.receipt()).records.filter(record => record.kind === 'child').length, 1)
})

test('a cleanup failure exits a real proof process nonzero before its success stdout', async t => {
  const f = await fixture(t)
  const module = new URL('../scripts/fixtures/execution-proof-cleanup.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createExecutionProofCleanup} from ${JSON.stringify(module)};
    const cleanup=createExecutionProofCleanup(${JSON.stringify(f.root)});
    await cleanup.step({action:'test-owned-stop'},()=>{throw new Error('lost stop reply')});
    await cleanup.finish([]);console.log(JSON.stringify({passed:true}));`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.resume()
  const [code, signal] = await once(child, 'close')
  assert.notEqual(code, 0); assert.equal(signal, null); assert.equal(stdout, '')
  assert.equal((await f.receipt()).passed, false)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nativeProcessBirth } from '../dist/agent-native-process.js'
import { alive, exited, registerChild, settleExactProcess, signalChild, terminate } from '../scripts/fixtures/a2a-agent-behavior/process.mjs'
import { cleanupPrivateProofScope } from '../scripts/lib/a2a-private-model-proof.mjs'

const coreRoot = fileURLToPath(new URL('../', import.meta.url)), darwin = process.platform === 'darwin'
const kernelIdentity = async pid => ({ pid, birth: await nativeProcessBirth(pid, AbortSignal.timeout(4000)) })
const readyProgram = 'process.on("SIGTERM",()=>{console.log("term")});console.log("ready");setInterval(()=>{},1000)'
async function privateChild(program = 'console.log("ready");setInterval(()=>{},1000)') {
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] })
  const original = registerChild(child, nativeProcessBirth)
  const output = []; child.stdout.on('data', bytes => output.push(bytes.toString()))
  await once(child.stdout, 'data')
  return { child, original: await original, output, async close() {
    if (child.exitCode === null && child.signalCode === null) await signalChild(child, 'SIGKILL')
    assert.equal(await exited(child, 5000), true)
  } }
}
async function scope() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-private-process-'))), privateRoot = join(root, 'private'), evidence = join(root, 'evidence')
  await mkdir(privateRoot); await mkdir(evidence)
  return { root, privateRoot, evidence, ownership: { daemonProcess: null, modelReceipts: [], peerReceipts: [] }, errors: [], nativeProcessBirth }
}
const absent = path => stat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })

test('rejects bare, empty and birthless identities without taking a live process as authority', { skip: !darwin }, async () => {
  const owned = await privateChild(readyProgram)
  try {
    for (const original of [owned.child.pid, {}, { pid: owned.child.pid }]) await assert.rejects(settleExactProcess(original, nativeProcessBirth), /incomplete/u)
    assert.equal(alive(owned.child.pid), true); assert.equal(owned.output.join('').includes('term'), false)
  } finally { await owned.close() }
})

test('terminates the registered original child and recognizes its authoritative exit', { skip: !darwin }, async () => {
  const owned = await privateChild()
  try {
    assert.deepEqual(await kernelIdentity(owned.child.pid), owned.original)
    assert.equal((await terminate(owned.child)).exited, true)
    assert.equal((await settleExactProcess(owned.original, nativeProcessBirth)).exited, true)
  } finally { await owned.close() }
})

test('wrong birth and unavailable observation never send TERM to the live child', { skip: !darwin }, async () => {
  const owned = await privateChild(readyProgram)
  try {
    await assert.rejects(settleExactProcess({ ...owned.original, birth: 'another-original-process' }, nativeProcessBirth), /birth changed/u)
    await assert.rejects(settleExactProcess(owned.original, async () => { throw Error('original observation failed') }), /cannot be rechecked/u)
    assert.equal(alive(owned.child.pid), true); assert.equal(owned.output.join('').includes('term'), false)
  } finally { await owned.close() }
})

test('the original ChildProcess owner also refuses a changed birth before TERM', { skip: !darwin }, async () => {
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  await once(child.stdout, 'data')
  const original = await kernelIdentity(child.pid)
  let reads = 0
  try {
    await registerChild(child, async () => ++reads === 1 ? original.birth : 'a-replacement-process')
    await assert.rejects(terminate(child), /birth changed/u)
    assert.equal(reads, 2); assert.equal(alive(child.pid), true)
  } finally { await settleExactProcess(original, nativeProcessBirth); assert.equal(await exited(child, 5000), true) }
})

test('rechecks birth before KILL escalation and keeps a changed process untouched', { skip: !darwin }, async () => {
  const owned = await privateChild(readyProgram)
  let reads = 0
  try {
    await assert.rejects(settleExactProcess(owned.original, async () => ++reads === 1 ? owned.original.birth : 'changed-after-term'), /birth changed/u)
    assert.equal(reads, 2); assert.equal(alive(owned.child.pid), true)
    assert.equal(owned.output.join('').split('term').length - 1, 1)
  } finally { await owned.close() }
})

test('a failed birth capture retains the child owner and cannot become an unregistered signal', { skip: !darwin }, async () => {
  const child = spawn(process.execPath, ['-e', readyProgram], { stdio: ['ignore', 'pipe', 'pipe'] })
  await once(child.stdout, 'data')
  const original = await kernelIdentity(child.pid)
  try {
    await assert.rejects(registerChild(child, async () => { throw Error('capture unavailable') }), /remains unknown/u)
    await assert.rejects(terminate(child), /remains unknown/u)
    assert.equal(alive(child.pid), true)
  } finally { await settleExactProcess(original, nativeProcessBirth); assert.equal(await exited(child, 5000), true) }
})

test('a ChildProcess exit is authoritative even when birth could not be captured', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(await exited(child, 5000), true)
  const original = await registerChild(child, () => { throw Error('must not observe a replacement') })
  assert.deepEqual(original, { pid: child.pid, exited: true })
  assert.equal((await terminate(child)).exited, true)
})

test('the launcher cleanup seam preserves its namespace, stale receipt and original error', { skip: !darwin }, async () => {
  const owned = await privateChild(readyProgram), state = await scope()
  try {
    state.ownership.peerReceipts.push('peer-process.json'); state.errors.push('original execution failed')
    const receipt = { processId: owned.child.pid, processIdentity: { ...owned.original, birth: 'unrelated-birth' } }
    await writeFile(join(state.privateRoot, 'peer-process.json'), JSON.stringify(receipt))
    const result = await cleanupPrivateProofScope(state)
    assert.equal(result.privateRootRemoved, false); assert.equal(await absent(state.privateRoot), false)
    assert.ok(result.errors.includes('original execution failed')); assert.ok(result.errors.some(error => error.includes('birth changed')))
    assert.deepEqual(JSON.parse(await readFile(join(state.evidence, 'peer-process.json'), 'utf8')), receipt)
    assert.equal(alive(owned.child.pid), true); assert.equal(owned.output.join('').includes('term'), false)
  } finally { await owned.close(); await rm(state.root, { recursive: true, force: true }) }
})

test('missing expected receipts remain unknown and preserve the namespace', async () => {
  const state = await scope()
  try {
    state.ownership.peerReceipts.push('missing-process.json')
    const result = await cleanupPrivateProofScope(state)
    assert.equal(result.privateRootRemoved, false); assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /ENOENT/u)
  } finally { await rm(state.root, { recursive: true, force: true }) }
})

test('contradictory PID aliases and unspecified group ownership cannot authorize cleanup', { skip: !darwin }, async () => {
  const model = await privateChild(), wrapper = await privateChild(), state = await scope()
  try {
    state.ownership.modelReceipts.push('model-process.json')
    const receipt = { modelPid: model.child.pid, modelProcess: model.original, wrapperPid: wrapper.child.pid, wrapperProcess: wrapper.original }
    for (const invalid of [{ ...receipt, modelOwnProcessGroup: false, modelPid: wrapper.child.pid }, receipt]) {
      state.errors = []
      await writeFile(join(state.privateRoot, 'model-process.json'), JSON.stringify(invalid))
      const result = await cleanupPrivateProofScope(state)
      assert.equal(result.privateRootRemoved, false); assert.equal(result.errors.length, 1)
      assert.equal(alive(model.child.pid), true); assert.equal(alive(wrapper.child.pid), true)
    }
  } finally { await model.close(); await wrapper.close(); await rm(state.root, { recursive: true, force: true }) }
})

test('the launcher cleans exact self/spawn receipts and removes only its private namespace', { skip: !darwin }, async () => {
  const peer = await privateChild(), model = await privateChild(), wrapper = await privateChild(), daemon = await privateChild(), state = await scope()
  try {
    state.ownership.daemonProcess = daemon.original; state.ownership.peerReceipts.push('peer-process.json'); state.ownership.modelReceipts.push('model-process.json')
    await writeFile(join(state.privateRoot, 'peer-process.json'), JSON.stringify({ processId: peer.child.pid, processIdentity: peer.original }))
    await writeFile(join(state.privateRoot, 'model-process.json'), JSON.stringify({ wrapperPid: wrapper.child.pid, modelPid: model.child.pid, wrapperProcess: wrapper.original, modelProcess: model.original, modelOwnProcessGroup: false }))
    const result = await cleanupPrivateProofScope(state)
    assert.deepEqual(result.errors, []); assert.equal(result.privateRootRemoved, true); assert.equal(result.exactProcesses.length, 4)
    assert.equal(await absent(state.evidence), false)
  } finally { await Promise.all([peer, model, wrapper, daemon].map(owned => owned.close())); await rm(state.root, { recursive: true, force: true }) }
})

test('the actual peer fixture records its self birth through the selected Core', { skip: !darwin }, async () => {
  const state = await scope(), receiptPath = join(state.privateRoot, 'peer-process.json')
  const child = spawn(process.execPath, [join(coreRoot, 'scripts/fixtures/a2a-agent-behavior/peer.mjs'), join(state.privateRoot, 'input.bytes'), receiptPath, '', coreRoot], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'pipe'] })
  const original = await registerChild(child, nativeProcessBirth)
  try {
    let receipt
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null)
      if (receipt?.processIdentity?.birth) break
      await new Promise(done => setTimeout(done, 10))
    }
    assert.deepEqual(receipt.processIdentity, original)
    assert.equal(receipt.processId, child.pid)
  } finally { await terminate(child); await rm(state.root, { recursive: true, force: true }) }
})

test('the actual exec wrapper records and terminates its exact private model substitute', { skip: !darwin }, async () => {
  const state = await scope(), executable = join(state.privateRoot, 'model-substitute.mjs'), planPath = join(state.privateRoot, 'plan.json'), processReceipt = join(state.privateRoot, 'model-process.json')
  await writeFile(executable, '#!' + process.execPath + '\nconsole.log("ready");setInterval(()=>{},1000)\n', { mode: 0o700 })
  const plan = { coreRoot, home: state.privateRoot, authHome: state.privateRoot, workspace: state.privateRoot, cli: executable,
    credentials: join(state.privateRoot, 'credential.json'), events: join(state.privateRoot, 'events.jsonl'), stderr: join(state.privateRoot, 'stderr.log'), processReceipt,
    args: ['--no-daemon', '--ignore-user-config', '--ignore-rules'] }
  await writeFile(planPath, JSON.stringify(plan))
  const child = spawn(process.execPath, [join(coreRoot, 'scripts/fixtures/a2a-agent-behavior/codex-exec.mjs'), executable, planPath, 'private input'], {
    cwd: state.privateRoot, env: { PATH: process.env.PATH, HOME: plan.home, CODEX_HOME: plan.authHome, AGENTMUX_CLI: plan.cli }, stdio: ['ignore', 'pipe', 'pipe'] })
  const original = await registerChild(child, nativeProcessBirth)
  let receipt, stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await readFile(processReceipt, 'utf8').then(JSON.parse).catch(() => null)
      if (receipt?.modelProcess?.birth) break
      await new Promise(done => setTimeout(done, 10))
    }
    assert.ok(receipt?.modelProcess?.birth, stderr || 'Actual wrapper did not record its model birth')
    assert.deepEqual(receipt.wrapperProcess, original)
    assert.deepEqual(receipt.modelProcess, await kernelIdentity(receipt.modelPid))
    assert.equal(receipt.modelOwnProcessGroup, true)
    await terminate(child)
    assert.equal((await settleExactProcess(receipt.modelProcess, nativeProcessBirth, true)).exited, true)
  } finally {
    await terminate(child)
    if (receipt?.modelProcess?.birth) await settleExactProcess(receipt.modelProcess, nativeProcessBirth, true)
    await rm(state.root, { recursive: true, force: true })
  }
})

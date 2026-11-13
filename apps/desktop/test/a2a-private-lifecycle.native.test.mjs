import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { a2aPrivateMainPaths, stopPrivateA2aMains } from '../scripts/lib/a2a-inbox-product-proof.mjs'
import { spawnPrivateA2aMain } from '../scripts/fixtures/a2a-inbox-product/runtime.mjs'

const temporary = async run => { const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-lifecycle-test-'))); try { await run(root) } finally { await rm(root, { recursive: true, force: true }) } }

test('an outer stop before registration prevents a later Main spawn', async () => temporary(async root => {
  const barrier = await stopPrivateA2aMains(root)
  assert.deepEqual(barrier.stopped, [])
  let spawned = false
  assert.throws(() => spawnPrivateA2aMain(root, 'late', [], () => { spawned = true; return { pid: 1 } }), /original stop fence/u)
  assert.equal(spawned, false)
  const registry = JSON.parse(await readFile(a2aPrivateMainPaths(root).registry, 'utf8'))
  assert.deepEqual(registry.launches, [{ label: 'late', phase: 'cancelled', pid: null }])
}))

test('the stop barrier waits for an already registered launch to settle', async () => temporary(async root => {
  const paths = a2aPrivateMainPaths(root)
  const save = phase => writeFile(paths.registry, JSON.stringify({ schema: 'agentmux.private-a2a-launches.v1', launches: [{ label: 'pending', phase, pid: null }] }))
  await save('launching')
  let completed = false
  const stopping = stopPrivateA2aMains(root).then(result => { completed = true; return result })
  while (!await readFile(paths.stop, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })) await new Promise(done => setTimeout(done, 5))
  await new Promise(done => setTimeout(done, 40)); assert.equal(completed, false)
  await save('unconfirmed')
  await new Promise(done => setTimeout(done, 40)); assert.equal(completed, false)
  await save('not-spawned')
  assert.deepEqual((await stopping).stopped, [])
}))

test('the original private Main is confirmed stopped before the Inspector worker can be ended', async () => temporary(async root => {
  const script = join(root, 'owned-main.mjs'); await writeFile(script, 'setInterval(()=>{},1000)\n')
  const child = spawnPrivateA2aMain(root, 'original', [], () => spawn(process.execPath, [script], { detached: true, stdio: 'ignore' }))
  const exited = once(child, 'exit')
  try {
    const barrier = await stopPrivateA2aMains(root)
    assert.deepEqual(barrier.stopped, [{ pid: child.pid, label: 'original', exit: 'confirmed-absent-or-zombie' }])
    await exited
    assert.equal(child.signalCode, 'SIGKILL')
    let spawned = false
    assert.throws(() => spawnPrivateA2aMain(root, 'later', [], () => { spawned = true }), /original stop fence/u)
    assert.equal(spawned, false)
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
}))

async function pausedInspectorWorker(root, retain = false) {
  const runtime = new URL('../scripts/fixtures/a2a-inbox-product/runtime.mjs', import.meta.url).href
  const main = join(root, 'paused-main.mjs'), resumed = join(root, 'unexpected-main-resume')
  await writeFile(main, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(resumed)},'Main resumed after losing its Inspector');\n`)
  const worker = join(root, 'inspector-owner.mjs')
  await writeFile(worker, `import{spawn}from'node:child_process';import{writeFile}from'node:fs/promises';
import{spawnPrivateA2aMain,retainPrivateA2aInspector}from${JSON.stringify(runtime)};
const root=${JSON.stringify(root)},main=spawnPrivateA2aMain(root,'paused',[],()=>spawn(process.execPath,['--inspect-brk=0',${JSON.stringify(main)}],{detached:true,stdio:['ignore','ignore','pipe']}));
let output='';const url=await new Promise(done=>main.stderr.on('data',bytes=>{output+=bytes;const found=/Debugger listening on (ws:\\/\\/\\S+)/.exec(output);if(found)done(found[1])}));
const ws=new WebSocket(url),requests=new Map();let sequence=0,paused;const observedPause=new Promise(done=>paused=done);
await new Promise((done,fail)=>{ws.addEventListener('open',done,{once:true});ws.addEventListener('error',fail,{once:true})});
ws.addEventListener('message',({data})=>{const value=JSON.parse(data);if(value.method==='Debugger.paused')paused(value.params);const pending=requests.get(value.id);if(pending){requests.delete(value.id);value.error?pending.reject(Error(value.error.message)):pending.resolve(value.result)}});
const call=(method)=>new Promise((resolve,reject)=>{const id=++sequence;requests.set(id,{resolve,reject});ws.send(JSON.stringify({id,method}))});
await call('Runtime.enable');await call('Debugger.enable');await call('Runtime.runIfWaitingForDebugger');const pause=await observedPause;
await writeFile(root+'/actual-pause.json',JSON.stringify({pid:main.pid,reason:pause.reason}));
if(${retain}){setInterval(()=>process.stderr.write('retained-diagnostic\\n'),10);await retainPrivateA2aInspector('controlled cleanup fault')}
process.on('SIGTERM',()=>ws.close());setInterval(()=>{},1000);process.stderr.write('private-main-paused\\n');
`)
  return {worker,resumed}
}

test('a real paused child exits before its Inspector worker receives soft and hard stop', async () => temporary(async root => {
  const { runProbeProcess, stopProbeProcesses } = await import('../scripts/probe-process.mjs')
  const {worker,resumed} = await pausedInspectorWorker(root)
  const primary = 'Controlled observation failure while the original Main is paused'
  try {
    const error = await runProbeProcess(process.execPath, [worker], { cwd: root, env: { ...process.env }, timeoutMs: 5000, graceMs: 50,
      onLine: line => { if (line === 'private-main-paused') throw new Error(primary) },
      beforeStop: () => stopPrivateA2aMains(root) }).catch(error => error)
    assert.ok(error instanceof AggregateError)
    assert.ok(error.errors.some(error => error.message === primary))
    assert.equal(JSON.parse(await readFile(join(root, 'actual-pause.json'), 'utf8')).reason, 'Break on start')
    assert.equal(error.probe.exitConfirmed, true); assert.equal(error.probe.exitSignal, 'SIGKILL')
    assert.deepEqual(error.probe.signals.map(item => item.signal), ['SIGTERM', 'SIGKILL'])
    await assert.rejects(readFile(resumed), { code: 'ENOENT' })
  } finally { await stopPrivateA2aMains(root); await stopProbeProcesses(-1, root) }
}))


test('a missing PID stays unconfirmed until the original child reports a native spawn error', async () => temporary(async root => {
  const launches = []
  const child = spawnPrivateA2aMain(root, 'failed', launches, () => spawn(join(root, 'missing-executable'), [], { stdio: 'ignore' }))
  const paths = a2aPrivateMainPaths(root)
  assert.equal(launches[0].phase, 'unconfirmed')
  await new Promise(done => child.once('close', done))
  const registration = JSON.parse(await readFile(paths.registry, 'utf8')).launches[0]
  assert.equal(registration.phase, 'not-spawned'); assert.equal(registration.pid, null); assert.equal(registration.failure.code, 'ENOENT')
  assert.deepEqual((await stopPrivateA2aMains(root)).stopped, [])
}))


test('an unconfirmed cleanup retains the real paused Main and survives the observer stderr pipe closing', async () => temporary(async root => {
  const { runProbeProcess, stopProbeProcesses } = await import('../scripts/probe-process.mjs')
  const {worker,resumed} = await pausedInspectorWorker(root, true)
  let originalWorker
  try {
    const error = await runProbeProcess(process.execPath, [worker], { cwd: root, env: { ...process.env }, timeoutMs: 5000,
      onSpawn: (_receipt, child) => { originalWorker = child },
      onLine: line => { if (line.startsWith('a2a_private_main_exit_unconfirmed=')) throw new Error('Original private cleanup remains unknown') },
      beforeStop: async () => { throw new Error('Original Main exit is unconfirmed') } }).catch(error => error)
    assert.equal(error.probe.cleanup, 'before-stop-unconfirmed'); assert.equal(error.probe.exitConfirmed, false)
    assert.deepEqual(error.probe.signals, [])
    assert.equal(originalWorker.stderr.destroyed, false)
    originalWorker.stderr.destroy()
    await new Promise(done => setTimeout(done, 80))
    assert.equal(originalWorker.exitCode, null); assert.equal(originalWorker.signalCode, null)
    assert.equal(process.kill(originalWorker.pid, 0), true)
    await assert.rejects(readFile(resumed), { code: 'ENOENT' })
  } finally { await stopPrivateA2aMains(root); await stopProbeProcesses(-1, root) }
}))

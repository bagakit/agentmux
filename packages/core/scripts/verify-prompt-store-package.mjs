import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { stopProbeProcesses, listProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'
const exec = promisify(execFile)
const archive = path.resolve(process.argv[2])
const evidence = path.resolve(process.argv[3])
// Darwin's Unix socket path limit applies to the private Native runtime too.
const root = await realpath(await mkdtemp('/tmp/amux-prompt-'))
const store = path.join(root, 'sessions.json')
const worker = path.join(root, 'worker.mjs')
const children = new Set()
const receipt = { schema: 'agentmux.prompt-store-package.v1', passed: false,
  archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), phases: [], cleanup: null }
await mkdir(evidence, { recursive: true })
const start = mode => {
  const child = spawn(process.execPath, [worker, store, mode], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const lines = [], waiters = []
  let output = '', stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  child.stdout.on('data', bytes => {
    output += bytes
    for (;;) {
      const end = output.indexOf('\n'); if (end < 0) break
      const value = JSON.parse(output.slice(0, end)); output = output.slice(end + 1)
      lines.push(value); receipt.phases.push(value)
      for (const waiter of waiters.splice(0)) waiter.resolve(value)
    }
  })
  const closed = new Promise(resolve => child.on('close', (code, signal) => {
    children.delete(child)
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Worker ended before proof: ${code}/${signal} ${stderr}`))
    resolve({ code, signal, stderr })
  }))
  return { child, closed, next: async () => {
    if (lines.length) return lines.shift()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Private File Store proof did not respond')), 15000)
      waiters.push({ resolve: value => { clearTimeout(timer); lines.shift(); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) } })
    })
  } }
}
try {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const install = await exec('pnpm', ['add', '--ignore-scripts', archive], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(path.join(evidence, 'install.log'), install.stdout + install.stderr)
  await copyFile(new URL('../test/fixtures/prompt-store-lock-worker.mjs', import.meta.url), worker)
  const owner = start('hold'), held = await owner.next()
  assert.equal(held.phase, 'held'); assert.equal(held.callbacks, 1)
  for (const physical of [held.core, held.native, held.addon]) assert.ok(physical.startsWith(`${root}/node_modules/`), 'Package proof must not borrow workspace dist or dependencies')
  const locked = parse(await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8'))
  assert.equal(Object.keys(held.closure).length, 6, 'The reviewed native/loader closure must be nonempty and complete')
  for (const [name, descriptor] of Object.entries(held.closure)) {
    assert.ok(locked.packages[`${name}@${descriptor.version}`]?.resolution?.integrity, 'The selected package must be bound to the reviewed lock')
    assert.ok(descriptor.entry.startsWith(`${root}/node_modules/`))
  }
  const contender = start('contend'), busy = await contender.next()
  assert.deepEqual(busy.inode, held.inode); assert.equal(busy.phase, 'busy')
  assert.deepEqual(await contender.closed, { code: 0, signal: null, stderr: '' })
  owner.child.stdin.end('release\n')
  const released = await owner.next(); assert.deepEqual(released.inode, held.inode)
  assert.equal((await owner.closed).code, 0)
  const success = start('acquire'), acquired = await success.next()
  assert.deepEqual(acquired.inode, held.inode); assert.equal((await success.closed).code, 0)
  const interrupted = start('hold'), heldAgain = await interrupted.next()
  assert.deepEqual(heldAgain.inode, held.inode)
  interrupted.child.kill('SIGTERM'); assert.equal((await interrupted.closed).signal, 'SIGTERM')
  const afterExit = start('acquire'), recovered = await afterExit.next()
  assert.deepEqual(recovered.inode, held.inode); assert.equal((await afterExit.closed).code, 0)
  if (process.argv.includes('--native')) {
    const nativeWorker = path.join(root, 'native-worker.mjs')
    await copyFile(new URL('../test/fixtures/prompt-native-pending-worker.mjs', import.meta.url), nativeWorker)
    let native
    try {
      native = await exec(process.execPath, [nativeWorker, root, 'parent'], { cwd: root, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
    } catch (error) {
      native = error
      throw error
    } finally {
      await writeFile(path.join(evidence, 'native.log'), (native?.stdout ?? '') + (native?.stderr ?? ''))
      await copyFile(path.join(root, 'native-proof.json'), path.join(evidence, 'native-proof.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  if (process.argv.includes('--native-partial')) {
    const partialWorker = path.join(root, 'partial-worker.mjs')
    await copyFile(new URL('../test/fixtures/prompt-native-partial-worker.mjs', import.meta.url), partialWorker)
    let partial
    try {
      partial = await exec(process.execPath, [partialWorker, root, process.argv.includes('--restore-partial') ? 'restore' : 'counter'],
        { cwd: root, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
    } catch (error) { partial = error; throw error }
    finally {
      await writeFile(path.join(evidence, 'partial.log'), (partial?.stdout ?? '') + (partial?.stderr ?? ''))
      await copyFile(path.join(root, 'partial-proof.json'), path.join(evidence, 'partial-proof.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))))
  assert.equal(children.size, 0)
  await stopProbeProcesses(process.pid + 1_000_000_000, root)
  assert.deepEqual(await listProbeProcesses(-1, root), [])
  await rm(root, { recursive: true, force: true })
  receipt.cleanup = { liveChildren: children.size, privateRootRemoved: true }
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, phases: receipt.phases.length, cleanup: receipt.cleanup }))

import assert from 'node:assert/strict'
import { fork, execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const [worker, cli, host, selected = 'all'] = process.argv.slice(2)
const run = promisify(execFile), marker = 'agentmux.demand-writer-lock.v1\n'
const native = createRequire(new URL('../package.json', import.meta.url))('fs-native-extensions')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const cases = {}
let root, children, cleanup, observations
function child(input) {
  const process = fork(worker, [JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = [], waiters = new Set()
  let stdout = '', stderr = '', done = false
  process.stdout.on('data', text => { stdout += text })
  process.stderr.on('data', text => { stderr += text })
  process.once('exit', () => { done = true })
  const exit = new Promise(resolve => process.once('close', (code, signal) => { resolve({ pid: process.pid, code, signal }) }))
  process.on('message', value => { messages.push(value); for (const check of waiters) check() })
  const wait = event => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(Error(`Worker ${process.pid} missing ${event}: ${stderr}; ${JSON.stringify(messages)}`)) }, 8000)
    const check = () => { const value = messages.find(value => value.event === event); if (value) { clearTimeout(timer); waiters.delete(check); resolve(value) } }
    waiters.add(check); check()
  })
  const record = { process, messages, exit, wait, get stdout() { return stdout }, get stderr() { return stderr }, resume: () => process.send('continue'),
    stop: async () => { if (!done) process.kill('SIGKILL'); const result = await exit; observations.push({ cleanupChild: result }); return result } }
  children.push(record)
  return record
}
async function command(input) {
  const item = child(input), ended = await item.exit
  const result = item.messages.find(value => value.event === 'result')
  assert.equal(ended.code, 0, JSON.stringify(item.messages))
  assert.ok(result, 'actual public Store receipt is required')
  return result.result
}
async function cliCall(...args) {
  const result = await run(process.execPath, [cli, ...args], { timeout: 10000 })
  return JSON.parse(result.stdout)
}
async function seed(directory = root) {
  await fs.mkdir(directory, { recursive: true })
  return cliCall('create', '--root', directory, '--id', 'original', '--title', 'Original goal', '--description', 'Complete original body', '--session-id', 'original-session', '--project-id', 'original-project', '--operation-id', 'original-create')
}
async function privateLegacyDirectory() {
  // Copy the original data only, representing a store left by an older writer.
  const directory = await fs.mkdtemp(join(root, 'legacy-'))
  await fs.copyFile(join(root, 'store.json'), join(directory, 'store.json'))
  return directory
}
function create(directory, id, pause) { return child({ root: directory, method: 'create', args: [{ id, title: id }], ...(pause ? { pause } : {}) }) }
async function success(item) { const result = await item.wait('result'); assert.equal((await item.exit).code, 0); return result.result }

cases['kernel-exclusion'] = async () => {
  await seed()
  const first = create(root, 'left', 'snapshot')
  await first.wait('paused')
  const second = create(root, 'right')
  await second.wait('opened-lock')
  await delay(60) // let this process and the other writer's async poll progress while owner is held
  assert.equal(second.messages.some(value => value.event === 'result'), false, 'a second writer must wait for the original kernel owner')
  first.resume(); await success(first); await success(second)
  const updated = await Promise.all(['left', 'right'].map(id => command({ root, method: 'update', args: [id, { description: id + ' body' }] })))
  assert.equal(updated.length, 2)
  await Promise.all(['left', 'right'].map(id => command({ root, method: 'addActivity', args: [id, { kind: 'progress', message: id + ' progress', actorId: null, operationId: id + '-activity' }] })))
  const snapshot = (await cliCall('list', '--root', root))
  assert.equal(snapshot.revision, 7)
  assert.deepEqual(snapshot.demands.map(value => value.id).sort(), ['left', 'original', 'right'])
  for (const id of ['left', 'right']) {
    const goal = snapshot.demands.find(value => value.id === id)
    assert.equal(goal.description, id + ' body')
    assert.equal(goal.activities.filter(value => value.operationId === id + '-activity').length, 1)
  }
  assert.equal(await fs.readFile(join(root, 'store.lock'), 'utf8'), marker)
  observations.push({ distinctPids: [first.process.pid, second.process.pid], revision: snapshot.revision })
}

cases['atomic-publication'] = async () => {
  for (const point of ['before-publish', 'after-publish']) {
    const directory = await fs.mkdtemp(join(root, point + '-'))
    const writer = create(directory, 'uncommitted', point)
    await writer.wait('paused')
    if (point === 'before-publish') await assert.rejects(fs.stat(join(directory, 'store.lock')), { code: 'ENOENT' })
    else assert.equal(await fs.readFile(join(directory, 'store.lock'), 'utf8'), marker, 'the first published bytes must be a complete marker')
    const ended = await writer.stop(); assert.equal(ended.signal, 'SIGKILL')
    await command({ root: directory, method: 'create', args: [{ id: 'after-crash', title: 'Continue original root' }] })
    const snapshot = await cliCall('list', '--root', directory)
    assert.equal(snapshot.revision, 1); assert.deepEqual(snapshot.demands.map(value => value.id), ['after-crash'])
  }
}

cases['crash-and-original-receipts'] = async () => {
  await seed()
  await cliCall('update', '--root', root, '--id', 'original', '--title', 'Reviewed title', '--operation-id', 'original-title')
  const input = { kind: 'review', message: 'Original evidence', actorId: null, operationId: 'original-activity' }
  await command({ root, method: 'addActivity', args: ['original', input] })
  const before = await fs.readFile(join(root, 'store.json'))
  const writer = create(root, 'unknown', 'snapshot'); await writer.wait('paused'); assert.equal((await writer.stop()).signal, 'SIGKILL')
  assert.deepEqual(await fs.readFile(join(root, 'store.json')), before)
  const receipt = await command({ root, method: 'addActivity', args: ['original', input] })
  assert.equal(receipt.replayed, true); assert.equal(receipt.revision, 3)
  const title = await cliCall('update', '--root', root, '--id', 'original', '--title', 'Reviewed title', '--operation-id', 'original-title')
  assert.equal(title.receipt.replayed, true); assert.equal(title.receipt.nameChange.operationId, 'original-title')
  const goal = (await cliCall('show', '--root', root, '--id', 'original')).demand
  assert.equal(goal.id, 'original'); assert.equal(goal.description, 'Complete original body')
  assert.deepEqual(goal.sessionIds, ['original-session']); assert.equal(goal.projectId, 'original-project')
  assert.equal(goal.activities.filter(value => value.operationId === 'original-activity').length, 1)
  await command({ root, method: 'create', args: [{ id: 'new-explicit', title: 'A new explicit action' }] })
  assert.equal((await cliCall('list', '--root', root)).revision, 4)
  const broken = await fs.mkdtemp(join(root, 'corrupt-'))
  await fs.writeFile(join(broken, 'store.json'), '{broken')
  const denied = create(broken, 'never'); const failure = await denied.wait('failure'); await denied.exit
  assert.equal(failure.error.code, 'INVALID_SNAPSHOT'); assert.equal(await fs.readFile(join(broken, 'store.json'), 'utf8'), '{broken')
}

cases['legacy-unknown'] = async () => {
  await seed()
  const directory = await privateLegacyDirectory(), legacy = child({ root: directory, legacy: true })
  await legacy.wait('legacy-held')
  const lock = join(directory, 'store.lock'), bytes = await fs.readFile(lock), original = await fs.readFile(join(directory, 'store.json'))
  const fd = await fs.open(lock, 'r+'); try { assert.equal(native.tryLock(fd.fd), true, 'old live writers already closed their FD; advisory-free cannot establish authority') } finally { await fd.close() }
  const denied = async location => {
    const item = child({ root: location, method: 'update', args: ['original', { description: 'must not write' }], timeout: 100 })
    assert.equal((await item.exit).code, 1, 'unknown legacy ownership must refuse this mutation')
    const failure = item.messages.find(value => value.event === 'failure'); assert.ok(failure)
    assert.equal(failure.error.phase, 'lock'); assert.equal(failure.error.code, 'WRITE_FAILED'); assert.match(failure.error.message, /ownership is unknown/)
    assert.deepEqual(await fs.readFile(join(location, 'store.json')), original)
    assert.equal((await cliCall('show', '--root', location, '--id', 'original')).demand.description, 'Complete original body')
  }
  await denied(directory); assert.deepEqual(await fs.readFile(lock), bytes)
  await legacy.stop(); await denied(directory); assert.deepEqual(await fs.readFile(lock), bytes)
  for (const record of ['', '12\n', 'not-a-protocol', marker.slice(0, -1), marker + 'extra']) {
    const partial = await privateLegacyDirectory(); await fs.writeFile(join(partial, 'store.lock'), record)
    await denied(partial); assert.equal(await fs.readFile(join(partial, 'store.lock'), 'utf8'), record)
  }
  const released = await privateLegacyDirectory(), alive = child({ root: released, legacy: true })
  await alive.wait('legacy-held'); await denied(released)
  alive.resume(); await success(alive)
  await command({ root: released, method: 'update', args: ['original', { description: 'explicit after original release' }] })
  assert.equal(await fs.readFile(join(released, 'store.lock'), 'utf8'), marker)
  observations.push({ liveLegacyAdvisoryLock: true, killedLegacyStillUnknown: true, ordinaryReads: true })
}

cases['permanent-inode'] = async () => {
  await seed()
  const first = create(root, 'first', 'snapshot'); await first.wait('paused')
  const inode = (await fs.stat(join(root, 'store.lock'))).ino
  const waiter = create(root, 'waiter', 'snapshot'); await waiter.wait('opened-lock')
  first.resume(); await success(first); await waiter.wait('paused')
  // The waiter already opened the original inode before the first owner closes.
  // A release-unlink implementation lets a third writer acquire another inode.
  const third = create(root, 'third'); await third.wait('started'); await delay(60)
  assert.equal(third.messages.some(value => value.event === 'result'), false, 'release must not let a new opener overtake the old inode owner')
  assert.equal((await fs.stat(join(root, 'store.lock'))).ino, inode)
  waiter.resume(); await success(waiter); await success(third)
  assert.deepEqual((await cliCall('list', '--root', root)).demands.map(value => value.id).sort(), ['first', 'original', 'third', 'waiter'])
}

cases['acquisition-cleanup-ownership'] = async () => {
  for (const code of ['EEXIST', 'EACCES']) {
    const directory = await fs.mkdtemp(join(root, 'open-failure-'))
    const failed = child({ root: directory, method: 'create', args: [{ id: 'never', title: 'Never' }], openFailure: code })
    const collision = await failed.wait('open-failure'); const failure = await failed.wait('failure'); await failed.exit
    assert.equal(failure.error.phase, 'lock')
    assert.equal(await fs.readFile(collision.path, 'utf8'), 'Existing file owned by another creator', 'cleanup cannot delete a temporary path it did not create')
    await assert.rejects(fs.stat(join(directory, 'store.lock')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(join(directory, 'store.json')), { code: 'ENOENT' })
    await command({ root: directory, method: 'create', args: [{ id: 'new-explicit', title: 'Original root still usable' }] })
  }
}

cases['typed-close-receipts'] = async () => {
  for (const scenario of ['unknown', 'not_applied', 'confirmed-failed', 'confirmed-applied']) {
    const directory = await fs.mkdtemp(join(root, scenario + '-')); await seed(directory)
    const operationId = scenario + '-title', title = 'Title ' + scenario
    const argv = ['update', '--root', directory, '--id', 'original', '--title', title, '--operation-id', operationId,
      ...(scenario === 'confirmed-failed' ? ['--expected-revision', '0'] : [])]
    const failed = child({ root: directory, cli: true, argv, closeFailure: true,
      directorySyncFailure: scenario === 'unknown', beforeReplaceFailure: scenario === 'not_applied' })
    assert.equal((await failed.exit).code, 1)
    const result = JSON.parse(failed.stderr)
    const error = result.error, confirmed = scenario.startsWith('confirmed-')
    assert.equal(error.commitStatus, confirmed ? 'confirmed' : scenario, 'actual CLI must preserve the original typed effect')
    assert.equal(error.nameChange.operationId, operationId)
    assert.equal(error.nameChange.status, scenario === 'unknown' ? 'unknown' : scenario === 'confirmed-applied' ? 'applied' : 'failed')
    assert.match(error.message, /clos/i)
    if (scenario === 'confirmed-applied') { assert.match(error.message, /durably recorded/); assert.doesNotMatch(error.message, /failed title attempt|previous title is retained/) }
    if (scenario === 'confirmed-failed') assert.match(error.message, /failed title attempt was recorded/)
    const before = await fs.readFile(join(directory, 'store.json'))
    if (scenario !== 'not_applied') {
      if (scenario === 'confirmed-failed') {
        const retry = child({ root: directory, cli: true, argv }); assert.equal((await retry.exit).code, 1)
        assert.equal(JSON.parse(retry.stderr).error.commitStatus, 'confirmed')
      } else {
        const retry = await cliCall(...argv)
        assert.equal(retry.receipt.replayed, true); assert.equal(retry.receipt.nameChange.operationId, operationId)
      }
      assert.deepEqual(await fs.readFile(join(directory, 'store.json')), before, 'original receipt checks cannot repeat the title mutation')
    }
    const actual = (await cliCall('show', '--root', directory, '--id', 'original')).demand.title
    assert.equal(actual, scenario === 'not_applied' || scenario === 'confirmed-failed' ? 'Original goal' : title)
    observations.push({ scenario, commitStatus: error.commitStatus, nameStatus: error.nameChange.status, phase: error.phase })
  }
  const directory = await fs.mkdtemp(join(root, 'primary-cause-')); await seed(directory)
  const failed = child({ root: directory, method: 'update', args: ['original', { description: 'Never applied' }], primaryFailure: true, closeFailure: true })
  const failure = await failed.wait('failure'); await failed.exit
  assert.equal(failure.sameError, true); assert.equal(failure.sameCause, true)
  assert.equal(failure.cause.kind, 'goal-start-version-conflict'); assert.equal(failure.cleanupCount, 1)
  assert.equal((await cliCall('show', '--root', directory, '--id', 'original')).demand.description, 'Complete original body')

}

cases['host-public-and-async-wait'] = async () => {
  const { hostFixture } = await import(pathToFileURL(host).href)
  const f = hostFixture(root); cleanup.push(() => f.owner.dispose())
  const directory = join(root, 'demands'); await seed(directory)
  const owner = create(directory, 'held', 'snapshot'); await owner.wait('paused')
  let updated = false, confirmed = false
  const update = f.call('goal.update', { goalId: 'original', patch: { description: 'Public Host update' }, operationId: 'public-update' }).then(value => { updated = true; return value })
  const activity = f.call('goal.activity.inspect', { goalId: 'original', operationId: 'public-activity' }).then(value => { confirmed = true; return value })
  // Attach rejection handlers immediately; assertions below still consume the
  // original promises, and fixture cleanup runs even on an invalid public call.
  void update.catch(() => {}); void activity.catch(() => {})
  // A real timer and a real public read must run while the same root's writer is
  // held; another root has its own independent queue and physical lock.
  await delay(50)
  assert.equal(updated, false); assert.equal(confirmed, false)
  assert.equal((await f.call('goal.inspect', { goalId: 'original' })).goal.id, 'original')
  await command({ root: join(root, 'other-root'), method: 'create', args: [{ id: 'other', title: 'Other root' }] })
  const timeout = child({ root: directory, method: 'update', args: ['original', { description: 'must time out' }], timeout: 30 })
  const failure = await timeout.wait('failure'); await timeout.exit
  assert.equal(failure.error.code, 'LOCK_TIMEOUT')
  owner.resume(); await success(owner)
  assert.equal((await update).goal.description, 'Public Host update'); await activity
  const added = await f.call('goal.activity.append', { goalId: 'original', operationId: 'public-activity', kind: 'progress', message: 'Same public receipt' })
  const replay = await f.call('goal.activity.append', { goalId: 'original', operationId: 'public-activity', kind: 'progress', message: 'Same public receipt' })
  assert.equal(replay.receipt.replayed, true); assert.equal(added.activity.id, replay.activity.id)
  const inspected = await f.call('goal.activity.inspect', { goalId: 'original', operationId: 'public-activity' })
  assert.equal(inspected.activity.id, added.activity.id)
  assert.equal((await cliCall('show', '--root', directory, '--id', 'original')).demand.activities.filter(value => value.operationId === 'public-activity').length, 1)
  observations.push({ ordinaryPublicReadDuringWait: true, otherRootDuringWait: true, sameOperationActivity: added.activity.id })
}

const names = selected === 'all' ? Object.keys(cases) : [selected]
assert.ok(names.length && names.every(name => cases[name]), 'nonempty known case selection')
for (const name of names) {
  root = await fs.mkdtemp(join(tmpdir(), 'demand-writer-proof-')); children = []; cleanup = []; observations = []
  let failure
  try { await cases[name]() } catch (error) { failure = error }
  const failures = []
  for (const item of children) { try { await item.stop() } catch (error) { failures.push(error) } }
  for (const close of cleanup.reverse()) { try { await close() } catch (error) { failures.push(error) } }
  try { await fs.rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  const removed = await fs.stat(root).then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true })
  console.log(JSON.stringify({ case: name, passed: !failure && !failures.length, privateRootRemoved: removed, observations,
    ...(failure ? { error: failure.stack, code: failure.code } : {}), cleanupErrors: failures.map(error => String(error)) }))
  if (failure || failures.length) { process.exitCode = 1; break }
}

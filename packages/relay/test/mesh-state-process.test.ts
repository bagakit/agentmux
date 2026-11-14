import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireMeshStateGuard } from '../src/mesh-state-guard.js'

const cleanup: Array<() => void | Promise<void>> = []
const roots: string[] = [], children: ChildProcess[] = [], facts: unknown[] = []
afterEach(async ({ task }) => {
  for (const close of cleanup.splice(0).reverse()) await close()
  const directories = await Promise.all(roots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })))
  const processes = children.splice(0).map(child => ({ pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null, exitCode: child.exitCode, signalCode: child.signalCode }))
  expect(directories.every(item => item.absent)).toBe(true); expect(processes.every(item => item.exited)).toBe(true)
  if (process.env.RELAY_MESH_CONSUMER_REPORT) await appendFile(process.env.RELAY_MESH_CONSUMER_REPORT, JSON.stringify({ test: task.name, facts: facts.splice(0), cleanup: { roots: directories, processes, errors: [] } }) + '\n')
  else facts.splice(0)
})
const executable = resolve('packages/relay/bin/agentmux-relay')
const run = (args: string[]) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', timeout: 5000 })
async function launch(config: string) {
  const child = spawn(process.execPath, [executable, 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let errors = ''; child.stderr.on('data', data => { errors += String(data) })
  cleanup.push(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit })
  const lines = createInterface({ input: child.stdout }); cleanup.push(() => lines.close())
  const receipt = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)), once(child, 'exit').then(() => { throw Error('Private Mesh activation failed: ' + errors) })])
  return { child, receipt, errors: () => errors }
}
async function killed(child: ChildProcess) { const exit = once(child, 'exit'); child.kill('SIGKILL'); expect(await exit).toEqual([null, 'SIGKILL']) }

it('standalone owner loss closes its network, and SIGKILL recovery uses exact receipts and the unchanged OS guard inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-owner-process-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  roots.push(root)
  const directory = join(root, 'private-state'), init = run(['identity', '--state', directory])
  expect(init.status, init.stderr).toBe(0)
  const original = JSON.parse(init.stdout), config = join(root, 'gateway.json'), expectedPath = join(root, 'expected.json')
  await writeFile(config, JSON.stringify({ port: 0, publishers: [], meshStateDirectory: directory, mesh: { networkId: 'private-owner-recovery', members: [{ peerId: original.peerId, publicKey: original.publicKey }], peers: [] } }))
  const active = await launch(config), inode = (await stat(join(directory, 'owner.guard'))).ino
  const inspect = () => { const result = run(['state', 'inspect', '--state', directory]); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout) }
  const before = inspect(); expect(before.owner.guardPid).toEqual(expect.any(Number))
  await writeFile(expectedPath, JSON.stringify(before))
  const started = Date.now(), refused = run(['state', 'reconcile', '--state', directory, '--expected', expectedPath])
  expect(refused.status).toBe(1); expect(Date.now() - started).toBeLessThan(3000)
  expect(JSON.parse(refused.stderr).error.code).toBe('MESH_STATE_IN_USE_OR_UNCONFIRMED')
  expect(active.child.exitCode).toBeNull()
  const lost = once(active.child, 'exit'); process.kill(before.owner.guardPid, 'SIGKILL')
  expect(await lost).toEqual([1, null])
  expect(JSON.parse(active.errors()).error).toMatchObject({ code: 'MESH_STATE_OWNER_LOST', operationId: before.owner.operationId })
  expect(inspect()).toEqual(before)
  const reconciled = run(['state', 'reconcile', '--state', directory, '--expected', expectedPath])
  expect(reconciled.status, reconciled.stderr).toBe(0)
  expect(JSON.parse(reconciled.stdout)).toMatchObject({ originalOperationId: before.owner.operationId, originalSaveAcknowledgement: 'not-reconstructed', readbackDurability: 'confirmed', identity: before.identity })
  const next = await launch(config)
  expect(next.receipt.mesh.identity).toEqual({ peerId: original.peerId, publicKey: original.publicKey, epoch: before.identity.epoch + 1 })
  await killed(next.child)
  // Kernel lock availability is authoritative; no PID or wall-time death inference.
  await vi.waitFor(async () => { const guard = await acquireMeshStateGuard(directory, 'observe-kernel-release'); await guard.release() }, { timeout: 10000 })
  const afterKill = inspect(); await writeFile(expectedPath, JSON.stringify(afterKill))
  const recoveredKill = run(['state', 'reconcile', '--state', directory, '--expected', expectedPath])
  expect(recoveredKill.status, recoveredKill.stderr).toBe(0)
  expect(JSON.parse(recoveredKill.stdout)).toMatchObject({ readbackDurability: 'confirmed', identity: afterKill.identity })
  expect((await stat(join(directory, 'owner.guard'))).ino).toBe(inode)
  const state = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
  expect(state.identity.peerId).toBe(original.peerId)
  expect(state.epoch).toBe(afterKill.identity.epoch)
  expect(JSON.stringify([before, reconciled.stdout, afterKill, recoveredKill.stdout])).not.toContain(state.identity.secretKey)
  facts.push({ case: 'guard-and-owner-loss', initialOwner: before, killedOwner: afterKill, recovery: JSON.parse(recoveredKill.stdout), guardInodeBefore: inode, guardInodeAfter: (await stat(join(directory, 'owner.guard'))).ino, kernelGuardReleasedAfterOwnerKill: true })
}, 30000)

it('a dead guard never lets recovery or a new serve cross a still-live writer held before its original epoch rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-held-writer-')); roots.push(root); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'private-state'), initialized = run(['identity', '--state', directory])
  expect(initialized.status, initialized.stderr).toBe(0)
  const original = JSON.parse(initialized.stdout), config = join(root, 'gateway.json'), expected = join(root, 'expected.json')
  await writeFile(config, JSON.stringify({ port: 0, publishers: [], meshStateDirectory: directory, mesh: { networkId: 'private-held-writer', members: [{ peerId: original.peerId, publicKey: original.publicKey }], peers: [] } }))
  const before = await readFile(join(directory, 'identity.json'), 'utf8')
  const writer = fork(resolve('packages/relay/test/fixtures/mesh-state-writer.mjs'), ['hold-rename', directory, 'original-held-epoch'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(writer)
  cleanup.push(async () => { if (writer.exitCode !== null || writer.signalCode !== null) return; const exit = once(writer, 'exit'); writer.kill('SIGTERM'); await exit })
  const [held] = await once(writer, 'message'); expect(held).toMatchObject({ stage: 'held-rename', operationId: 'original-held-epoch' })
  const inspectionResult = run(['state', 'inspect', '--state', directory]); expect(inspectionResult.status).toBe(0)
  const inspection = JSON.parse(inspectionResult.stdout)
  expect(inspection.owner).toMatchObject({ pid: writer.pid, operationId: 'original-held-epoch', baseEpoch: original.epoch, proposedEpoch: original.epoch + 1, peerId: original.peerId })
  process.kill(inspection.owner.guardPid, 'SIGKILL')
  await vi.waitFor(async () => { const guard = await acquireMeshStateGuard(directory, 'probe-held-writer-guard'); await guard.release() }, { timeout: 10000 })
  await writeFile(expected, JSON.stringify(inspection))
  const unsafeRecovery = run(['state', 'reconcile', '--state', directory, '--expected', expected])
  expect(unsafeRecovery.status).toBe(1)
  expect(JSON.parse(unsafeRecovery.stderr).error.code).toBe('MESH_STATE_WRITER_ACTIVE_OR_UNCONFIRMED')
  const unsafeServe = run(['serve', '--config', config])
  expect(unsafeServe.status).toBe(1); expect(JSON.parse(unsafeServe.stderr).error.code).toBe('MESH_STATE_IN_USE_OR_UNCONFIRMED')
  expect(await readFile(join(directory, 'identity.json'), 'utf8')).toBe(before)
  const completed = once(writer, 'message'), exited = once(writer, 'exit')
  writer.send({ releaseOperationId: 'original-held-epoch' })
  const [result] = await completed
  expect(result).toMatchObject({ stage: 'refused', operationId: 'original-held-epoch', error: { code: 'MESH_STATE_OWNER_LOST' } })
  expect(await exited).toEqual([0, null])
  const observed = run(['state', 'inspect', '--state', directory]); expect(observed.status).toBe(0)
  const settled = JSON.parse(observed.stdout)
  expect(settled.identity).toMatchObject({ peerId: original.peerId, epoch: original.epoch + 1, operationId: 'original-held-epoch' })
  await writeFile(expected, JSON.stringify(settled))
  const recovery = run(['state', 'reconcile', '--state', directory, '--expected', expected]); expect(recovery.status, recovery.stderr).toBe(0)
  const next = await launch(config)
  expect(next.receipt.mesh.identity).toEqual({ peerId: original.peerId, publicKey: original.publicKey, epoch: original.epoch + 2 })
  facts.push({ case: 'held-rename-guard-loss', original: inspection, settled, refusedRecovery: JSON.parse(unsafeRecovery.stderr), refusedNewServe: JSON.parse(unsafeServe.stderr), recovered: JSON.parse(recovery.stdout), next: next.receipt })
}, 30000)

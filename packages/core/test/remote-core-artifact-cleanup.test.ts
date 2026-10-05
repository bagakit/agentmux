import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPortableCoreArtifact } from '../src/portable-core-artifact.js'
import { RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeHost } from '../src/remote-core-upgrade.js'
import { rpcFailure, rpcResponseError } from '../src/public-rpc-frame.js'

const partials = vi.hoisted(() => [] as { directory: string; copied: string; error: unknown }[])
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) }
})
vi.mock('../src/portable-core-artifact.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/portable-core-artifact.js')>()
  return { ...actual, createPortableCoreArtifact: vi.fn(async (...args: Parameters<typeof actual.createPortableCoreArtifact>) => {
    try { return await actual.createPortableCoreArtifact(...args) }
    catch (error) {
      // Observe actual partial production bytes before the assembly owner rolls back.
      partials.push({ directory: args[0], copied: await readFile(join(args[0], 'core', 'dist', 'agentmux.js'), 'utf8'), error })
      throw error
    }
  }) }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(actualFs.rm)
  vi.mocked(mkdtemp).mockReset().mockImplementation(actualFs.mkdtemp)
  vi.mocked(createPortableCoreArtifact).mockClear()
  partials.length = 0
  await Promise.all(roots.splice(0).map(root => actualFs.rm(root, { recursive: true, force: true })))
})
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const host: RemoteCoreUpgradeHost = { kind: 'ssh', id: 'private-host', label: 'Private fixture', hostname: 'fixture.invalid',
  runtimeId: 'private-runtime', remoteCommand: fixturePath("private/bin/amux"), remoteSocketPath: fixturePath("private/control.sock") }
const runtime = 'export const privateArtifact = "retained"\n'
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-candidate-cleanup-')); roots.push(root)
  const packageRoot = join(root, 'package'), stateDirectory = join(root, 'state')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await put(join(packageRoot, 'package.json'), JSON.stringify({ name: '@agentmux/core', version: '0.0.0' }))
  await put(join(packageRoot, 'release.json'), JSON.stringify({ sourceCommit: 'private-source' }))
  await put(join(packageRoot, 'dist', 'agentmux.js'), runtime)
  const native = 'Private native bytes; never executed\n'
  const manifest = { source: { commit: 'private-native' }, product: { protocol: 1 }, binaries: [{ path: 'bin/ctxmuxd', sha256: sha(native) }] }
  const manifestBytes = JSON.stringify(manifest)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'manifest.json'), manifestBytes)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'bin', 'ctxmuxd'), native)
  const contractPath = join(packageRoot, 'dist', 'ctxmux-artifact-contract.json')
  const contract = { protocol: 1, manifests: { 'linux-x64': sha(manifestBytes) }, sources: { 'linux-x64': manifest.source } }
  await put(contractPath, JSON.stringify({ ...contract, protocol: 999 }))
  const retainedHost = { ...host, id: 'retained-host', hostname: 'retained.invalid', runtimeId: 'retained-runtime' }
  const markers = {
    [join(stateDirectory, 'candidate-existing', 'retained.txt')]: 'original-state\n',
    [join(stateDirectory, 'unrelated', 'retained.txt')]: 'original-state\n',
    [join(stateDirectory, 'operations', 'retained-operation.json')]: JSON.stringify({ receipt: {
      input: retainedHost, operationId: 'retained-operation', status: 'completed', stage: 'completed', updatedAt: 1, detail: 'Original completed update',
      expected: { targetDigest: remoteCoreUpgradeTargetDigest(retainedHost), runtimeId: 'retained-runtime', ownerInstanceId: 'retained-owner',
        processId: 101, startTicks: '1', candidateDigest: 'retained-digest', nativeInstanceId: 'retained-native', nativeProcessId: 102, nativeStartTicks: '2' }
    } })
  }
  for (const [path, text] of Object.entries(markers)) await put(path, text)
  const maintenance = vi.fn(async () => { throw new Error('Private remote observation unavailable') })
  const executionHost = vi.fn(() => { throw new Error('No private remote process may be started') })
  const manager = new RemoteCoreUpgradeManager({ stateDirectory, packageRoot, maintenance, executionHost })
  vi.mocked(rm).mockClear(); vi.mocked(mkdtemp).mockClear()
  return { root, packageRoot, stateDirectory, contractPath, contract, markers, manager, maintenance, executionHost }
}
async function preserved(markers: Record<string, string>) {
  for (const [path, text] of Object.entries(markers)) expect(await readFile(path, 'utf8')).toBe(text)
}

it('removes only actual partial candidates across explicit failures, then retains and reuses successful assembly', async () => {
  const f = await fixture()
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = await f.manager.check(host).catch(error => error)
    expect(error).toBe(partials[attempt].error)
    expect(error.message).toContain('compiled Core Native contract')
    expect(partials[attempt].copied).toBe(runtime)
    await expect(readFile(join(partials[attempt].directory, 'core', 'dist', 'agentmux.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(f.stateDirectory)).toEqual(expect.arrayContaining(['candidate-existing', 'operations', 'unrelated']))
    expect((await readdir(f.stateDirectory)).filter(name => name.startsWith('candidate-'))).toEqual(['candidate-existing'])
    expect(f.maintenance).not.toHaveBeenCalled(); expect(f.executionHost).not.toHaveBeenCalled()
    await preserved(f.markers)
  }
  expect(partials[0].directory).not.toBe(partials[1].directory)
  await writeFile(f.contractPath, JSON.stringify(f.contract))
  const check = await f.manager.check(host)
  expect(check).toMatchObject({ eligible: false, reason: 'unverified', detail: 'Private remote observation unavailable',
    candidate: { sourceCommit: 'private-source', protocolVersion: 1 } })
  const successful = (await readdir(f.stateDirectory)).filter(name => name.startsWith('candidate-') && name !== 'candidate-existing')
  expect(successful).toHaveLength(1)
  expect(await readFile(join(f.stateDirectory, successful[0], 'core', 'dist', 'agentmux.js'), 'utf8')).toBe(runtime)
  expect((await readFile(join(f.stateDirectory, successful[0], 'core.tar.gz'))).byteLength).toBeGreaterThan(0)
  expect((await f.manager.check(host)).candidate).toEqual(check.candidate)
  expect(vi.mocked(createPortableCoreArtifact)).toHaveBeenCalledTimes(3)
  expect(vi.mocked(mkdtemp)).toHaveBeenCalledTimes(3)
  expect(vi.mocked(rm).mock.calls.map(([path]) => path)).toEqual(partials.map(value => value.directory))
  expect(f.executionHost).not.toHaveBeenCalled()
  await preserved(f.markers)
})

it('never cleans a directory when exclusive child creation failed', async () => {
  const f = await fixture(), error = Object.assign(new Error('exclusive child creation denied'), { code: 'EACCES' })
  vi.mocked(mkdtemp).mockRejectedValueOnce(error)
  await expect(f.manager.check(host)).rejects.toBe(error)
  expect(vi.mocked(rm)).not.toHaveBeenCalled()
  expect(vi.mocked(createPortableCoreArtifact)).not.toHaveBeenCalled()
  expect(f.maintenance).not.toHaveBeenCalled(); expect(f.executionHost).not.toHaveBeenCalled()
  await preserved(f.markers)
})

it('reports assembly and cleanup failure together through the existing RPC error transport', async () => {
  const f = await fixture(), cleanup = Object.assign(new Error('private cleanup denied'), { code: 'EACCES' })
  vi.mocked(rm).mockRejectedValueOnce(cleanup)
  const error = await f.manager.check(host).catch(error => error)
  expect(partials).toHaveLength(1)
  expect(partials[0].copied).toBe(runtime)
  expect(error.cause).toBe(partials[0].error)
  expect(error.message).toContain('compiled Core Native contract')
  expect(error.message).toContain('private cleanup denied')
  expect(error.message).toContain(partials[0].directory)
  expect(vi.mocked(rm)).toHaveBeenCalledExactlyOnceWith(partials[0].directory, { recursive: true, force: true })
  const transported = rpcResponseError(JSON.parse(JSON.stringify(rpcFailure('private-check', error))))!
  expect(transported.code).toBe('CORE_ARTIFACT_UNAVAILABLE')
  expect(transported.message).toBe(error.message)
  expect(JSON.parse(transported.detail!)).toEqual({ directory: partials[0].directory,
    assembly: { code: 'CORE_ARTIFACT_UNAVAILABLE', message: (partials[0].error as Error).message },
    cleanup: { message: 'private cleanup denied' } })
  expect(await readFile(join(partials[0].directory, 'core', 'dist', 'agentmux.js'), 'utf8')).toBe(runtime)
  expect(f.maintenance).not.toHaveBeenCalled(); expect(f.executionHost).not.toHaveBeenCalled()
  await preserved(f.markers)
})

it('leaves externally supplied artifact paths and their failures with the caller', async () => {
  const f = await fixture(), external = join(f.root, 'external-artifact', 'retained.txt')
  await put(external, 'original-state\n')
  const error = new Error('external assembly failed'), artifact = vi.fn(async () => { throw error })
  const manager = new RemoteCoreUpgradeManager({ stateDirectory: f.stateDirectory, artifact, maintenance: f.maintenance })
  await expect(manager.check(host)).rejects.toBe(error)
  await expect(manager.check(host)).rejects.toBe(error)
  expect(artifact).toHaveBeenCalledTimes(2)
  expect(vi.mocked(mkdtemp)).not.toHaveBeenCalled(); expect(vi.mocked(rm)).not.toHaveBeenCalled()
  expect(vi.mocked(createPortableCoreArtifact)).not.toHaveBeenCalled(); expect(f.maintenance).not.toHaveBeenCalled()
  await preserved({ ...f.markers, [external]: 'original-state\n' })
})

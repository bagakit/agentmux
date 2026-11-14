import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import * as durable from '../src/durable-write.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllEnvs()
})

async function ownedFixture(agentSessionId = 'original-agent') {
  const h = await rpcOwnerFixture([], undefined, undefined, root => ({
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: root, runtimeId: 'execution-runtime' })
  }))
  cleanup.push(h.close)
  const locator = (await h.client.hostEnvironment({ agentSessionId })).agentWorkspace
  const markerPath = join(dirname(h.store.path), 'agent-workspace-identities', locator.workspacePath.split('/').at(-1)! + '.json')
  const input = {
    providerId: 'codex', role: 'frontend' as const, bindingId: 'original-binding', agentSessionId,
    createOperationId: 'original-frontend', workspacePath: locator.workspacePath,
    toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: h.root }
  }
  return { ...h, locator, markerPath, input }
}

it('public first preparation provisions the exact locator with durable root and leaf witnesses, then retained validates only', async () => {
  const h = await ownedFixture()
  await expect(lstat(h.locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).resolves.toMatchObject({
    role: 'frontend', prepared: { workspacePath: h.locator.workspacePath }
  })
  expect(prepareTerminal).toHaveBeenCalledOnce()
  const [root, leaf, markerBytes] = await Promise.all([
    lstat(dirname(h.locator.workspacePath)),
    lstat(h.locator.workspacePath),
    readFile(h.markerPath, 'utf8')
  ])
  expect(root.isDirectory()).toBe(true)
  expect(leaf.isDirectory()).toBe(true)
  expect(leaf.mode & 0o777).toBe(0o700)
  const marker = JSON.parse(markerBytes)
  expect(marker).toEqual({
    schema: 1,
    phase: 'provisioned',
    runtimeId: 'execution-runtime',
    agentSessionId: h.input.agentSessionId,
    workspacePath: h.locator.workspacePath,
    root: { dev: String(root.dev), ino: String(root.ino) },
    leaf: { dev: String(leaf.dev), ino: String(leaf.ino) }
  })
  for (const identity of [marker.root, marker.leaf]) {
    expect(identity.dev).toMatch(/^\d+$/u)
    expect(identity.ino).toMatch(/^\d+$/u)
  }
  const markerBefore = await readFile(h.markerPath)
  await expect(h.client.prepareAgentExecutionHelper(h.input)).resolves.toMatchObject({
    prepared: { workspacePath: h.locator.workspacePath }
  })
  expect(prepareTerminal).toHaveBeenCalledOnce()
  expect(await readFile(h.markerPath)).toEqual(markerBefore)

  await rm(h.locator.workspacePath, { recursive: true })
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  await expect(lstat(h.locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(prepareTerminal).toHaveBeenCalledOnce()
  expect(await readFile(h.markerPath)).toEqual(markerBefore)
})

type OwnedFixture = Awaited<ReturnType<typeof ownedFixture>>

async function escapeMarkerNamespace(h: OwnedFixture) {
  const externalRoot = await mkdtemp(join(tmpdir(), 'amx-escaped-identities-'))
  cleanup.push(async () => { await rm(externalRoot, { recursive: true, force: true }) })
  const externalDirectory = join(externalRoot, 'identities')
  await rename(dirname(h.markerPath), externalDirectory)
  await symlink(externalDirectory, dirname(h.markerPath))
  return { externalRoot, externalMarker: join(externalDirectory, h.markerPath.split('/').at(-1)!) }
}

async function seedPending(h: OwnedFixture, occupant?: 'empty' | 'file' | 'symlink' | 'nonempty') {
  const root = dirname(h.locator.workspacePath)
  await mkdir(root)
  await mkdir(dirname(h.markerPath))
  if (occupant === 'empty' || occupant === 'nonempty') await mkdir(h.locator.workspacePath)
  if (occupant === 'file') await writeFile(h.locator.workspacePath, 'unknown occupant')
  if (occupant === 'symlink') {
    await mkdir(join(h.root, 'outside'))
    await symlink(join(h.root, 'outside'), h.locator.workspacePath)
  }
  if (occupant === 'nonempty') await writeFile(join(h.locator.workspacePath, 'unknown'), 'retained')
  const identity = await lstat(root)
  const marker = { schema: 1, phase: 'pending', runtimeId: 'execution-runtime', agentSessionId: h.input.agentSessionId,
    workspacePath: h.locator.workspacePath, root: { dev: String(identity.dev), ino: String(identity.ino) }, leaf: null }
  await writeFile(h.markerPath, JSON.stringify(marker) + '\n', { mode: 0o600 })
  return await readFile(h.markerPath)
}

it.each([undefined, 'empty'] as const)('first reentry completes a pending reservation with a %s leaf', async occupant => {
  const h = await ownedFixture()
  await seedPending(h, occupant)
  await h.client.prepareAgentExecutionHelper(h.input)
  expect(JSON.parse(await readFile(h.markerPath, 'utf8')).phase).toBe('provisioned')
  expect((await lstat(h.locator.workspacePath)).isDirectory()).toBe(true)
})

it.each(['file', 'symlink', 'nonempty'] as const)('pending reentry preserves and rejects a %s occupant without Provider preparation', async occupant => {
  const h = await ownedFixture()
  const before = await seedPending(h, occupant)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(h.markerPath)).toEqual(before)
  if (occupant === 'file') expect(await readFile(h.locator.workspacePath, 'utf8')).toBe('unknown occupant')
  if (occupant === 'symlink') expect((await lstat(h.locator.workspacePath)).isSymbolicLink()).toBe(true)
  if (occupant === 'nonempty') expect(await readFile(join(h.locator.workspacePath, 'unknown'), 'utf8')).toBe('retained')
})

it('pending publication rejects a nonempty replacement introduced after the emptiness read', async () => {
  const h = await ownedFixture()
  const before = await seedPending(h, 'empty')
  const leaf = h.locator.workspacePath
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.readdir.bind(fs)
  let replaced = false
  vi.spyOn(fs, 'readdir').mockImplementation((async (path: any, options: any) => {
    const entries = await original(path, options)
    if (String(path) === leaf && !replaced) {
      replaced = true
      const retired = join(h.root, 'retired-empty-leaf')
      await rename(leaf, retired)
      await mkdir(leaf)
      await writeFile(join(leaf, 'unknown'), 'must not be provisioned')
    }
    return entries
  }) as any)
  syncBuiltinESMExports()
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(h.markerPath)).toEqual(before)
  expect(await readFile(join(leaf, 'unknown'), 'utf8')).toBe('must not be provisioned')
})

it('rejects a wrong-UID pending occupant without changing the reservation', async () => {
  const h = await ownedFixture()
  const before = await seedPending(h, 'empty')
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.lstat.bind(fs)
  vi.spyOn(fs, 'lstat').mockImplementation((async (path: any, options: any) => {
    const stats = await original(path, options)
    if (String(path) === h.locator.workspacePath && options?.bigint) {
      return Object.create(stats, { uid: { value: (stats as any).uid + 1n } })
    }
    return stats
  }) as any)
  syncBuiltinESMExports()
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(await readFile(h.markerPath)).toEqual(before)
})

it('refuses an occupied leaf with no reservation marker and never claims the unknown occupant', async () => {
  const h = await ownedFixture()
  await mkdir(dirname(h.locator.workspacePath))
  await mkdir(dirname(h.markerPath))
  await mkdir(h.locator.workspacePath)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  await expect(lstat(h.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await lstat(h.locator.workspacePath)).isDirectory()).toBe(true)
})

it('retained preparation rejects a pending marker and never completes first allocation', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const provisioned = JSON.parse(await readFile(h.markerPath, 'utf8'))
  const pending = JSON.stringify({ ...provisioned, phase: 'pending', leaf: null }) + '\n'
  await writeFile(h.markerPath, pending)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(h.markerPath, 'utf8')).toBe(pending)
})

it('first pending reentry refuses an escaped identity namespace without writing outside the state root', async () => {
  const h = await ownedFixture()
  await seedPending(h)
  const escaped = await escapeMarkerNamespace(h)
  const before = await readFile(escaped.externalMarker)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(escaped.externalMarker)).toEqual(before)
  expect(JSON.parse(before.toString()).phase).toBe('pending')
  expect((await lstat(dirname(h.markerPath))).isSymbolicLink()).toBe(true)
})

it('retained validation refuses an escaped provisioned identity namespace', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const escaped = await escapeMarkerNamespace(h)
  const before = await readFile(escaped.externalMarker)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(escaped.externalMarker)).toEqual(before)
})

it.each([
  ['schema', (marker: any) => { marker.schema = 2 }],
  ['extra field', (marker: any) => { marker.extra = true }],
  ['runtime', (marker: any) => { marker.runtimeId = 'other-runtime' }],
  ['SID', (marker: any) => { marker.agentSessionId = 'other-agent' }],
  ['path', (marker: any) => { marker.workspacePath += '-other' }],
  ['root witness', (marker: any) => { delete marker.root.dev }],
  ['leaf witness', (marker: any) => { delete marker.leaf.ino }],
  ['phase', (marker: any) => { marker.phase = 'pending' }]
] as const)('retained validation rejects a marker with the wrong %s and preserves its bytes', async (_kind, change) => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const marker = JSON.parse(await readFile(h.markerPath, 'utf8'))
  change(marker)
  const corrupted = JSON.stringify(marker) + '\n'
  await writeFile(h.markerPath, corrupted)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(h.markerPath, 'utf8')).toBe(corrupted)
})

it('retained validation rejects a replaced namespace root and does not recreate its leaf', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const before = await readFile(h.markerPath)
  await rm(dirname(h.locator.workspacePath), { recursive: true })
  await mkdir(dirname(h.locator.workspacePath))
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  await expect(lstat(h.locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(h.markerPath)).toEqual(before)
})

it('retained validation rejects simultaneously replaced root and leaf inodes', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const before = await readFile(h.markerPath)
  await rm(dirname(h.locator.workspacePath), { recursive: true })
  await mkdir(dirname(h.locator.workspacePath))
  await mkdir(h.locator.workspacePath)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(await readFile(h.markerPath)).toEqual(before)
})

it('retained validation rejects root replacement between proofs even when the leaf inode is preserved', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const before = await readFile(h.markerPath)
  const root = dirname(h.locator.workspacePath), leafName = h.locator.workspacePath.split('/').at(-1)!
  const originalLeaf = await lstat(h.locator.workspacePath)
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.lstat.bind(fs)
  let rootProofs = 0
  vi.spyOn(fs, 'lstat').mockImplementation((async (path: any, options: any) => {
    if (String(path) === root && options?.bigint && ++rootProofs === 3) {
      const retired = join(h.root, 'retired-root-between-proofs')
      await rename(root, retired)
      await mkdir(root)
      await rename(join(retired, leafName), join(root, leafName))
    }
    return await original(path, options)
  }) as any)
  syncBuiltinESMExports()
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(rootProofs).toBeGreaterThanOrEqual(3)
  expect((await lstat(h.locator.workspacePath)).ino).toBe(originalLeaf.ino)
  expect(await readFile(h.markerPath)).toEqual(before)
})

it('retained validation rejects a symlink replacement without cleaning its target', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const before = await readFile(h.markerPath)
  await rm(h.locator.workspacePath, { recursive: true })
  await mkdir(join(h.root, 'external'))
  await writeFile(join(h.root, 'external', 'retained'), 'unknown')
  await symlink(join(h.root, 'external'), h.locator.workspacePath)
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect((await lstat(h.locator.workspacePath)).isSymbolicLink()).toBe(true)
  expect(await readFile(join(h.root, 'external', 'retained'), 'utf8')).toBe('unknown')
  expect(await readFile(h.markerPath)).toEqual(before)
})

it('retained validation rejects a missing provisioned marker without republishing it', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  await rm(h.markerPath)
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  await expect(lstat(h.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await lstat(h.locator.workspacePath)).isDirectory()).toBe(true)
})

it('retries a before-replace publication interruption through first admission only', async () => {
  const h = await ownedFixture()
  vi.spyOn(durable, 'durableWriteFile').mockImplementationOnce(async () => { throw new Error('before-replace publication interrupted') })
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(JSON.parse(await readFile(h.markerPath, 'utf8')).phase).toBe('pending')
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await h.client.prepareAgentExecutionHelper(h.input)
  expect(prepareTerminal).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(h.markerPath, 'utf8')).phase).toBe('provisioned')
})

it('recovers an after-replace lost ACK by validating the same leaf before the first Provider build', async () => {
  const h = await ownedFixture()
  const write = durable.durableWriteFile
  vi.spyOn(durable, 'durableWriteFile').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('after-replace ACK lost') })
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(JSON.parse(await readFile(h.markerPath, 'utf8')).phase).toBe('provisioned')
  const before = await lstat(h.locator.workspacePath)
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  await h.client.prepareAgentExecutionHelper(h.input)
  expect(prepareTerminal).toHaveBeenCalledOnce()
  expect((await lstat(h.locator.workspacePath)).ino).toBe(before.ino)
})

it('retained validate-only performs no additional state-directory fsync after the helper lock barrier', async () => {
  const h = await ownedFixture()
  await h.client.prepareAgentExecutionHelper(h.input)
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.open.bind(fs)
  let stateSyncs = 0
  vi.spyOn(fs, 'open').mockImplementation((async (path: any, flags: any, mode?: any) => {
    const handle = await original(path, flags, mode)
    if (String(path) === h.root && flags === 'r') {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        stateSyncs++
        if (stateSyncs > 1) throw new Error('unrelated validate-only state fsync')
        await sync()
      })
    }
    return handle
  }) as any)
  syncBuiltinESMExports()
  await expect(h.client.prepareAgentExecutionHelper(h.input)).resolves.toMatchObject({ prepared: { workspacePath: h.locator.workspacePath } })
  expect(stateSyncs).toBe(1)
})

it('fails closed before allocation when directory fsync cannot be acknowledged', async () => {
  const h = await ownedFixture()
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.open.bind(fs)
  let stateOpens = 0
  vi.spyOn(fs, 'open').mockImplementation((async (path: any, flags: any, mode?: any) => {
    const handle = await original(path, flags, mode)
    if (String(path) === h.root && flags === 'r' && ++stateOpens === 2) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory fsync unsupported'))
    return handle
  }) as any)
  syncBuiltinESMExports()
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  await expect(lstat(dirname(h.locator.workspacePath))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('fails closed before allocation when the platform cannot prove ownership', async () => {
  const h = await ownedFixture()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  await expect(lstat(dirname(h.locator.workspacePath))).rejects.toMatchObject({ code: 'ENOENT' })
})

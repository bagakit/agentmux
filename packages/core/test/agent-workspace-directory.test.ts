import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentWorkspaceDirectory } from '../src/agent-workspace-directory.js'
import * as durable from '../src/durable-write.js'
import * as directoryWrite from '../src/directory-write.js'
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
  expect((await lstat(h.markerPath)).mode & 0o777).toBe(0o600)
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

it('namespace allocation rejects a state-directory replacement without creating in the external inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-state-namespace-'))
  const escaped = await mkdtemp(join(tmpdir(), 'amx-state-namespace-external-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); await rm(escaped, { recursive: true, force: true }) })
  const state = join(root, 'state'), externalState = join(escaped, 'replacement')
  await mkdir(state)
  await mkdir(externalState)
  const workspace = new AgentWorkspaceDirectory(join(state, 'sessions.json'), 'execution-runtime')
  const location = workspace.locate('original-agent')
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const originalRealpath = fs.realpath.bind(fs), originalRename = fs.rename.bind(fs)
  let replaced = false
  vi.spyOn(fs, 'realpath').mockImplementation((async (path: any, options: any) => {
    const result = await originalRealpath(path, options)
    if (String(path) === state && !replaced) {
      replaced = true
      await originalRename(state, join(root, 'retired-state'))
      await symlink(externalState, state)
    }
    return result
  }) as any)
  syncBuiltinESMExports()
  await expect(workspace.admit('original-agent', location.agentWorkspace.workspacePath, 'first')).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(replaced).toBe(true)
  expect(await readdir(externalState)).toEqual([])
})

it('namespace mkdir stays on the opened state parent when the path changes after its preflight sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-state-mkdir-'))
  const escaped = await mkdtemp(join(tmpdir(), 'amx-state-mkdir-external-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }); await rm(escaped, { recursive: true, force: true }) })
  const state = join(root, 'state'), externalState = join(escaped, 'replacement')
  await mkdir(state)
  await mkdir(externalState)
  const workspace = new AgentWorkspaceDirectory(join(state, 'sessions.json'), 'execution-runtime')
  const location = workspace.locate('original-agent')
  const stateRealpath = await realpath(state)
  const originalSync = directoryWrite.syncDirectoryWriteParent
  let replaced = false
  vi.spyOn(directoryWrite, 'syncDirectoryWriteParent').mockImplementation(async parent => {
    await originalSync(parent)
    if (parent.realpath === stateRealpath && !replaced) {
      replaced = true
      await rename(state, join(root, 'retired-state'))
      await symlink(externalState, state)
    }
  })
  await expect(workspace.admit('original-agent', location.agentWorkspace.workspacePath, 'first')).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(replaced).toBe(true)
  expect(await readdir(externalState)).toEqual([])
})

it('initial pending marker creation stays with the proven parent after its namespace changes', async () => {
  const h = await ownedFixture()
  const escaped = await mkdtemp(join(tmpdir(), 'amx-initial-pending-marker-'))
  cleanup.push(async () => { await rm(escaped, { recursive: true, force: true }) })
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.lstat.bind(fs), originalRename = fs.rename.bind(fs)
  let proofs = 0
  vi.spyOn(fs, 'lstat').mockImplementation((async (path: any, options: any) => {
    const result = await original(path, options)
    if (String(path) === dirname(h.markerPath) && options?.bigint && ++proofs === 2) {
      await originalRename(dirname(h.markerPath), join(escaped, 'identities'))
      await symlink(join(escaped, 'identities'), dirname(h.markerPath))
    }
    return result
  }) as any)
  syncBuiltinESMExports()
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(proofs).toBeGreaterThanOrEqual(2)
  await expect(lstat(join(escaped, 'identities', h.markerPath.split('/').at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('initial pending leaf mkdir stays with the proven root after its namespace changes', async () => {
  const h = await ownedFixture()
  await seedPending(h)
  const external = await mkdtemp(join(tmpdir(), 'amx-initial-pending-leaf-'))
  cleanup.push(async () => { await rm(external, { recursive: true, force: true }) })
  const root = dirname(h.locator.workspacePath)
  const originalOpen = directoryWrite.openDirectoryWriteParent
  let injected = false
  vi.spyOn(directoryWrite, 'openDirectoryWriteParent').mockImplementation(async (path, expected) => {
    const parent = await originalOpen(path, expected)
    if (String(path) === root && !injected) {
      injected = true
      await rename(root, join(h.root, 'retired-pending-root'))
      await symlink(external, root)
    }
    return parent
  })
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(injected).toBe(true)
  expect(await readdir(external)).toEqual([])
})

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

it('first pending reentry re-acknowledges the marker file and parent before leaf mkdir', async () => {
  const h = await ownedFixture()
  await seedPending(h)
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const originalOpen = fs.open.bind(fs), events: string[] = []
  vi.spyOn(fs, 'open').mockImplementation((async (path: any, flags: any, mode?: any) => {
    const handle = await originalOpen(path, flags, mode)
    if (String(path) === h.markerPath) { const sync = handle.sync.bind(handle); vi.spyOn(handle, 'sync').mockImplementation(async () => { events.push('marker-sync'); await sync() }) }
    if (String(path) === dirname(h.markerPath) && flags === 'r') { const sync = handle.sync.bind(handle); vi.spyOn(handle, 'sync').mockImplementation(async () => { events.push('parent-sync'); await sync() }) }
    return handle
  }) as any)
  const nativeMkdir = directoryWrite.directoryMkdirAt
  vi.spyOn(directoryWrite, 'directoryMkdirAt').mockImplementation((parent, name, mode) => {
    if (name === h.locator.workspacePath.split('/').at(-1)) events.push('leaf-mkdir')
    nativeMkdir(parent, name, mode)
  })
  syncBuiltinESMExports()
  await h.client.prepareAgentExecutionHelper(h.input)
  expect(events.indexOf('marker-sync')).toBeGreaterThanOrEqual(0)
  expect(events.indexOf('parent-sync')).toBeGreaterThanOrEqual(0)
  expect(events.indexOf('leaf-mkdir')).toBeGreaterThanOrEqual(0)
  expect(events.indexOf('marker-sync')).toBeLessThan(events.indexOf('leaf-mkdir'))
  expect(events.indexOf('parent-sync')).toBeLessThan(events.indexOf('leaf-mkdir'))
})

it.each(['temp', 'rename', 'sync'] as const)('marker publication keeps post-assert parent replacement out of %s', async stage => {
  const h = await ownedFixture()
  await seedPending(h)
  const externalRoot = await mkdtemp(join(tmpdir(), 'amx-marker-publication-escape-'))
  cleanup.push(async () => { await rm(externalRoot, { recursive: true, force: true }) })
  const identity = dirname(h.markerPath), externalOperations: string[] = []
  let escaped = false, assertions = 0
  const targetAssertion = stage === 'temp' ? 1 : stage === 'rename' ? 2 : 3
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const originalOpen = fs.open.bind(fs), originalRename = fs.rename.bind(fs)
  const escape = async () => {
    if (escaped) return
    await originalRename(identity, join(externalRoot, 'identities'))
    await symlink(join(externalRoot, 'identities'), identity)
    escaped = true
  }
  const write = durable.durableWriteFile
  vi.spyOn(durable, 'durableWriteFile').mockImplementationOnce(async (path, content, options) => {
    const assertDirectory = options?.assertDirectory
    await write(path, content, { ...options, assertDirectory: async () => {
      await assertDirectory?.()
      assertions++
      if (assertions === targetAssertion) await escape()
    } })
  })
  vi.spyOn(fs, 'open').mockImplementation((async (path: any, flags: any, mode?: any) => {
    if (escaped && String(path).startsWith(h.markerPath + '.') && String(path).endsWith('.tmp')) externalOperations.push('temp')
    if (escaped && String(path) === identity && flags === 'r') externalOperations.push('sync')
    return await originalOpen(path, flags, mode)
  }) as any)
  vi.spyOn(fs, 'rename').mockImplementation((async (from: any, to: any) => {
    if (stage === 'rename' && escaped) externalOperations.push('rename')
    await originalRename(from, to)
  }) as any)
  syncBuiltinESMExports()
  const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
  const outcome = await h.client.prepareAgentExecutionHelper(h.input).then(value => ({ value }), error => ({ error }))
  expect(outcome).toHaveProperty('error')
  expect((outcome as { error: Error }).error).toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(prepareTerminal).not.toHaveBeenCalled()
  expect(escaped).toBe(true)
  expect(externalOperations).not.toContain(stage)
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

it('re-acknowledges a provisioned rename after a real parent fsync failure before Provider build', async () => {
  const h = await ownedFixture()
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.open.bind(fs), events: string[] = []
  let lostAck = false
  vi.spyOn(fs, 'open').mockImplementation((async (path: any, flags: any, mode?: any) => {
    const handle = await original(path, flags, mode)
    if (String(path) === h.markerPath) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { events.push('marker-sync'); await sync() })
    }
    if (String(path) === dirname(h.markerPath) && flags === 'r') {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        const phase = await readFile(h.markerPath, 'utf8').then(raw => JSON.parse(raw).phase).catch(() => null)
        if (phase === 'provisioned' && !lostAck) {
          lostAck = true
          throw new Error('real after-replace parent ACK failure')
        }
        if (phase === 'provisioned') events.push('parent-sync')
        await sync()
      })
    }
    return handle
  }) as any)
  syncBuiltinESMExports()
  const prepare = h.client.prepareTerminal.bind(h.client)
  vi.spyOn(h.client, 'prepareTerminal').mockImplementation(async input => { events.push('provider-build'); return await prepare(input) })
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  expect(lostAck).toBe(true)
  expect(JSON.parse(await readFile(h.markerPath, 'utf8')).phase).toBe('provisioned')
  const before = await lstat(h.locator.workspacePath)
  await h.client.prepareAgentExecutionHelper(h.input)
  expect((await lstat(h.locator.workspacePath)).ino).toBe(before.ino)
  for (const event of ['marker-sync', 'parent-sync']) {
    expect(events.indexOf(event)).toBeGreaterThanOrEqual(0)
    expect(events.indexOf(event)).toBeLessThan(events.indexOf('provider-build'))
  }
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

it.each(['win32', 'freebsd'] as const)('fails closed before allocation when %s cannot provide descriptor semantics', async platform => {
  const h = await ownedFixture()
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  await expect(h.client.prepareAgentExecutionHelper(h.input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
  await expect(lstat(dirname(h.locator.workspacePath))).rejects.toMatchObject({ code: 'ENOENT' })
})

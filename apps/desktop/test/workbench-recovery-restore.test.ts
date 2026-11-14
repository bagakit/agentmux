import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recoveryDigest, spaceCloseDecisions, type RecoveryRestoreMember } from '@agentmux/core'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import { WorkbenchCloseOwner, type WorkbenchClosePorts } from '../src/main/workbench-close-owner'
import { DesktopStorageRecoveryExports } from '../src/main/storage-recovery-exports'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { runDesktopStorageHostProbe } from './helpers/storage-recovery-host-probe'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))) })
async function fixture() { const root = await mkdtemp('/tmp/amux-original-restore-'); roots.push(root); return root }
async function member(root: string, id: string, target: string, value: string): Promise<RecoveryRestoreMember> {
  const file = join(root, recoveryDigest(id + value)); await writeFile(file, value, { mode: 0o600 })
  return { id, target, file, capturedAt: 1, kind: 'file', sha256: recoveryDigest(value), operationId: 'original-restore' }
}
const document = () => JSON.stringify({ version: 1, state: { agentComposerDrafts: { region: 'Original private unsent input' },
  desktopFragments: { fragment: { draft: 'Original fragment input' } }, agentSteerQueues: { original: [{ operationId: 'original-input', runId: 'original-run', text: 'Original queue input', status: 'queued', promptCondition: null }] } } })

it('restores the original native document before first load, preserving drafts and holding every old queued intent', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'original.json')), source = store.recoverySource(), raw = document()
  const original = await member(root, 'document', store.path, raw), output = join(root, 'prepared'); await mkdir(output)
  await expect(source.restoreMissing!(original)).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_PREPARATION_REQUIRED' })
  await writeFile(store.path, raw, { mode: 0o600 })
  await expect(source.restoreMissing!(original)).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_PREPARATION_REQUIRED' })
  await unlink(store.path)
  const result = await source.prepareRestore!([original], output)
  expect(result.state).toBe('prepared'); if (result.state !== 'prepared') throw Error('Exact original preparation required')
  await expect(readFile(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const prepared = result.members[0]!, parsed = JSON.parse(await readFile(prepared.file, 'utf8'))
  expect(parsed.state.agentComposerDrafts.region).toBe('Original private unsent input')
  expect(parsed.state.desktopFragments.fragment.draft).toBe('Original fragment input')
  expect(parsed.state.agentSteerQueues.original[0]).toMatchObject({ operationId: 'original-input', runId: 'original-run', text: 'Original queue input', awaitingExplicitSend: true, promptCondition: null })
  expect(await readFile(original.file, 'utf8')).toBe(raw)
  expect(await source.restoreMissing!(prepared)).toBe('restored')
  // A cold original owner has no ephemeral capture or prepare Maps.
  expect(await new WorkbenchUserStateStore(store.path).recoverySource().restoreMissing!(prepared)).toBe('same')
  expect(JSON.parse((await store.read())!)).toEqual(JSON.parse(await readFile(prepared.file, 'utf8')))
  expect(await source.restoreMissing!(prepared)).toBe('same')
  await store.write(JSON.stringify({ version: 1, state: { agentComposerDrafts: { region: 'Newer authored input' } } }))
  expect(await source.restoreMissing!(prepared)).toBe('conflict')
  expect(JSON.parse((await store.read())!).state.agentComposerDrafts.region).toBe('Newer authored input')
})

it('retains an open document and a later admitted writer instead of publishing old backup bytes into current input', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'original.json')), original = await member(root, 'document', store.path, document())
  const output = join(root, 'prepared'); await mkdir(output)
  const result = await store.recoverySource().prepareRestore!([original], output)
  if (result.state !== 'prepared') throw Error('Expected the original cold preparation')
  expect(await store.read()).toBeNull()
  await expect(store.recoverySource().restoreMissing!(result.members[0]!)).rejects.toMatchObject({ code: 'DESKTOP_DOCUMENT_ALREADY_OPEN' })
  await expect(readFile(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const state = { agentComposerDrafts: { region: 'New pending author image' } }
  const value = JSON.stringify({ version: 1, state, inputQueueDelta: { changes: [] } })
  const saving = store.writeFromRenderer({}, { value, writeRevision: 1 }, () => true)
  expect(await store.recoverySource().restoreMissing!(result.members[0]!)).toBe('conflict')
  await expect(saving).resolves.toMatchObject({ diskDurability: 'confirmed' })
  expect(JSON.parse((await store.read())!).state.agentComposerDrafts).toEqual(state.agentComposerDrafts)
})

it('returns exact unavailable pending launch selectors and refuses substituted or unprotected source members', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'original.json')), output = join(root, 'prepared'); await mkdir(output)
  const raw = JSON.stringify({ version: 1, state: { pendingAgentLaunches: { 'original-session': { request: { createOperationId: 'original-create' } } } } })
  const original = await member(root, 'document', store.path, raw)
  expect(await store.recoverySource().prepareRestore!([original], output)).toEqual({ state: 'unavailable', selectors: [{ memberId: 'document', agentSessionId: 'original-session', reason: 'DESKTOP_RECOVERY_PENDING_LAUNCH_UNCONFIRMED' }] })
  const clean = await member(root, 'document', store.path, document()), link = join(root, 'link'); await symlink(clean.file, link)
  for (const changed of [{ target: join(root, 'another.json') }, { id: 'document/../another.json' }, { sha256: '0'.repeat(64) }, { file: link }, { kind: 'session-database' as const }]) {
    const result = await store.recoverySource().prepareRestore!([{ ...clean, ...changed }], output)
    expect(result.state).toBe('unavailable')
  }
  await expect(readFile(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('validates exact auxiliary owner hashes and protects a live reading preference', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'original.json')), output = join(root, 'prepared'); await mkdir(output)
  const owner = { regionId: 'original-region', workspaceId: 'original-space', hostId: 'local', workspacePath: '/original/workspace', path: '/original/book' }
  const key = JSON.stringify(Object.values(owner)), hash = recoveryDigest(key), id = 'file-view-reading/' + hash + '.json'
  const raw = JSON.stringify({ schema: 'agentmux.file-view-reading.v1', owner, position: { section: 2, sectionId: 'original-section', progress: 0.5 } }) + '\n'
  const original = await member(root, id, join(store.path + '.file-view-reading', hash + '.json'), raw)
  const prepared = await store.recoverySource().prepareRestore!([original], output)
  expect(prepared.state).toBe('prepared'); if (prepared.state !== 'prepared') throw Error('Expected exact reading owner')
  expect(await store.readFileViewReading(owner)).toBeNull()
  await expect(store.recoverySource().restoreMissing!(prepared.members[0]!)).rejects.toMatchObject({ code: 'DESKTOP_DOCUMENT_ALREADY_OPEN' })
  const cold = new WorkbenchUserStateStore(store.path)
  expect(await cold.recoverySource().restoreMissing!(prepared.members[0]!)).toBe('restored')
  expect(await cold.readFileViewReading(owner)).toMatchObject({ owner, position: { section: 2 } })
  await expect(cold.writeFileViewReading({ owner, position: { section: 3, sectionId: 'new-user-section', progress: 0.8 } })).resolves.toMatchObject({ diskDurability: 'confirmed', owner })
  await cold.flushFileViewReadings()
  expect(await cold.readFileViewReading(owner)).toMatchObject({ position: { section: 3 } })
})

it('restores original Window identity before load and never replaces current native arrangement', async () => {
  const root = await fixture(), target = join(root, 'windows.json'), store = new WorkbenchWindowStore(target), output = join(root, 'prepared'); await mkdir(output)
  const raw = JSON.stringify({ schema: 'agentmux.workbench-windows.v1', mainWindowId: 'original-main-window', windows: [] }) + '\n'
  const original = await member(root, 'document', target, raw), result = await store.recoverySource().prepareRestore!([original], output)
  if (result.state !== 'prepared') throw Error('Expected exact Window owner')
  expect(await store.recoverySource().restoreMissing!(result.members[0]!)).toBe('restored')
  expect((await store.load()).state.mainWindowId).toBe('original-main-window')
  expect(await store.recoverySource().restoreMissing!(result.members[0]!)).toBe('same')
  await store.save({ mainWindowId: 'new-native-window', windows: [] })
  expect(await store.recoverySource().restoreMissing!(result.members[0]!)).toBe('conflict')
  await unlink(target)
  await expect(store.recoverySource().restoreMissing!(result.members[0]!)).rejects.toMatchObject({ code: 'DESKTOP_DOCUMENT_ALREADY_OPEN' })
})

it('unknown original recovery members cannot be silently initialized as new empty documents', async () => {
  const root = await fixture(), user = new WorkbenchUserStateStore(join(root, 'user.json')), windows = new WorkbenchWindowStore(join(root, 'windows.json'))
  user.retainRecoveryGaps(['document'], 'RECOVERY_SOURCE_UNAVAILABLE'); windows.retainRecoveryGaps(['document'])
  await expect(user.read()).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_SOURCE_UNCONFIRMED' })
  await expect(user.write(document())).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_SOURCE_UNCONFIRMED' })
  expect(await windows.load()).toMatchObject({ writable: false })
  await expect(windows.save({ mainWindowId: 'unconfirmed-default', windows: [] })).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_SOURCE_UNCONFIRMED' })
  await expect(readFile(user.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'windows.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('prepares a complete Close cohort in owner dependency order and recovered preparation never repeats effects', async () => {
  const root = await fixture(), user = new WorkbenchUserStateStore(join(root, 'user.json')), authority = { ownerId: 'original-owner', endpoint: 'unix:/original', documentGeneration: 'original-document' }
  const ports = { authority: () => authority, capture: async () => ({ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', closesView: false, surfaces: [], resources: [], reservedSessionIds: [], drafts: [], otherOccurrences: [] }), reserve: vi.fn(), commit: vi.fn(), effect: vi.fn() } as unknown as WorkbenchClosePorts
  const initial = new WorkbenchCloseOwner(user, ports), context = { actor: { kind: 'user' as const, id: 'original-user' }, originalContext: {} }
  const { operation } = await initial.call('space.close.prepare', { operationId: 'original-close', target: { kind: 'tab-occurrence', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }, keepAgentSessions: true }, context)
  if (!operation) throw Error('Expected original close preparation')
  const marker = join(user.path + '.close-operations', recoveryDigest(operation.operationId) + '.json.apply')
  await writeFile(marker, JSON.stringify({ planDigest: operation.planDigest, approvedBy: context.actor, decisions: spaceCloseDecisions(operation.plan) }) + '\n', { mode: 0o600 })
  const originalDirectory = join(root, 'original-cut'); await mkdir(originalDirectory)
  const cut = await initial.recoverySource().capture(originalDirectory), members = await Promise.all(cut.members.map(async value => ({ ...value, sha256: recoveryDigest(await readFile(value.file)), operationId: 'original-restore' })))
  for (const value of members) await unlink(value.target)
  const cold = new WorkbenchCloseOwner(user), output = join(root, 'prepared'); await mkdir(output)
  await expect(cold.recoverySource().restoreMissing!(members.find(value => value.id.endsWith('.json'))!)).rejects.toMatchObject({ code: 'DESKTOP_RECOVERY_PREPARATION_REQUIRED' })
  const incomplete = await cold.recoverySource().prepareRestore!([members.find(value => value.id.endsWith('.json'))!], output)
  expect(incomplete).toMatchObject({ state: 'unavailable', selectors: [{ reason: 'DESKTOP_RECOVERY_CLOSE_COHORT_REQUIRED' }] })
  const prepared = await cold.recoverySource().prepareRestore!([...members].reverse(), output)
  expect(prepared.state).toBe('prepared'); if (prepared.state !== 'prepared') throw Error('Expected original cohort')
  expect(prepared.members[0]!.id.endsWith('.json')).toBe(true)
  expect(JSON.parse(await readFile(prepared.members[0]!.file, 'utf8')).outcome).toBe('unknown')
  for (const value of prepared.members) expect(await cold.recoverySource().restoreMissing!(value)).toBe('restored')
  cold.bindPorts(ports)
  const result = await cold.call('space.close.apply', { operationId: operation.operationId, expectedPlanDigest: operation.planDigest, decisions: spaceCloseDecisions(operation.plan) }, context)
  expect(result.operation).toMatchObject({ operationId: operation.operationId, outcome: 'unknown' })
  expect(ports.reserve).not.toHaveBeenCalled(); expect(ports.effect).not.toHaveBeenCalled(); expect(ports.commit).not.toHaveBeenCalled()
})

it('the original Main restore port is consumed by a second real Host process through typed Unix preparation and restoration', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'user.json')), socket = join(root, 'desktop.sock')
  const original = await member(root, 'desktop.user-state/document', store.path, document()), exports = new DesktopStorageRecoveryExports(join(root, 'exports'), () => [store.recoverySource()])
  const server = new AgentMuxControlServer({ socketPath: socket, storageRecoveryExports: exports })
  try {
    await server.start()
    const child = await runDesktopStorageHostProbe(root, socket, [original])
    expect(child.code, child.stderr).toBe(0)
    const proof = JSON.parse(child.stdout)
    expect(proof.pid).not.toBe(process.pid); expect(proof.outcomes).toEqual(['restored'])
    expect(JSON.parse((await store.read())!).state.agentSteerQueues.original[0].awaitingExplicitSend).toBe(true)
    expect(await readdir(join(root, 'exports'))).toEqual([])
    expect(await readFile(original.file, 'utf8')).toBe(document())
  } finally { await server.stop(); exports.dispose() }
}, 40_000)

it('the original Main restores a SQLite cut including cold archive rows through the real Host', async () => {
  const root = await fixture(), store = new WorkbenchUserStateStore(join(root, 'user.json')), socket = join(root, 'desktop.sock')
  const raw = JSON.parse(document())
  const archived = {
    operationId: 'retained-archived', text: 'Independent original archive', archived: true, enqueuedAt: 2,
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: 'original', run: { runId: 'original-run' } },
    directInputBinding: { expectedRun: { runId: 'original-run' } },
    inputReceipt: { status: 'terminal-confirmed', persistence: 'confirmed', key: {
      kind: 'prompt', agentSessionId: 'original', submissionId: 'retained-archived', expectedRun: { runId: 'original-run' }
    } }
  }
  raw.state.agentSteerQueues.original.push(archived)
  await store.write(JSON.stringify(raw))
  const output = join(root, 'capture'); await mkdir(output)
  const cut = await store.recoverySource().capture(output)
  expect(cut.gaps).toEqual([])
  expect(cut.members).toMatchObject([{ id: 'document', target: store.databasePath, kind: 'file' }])
  const selected = cut.members[0]!, original = await readFile(selected.file)
  const member = { ...selected, id: 'desktop.user-state/document', sha256: recoveryDigest(original), operationId: 'original-sqlite-restore' }
  await unlink(store.databasePath)
  const cold = new WorkbenchUserStateStore(store.path)
  const exports = new DesktopStorageRecoveryExports(join(root, 'exports'), () => [cold.recoverySource()])
  const server = new AgentMuxControlServer({ socketPath: socket, storageRecoveryExports: exports })
  try {
    await server.start()
    const child = await runDesktopStorageHostProbe(root, socket, [member])
    expect(child.code, child.stderr).toBe(0)
    const proof = JSON.parse(child.stdout)
    expect(proof.pid).not.toBe(process.pid)
    expect(proof.outcomes).toEqual(['restored'])
    expect(JSON.parse((await cold.read())!).state).toMatchObject({
      agentComposerDrafts: raw.state.agentComposerDrafts,
      agentSteerQueues: { original: [{ operationId: 'original-input', runId: 'original-run', awaitingExplicitSend: true }] }
    })
    expect((await cold.readInputArchive({ ownerKey: 'original', operationId: archived.operationId })).entries)
      .toEqual([{ ownerKey: 'original', entry: { ...archived, awaitingExplicitSend: true } }])
    expect(await readFile(selected.file)).toEqual(original)
  } finally { await server.stop(); exports.dispose() }
}, 40_000)

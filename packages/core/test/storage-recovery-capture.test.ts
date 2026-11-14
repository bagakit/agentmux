import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const control = vi.hoisted(() => ({ directoryFailure: '', beforeBackup: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (path: any, ...args: any[]) => {
    const file = await (fs.open as any)(path, ...args)
    if (String(path) === control.directoryFailure && (await file.stat()).isDirectory()) file.sync = async () => { throw Object.assign(Error('controlled directory EIO'), { code: 'EIO' }) }
    return file
  } }
})
vi.mock('node:sqlite', async original => {
  const sqlite = await original<typeof import('node:sqlite')>()
  return { ...sqlite, backup: async (...args: any[]) => { await control.beforeBackup?.(); return (sqlite.backup as any)(...args) } }
})

import { AgentMuxStorageRecovery, snapshotRecoveryFile, type RecoverySource } from '../src/storage-recovery.js'
import { sessionRecoverySource } from '../src/storage-recovery-sources.js'
import { AgentMuxFileAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { claudeRecoveryFiles } from '../src/providers/claude-native-catalog.js'
import { codexRecoveryFiles } from '../src/providers/codex-native-catalog.js'
import { grokRecoveryFiles } from '../src/providers/grok-native-history.js'
import { recoveryDirectorySource, hashRecoveryFile } from '../src/storage-recovery.js'
import { semanticRecoverySource } from '../src/storage-recovery-sources.js'

const roots: string[] = [], owners: AgentMuxStorageRecovery[] = []
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-backup-'))); roots.push(path); return path }
function owner(path: string, sources: RecoverySource[], generations = 3) { const value = new AgentMuxStorageRecovery(join(path, 'recovery'), 'original-namespace', sources, generations); owners.push(value); return value }
function fileSource(id: string, path: string) {
  const capture = vi.fn(async (output: string) => {
    const file = join(output, 'original'), revision = await snapshotRecoveryFile(path, file)
    return { revision, members: [{ id: 'original', target: path, file, kind: 'file' as const, capturedAt: Date.now(), revision }], gaps: [] }
  })
  return { id, capture }
}
afterEach(async () => {
  control.directoryFailure = ''; control.beforeBackup = undefined
  for (const value of owners.splice(0)) await value.dispose()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

it('captures the full original physical database including private future tables, incarnation and historical rows', async () => {
  const path = await root(), store = new AgentMuxFileAgentSessionStore(join(path, 'sessions.sqlite'))
  await store.loadMetadata()
  const db = new DatabaseSync(store.path)
  db.exec('CREATE TABLE preservation_probe (id TEXT PRIMARY KEY, private_json TEXT NOT NULL)')
  db.prepare('INSERT INTO preservation_probe VALUES (?, ?)').run('original-proof', JSON.stringify({ privateSeed: 'synthetic-secret', receipt: 'original-ack' }))
  const incarnation = String(db.prepare('SELECT incarnation FROM identity').get()!.incarnation); db.close()
  const recovery = owner(path, [sessionRecoverySource(store)]), receipt = await recovery.capture()
  expect(receipt.gaps).toEqual([]); expect(receipt.memberCount).toBe(3)
  const { manifest } = await recovery.readManifest(receipt.generationId), member = manifest.sources[0]!.members.find(member => member.id === 'database')!
  const snapshot = new DatabaseSync(recovery.blobPath(member.sha256), { readOnly: true })
  try {
    expect(snapshot.prepare("SELECT 1 FROM sqlite_schema WHERE name='preservation_probe'").get()).toBeTruthy()
    expect(snapshot.prepare('SELECT private_json FROM preservation_probe WHERE id=?').get('original-proof')?.private_json).toContain('original-ack')
    expect(snapshot.prepare('SELECT incarnation FROM identity').get()?.incarnation).toBe(incarnation)
  } finally { snapshot.close() }
  const marker = manifest.sources[0]!.members.find(member => member.id === 'incarnation')!
  expect(await readFile(recovery.blobPath(marker.sha256), 'utf8')).toBe(incarnation)
  expect((await recovery.inspect(receipt.generationId)).manifestHash).toBe(receipt.manifestHash)
})

it('slow online backup keeps a consistent original incarnation while ordinary saving continues', async () => {
  const path = await root(), store = new AgentMuxFileAgentSessionStore(join(path, 'sessions.sqlite'))
  const original = normalizeStoredAgentSession({ kind: 'agent', agentSessionId: 'original-session', providerId: 'claude', executorId: 'proof',
    hostId: 'local', workspacePath: path, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'binding', hookToken: 'token' })
  await store.compareAndSwap(null, original)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  control.beforeBackup = async () => { enter(); await held }
  const recovery = owner(path, [sessionRecoverySource(store)]), capturing = recovery.capture()
  await entered
  const writer = new AgentMuxFileAgentSessionStore(store.path)
  let committed = false
  const changing = writer.compareAndSwap(original, { ...original, updatedAt: 2 }).then(() => { committed = true })
  try { await changing.catch(() => {}); expect(committed).toBe(true) } finally { release() }
  const captured = await capturing
  const snapshotMember = (await recovery.readManifest(captured.generationId)).manifest.sources[0]!.members[0]!
  const snapshotStore = new AgentMuxFileAgentSessionStore(recovery.blobPath(snapshotMember.sha256))
  expect((await snapshotStore.readMetadata(original.agentSessionId))?.updatedAt).toBe(2)
  expect((await store.readMetadata(original.agentSessionId))?.updatedAt).toBe(2)
})

it('automatic capture updates only changed owners and retains original cuts for unrelated sources', async () => {
  const path = await root(), first = join(path, 'draft.json'), second = join(path, 'native.jsonl')
  await writeFile(first, 'draft-1'); await writeFile(second, 'native-original')
  const draft = fileSource('draft', first), native = fileSource('native', second), recovery = owner(path, [draft, native])
  const before = await recovery.capture(), initial = (await recovery.readManifest(before.generationId)).manifest
  await writeFile(first, 'draft-2'); recovery.changed('draft')
  const after = await recovery.capture({ changedOnly: true }), result = (await recovery.readManifest(after.generationId)).manifest
  expect(draft.capture).toHaveBeenCalledTimes(2); expect(native.capture).toHaveBeenCalledTimes(1)
  expect(result.sources.find(source => source.id === 'native')).toEqual(initial.sources.find(source => source.id === 'native'))
  expect(result.sources.find(source => source.id === 'draft')!.members[0]!.sha256).not.toBe(initial.sources.find(source => source.id === 'draft')!.members[0]!.sha256)
})

it('a source gap preserves its newest usable original across incomplete generations and bounded reclamation', async () => {
  const path = await root(), sourcePath = join(path, 'original'), source = fileSource('original-owner', sourcePath)
  await writeFile(sourcePath, 'recoverable-original')
  const recovery = owner(path, [source], 2), original = await recovery.capture()
  const originalMember = (await recovery.readManifest(original.generationId)).manifest.sources[0]!.members[0]!
  await unlink(sourcePath)
  for (let index = 0; index < 4; index++) { await new Promise(resolve => setTimeout(resolve, 2)); const receipt = await recovery.capture(); expect(receipt.gaps.length).toBeGreaterThan(0) }
  expect((await recovery.list()).some(value => value.generationId === original.generationId)).toBe(true)
  expect(await readFile(recovery.blobPath(originalMember.sha256), 'utf8')).toBe('recoverable-original')
  expect((await readdir(join(recovery.directory, 'generations'))).length).toBeLessThanOrEqual(3)
})

it('an unrelated permanent gap never expires the only valid member in the same native owner', async () => {
  const path = await root(), sourcePath = join(path, 'original'), source = fileSource('native', sourcePath), capture = source.capture
  source.capture = vi.fn(async output => { const result = await capture(output); return { ...result, gaps: [{ sourceId: 'native', memberId: 'unrelated-B', code: 'RECOVERY_REMOTE_SOURCE_UNAVAILABLE' }] } })
  await writeFile(sourcePath, 'only-original-A')
  const recovery = owner(path, [source], 2), original = await recovery.capture()
  expect(original.gaps).toHaveLength(1)
  await unlink(sourcePath)
  for (let index = 0; index < 4; index++) { await new Promise(resolve => setTimeout(resolve, 2)); await recovery.capture() }
  expect((await recovery.list()).some(value => value.generationId === original.generationId)).toBe(true)
})

it('strict manifest directory ACK failure stays unknown and leaves the previous verified generation usable', async () => {
  const path = await root(), file = join(path, 'original'); await writeFile(file, 'old')
  const recovery = owner(path, [fileSource('owner', file)]), original = await recovery.capture()
  await writeFile(file, 'new'); control.directoryFailure = join(recovery.directory, 'generations')
  await expect(recovery.capture()).rejects.toThrow()
  expect(recovery.status().state).toBe('unavailable')
  control.directoryFailure = ''
  expect((await recovery.inspect(original.generationId)).generationId).toBe(original.generationId)
  expect((await recovery.capture()).gaps).toEqual([])
})

it('a corrupt preexisting content object never becomes a verified member of a new generation', async () => {
  const path = await root(), file = join(path, 'original'); await writeFile(file, 'exact-original')
  const recovery = owner(path, [fileSource('owner', file)]), original = await recovery.capture()
  const member = (await recovery.readManifest(original.generationId)).manifest.sources[0]!.members[0]!
  await writeFile(recovery.blobPath(member.sha256), 'corrupt')
  const result = await recovery.capture()
  expect(result.memberCount).toBe(0); expect(result.gaps.length).toBeGreaterThan(0)
  await expect(recovery.inspect(original.generationId)).rejects.toThrow()
})

it('a corrupt old generation cannot block a healthy new full capture or leak its pending directory', async () => {
  const path = await root(), file = join(path, 'original'); await writeFile(file, 'old-A')
  const recovery = owner(path, [fileSource('owner', file)]), original = await recovery.capture()
  const member = (await recovery.readManifest(original.generationId)).manifest.sources[0]!.members[0]!
  await writeFile(recovery.blobPath(member.sha256), 'corrupt-old-A'); await writeFile(file, 'live-new-B')
  const result = await recovery.capture()
  expect(result.memberCount).toBe(1); expect(result.gaps).toEqual([])
  expect((await recovery.inspect(result.generationId)).generationId).toBe(result.generationId)
  expect(await readdir(join(recovery.directory, 'pending'))).toEqual([])
  expect((await readdir(join(recovery.directory, 'generations'))).includes(original.generationId + '.json')).toBe(true)
})

it('background maintenance failure never rejects an accepted original Session commit', async () => {
  const path = await root(), store = new AgentMuxFileAgentSessionStore(join(path, 'sessions.sqlite'))
  let called = 0
  const off = store.observeDurableChanges(() => { called++; throw Error('maintenance failed') })
  const session = normalizeStoredAgentSession({ kind: 'agent', agentSessionId: 'commit-with-broken-maintenance', providerId: 'claude', executorId: 'proof',
    hostId: 'local', workspacePath: path, run: { runId: 'retained-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'binding', hookToken: 'token' })
  try { await expect(store.compareAndSwap(null, session)).resolves.toBeUndefined(); expect(called).toBe(1); expect((await store.readMetadata(session.agentSessionId))?.run.runId).toBe('retained-run') } finally { off() }
})

it('a database member cannot select file-format validation to bypass its original incarnation', async () => {
  const path = await root(), original = new AgentMuxFileAgentSessionStore(join(path, 'original.sqlite')), foreign = new AgentMuxFileAgentSessionStore(join(path, 'foreign.sqlite'))
  await original.loadMetadata(); await foreign.loadMetadata(); await unlink(original.path)
  const file = foreign.path, hashed = await hashRecoveryFile(file)
  await expect(original.restoreRecoveryMember({ id: 'database', target: original.path, file, kind: 'file', capturedAt: Date.now(), sha256: hashed.sha256, operationId: 'same-original-operation' }))
    .rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
})

it('native backup qualification binds exact Provider identity and cwd before and after staging', async () => {
  const path = await root(), signal = new AbortController().signal
  const claudePath = join(path, 'claude/projects/project/claude-original.jsonl'), codexPath = join(path, 'codex/sessions/rollout-original.jsonl')
  await mkdir(join(path, 'claude/projects/project'), { recursive: true }); await mkdir(join(path, 'codex/sessions'), { recursive: true })
  await writeFile(claudePath, JSON.stringify({ type: 'user', isSidechain: false, sessionId: 'claude-original', cwd: path, timestamp: new Date().toISOString() }) + '\n')
  await writeFile(codexPath, JSON.stringify({ type: 'session_meta', payload: { id: 'codex-original', cwd: path, source: 'cli' } }) + '\n')
  for (const [providerId, transcriptPath, qualify, env] of [
    ['claude', claudePath, claudeRecoveryFiles, { CLAUDE_CONFIG_DIR: join(path, 'claude') }],
    ['codex', codexPath, codexRecoveryFiles, { CODEX_HOME: join(path, 'codex') }]
  ] as const) {
    const context = { source: { providerId, nativeSessionId: providerId + '-original' }, transcriptPath, workspacePath: path, env, signal, command: '', args: [], limit: 1 }
    const cohort = await qualify(context); expect(cohort.gaps).toEqual([]); expect(cohort.files).toHaveLength(1)
    await expect(qualify({ ...context, source: { ...context.source, nativeSessionId: 'another-native-session' } })).rejects.toThrow()
    await expect(qualify({ ...context, workspacePath: join(path, 'foreign-cwd') })).rejects.toThrow()
    await writeFile(transcriptPath, JSON.stringify(providerId === 'claude'
      ? { type: 'user', isSidechain: false, sessionId: 'foreign-native', cwd: path }
      : { type: 'session_meta', payload: { id: 'foreign-native', cwd: path, source: 'cli' } }) + '\n')
    await expect(cohort.assertCurrent!()).rejects.toThrow()
  }
})

it('Grok retains the whole summary-qualified cohort and detects late members or subject changes', async () => {
  const path = await root(), directory = join(path, 'native-original'), signal = new AbortController().signal
  await mkdir(directory)
  const context = { source: { providerId: 'grok', nativeSessionId: 'native-original' }, workspacePath: path, env: {}, signal, command: '', args: [], limit: 1, transcriptPath: join(directory, 'updates.jsonl') }
  await writeFile(context.transcriptPath, '{}\n'); await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'native-original', cwd: path } }))
  await writeFile(join(directory, 'chat_history.jsonl.gz'), 'synthetic-compressed-original')
  const cohort = await grokRecoveryFiles(context)
  expect(cohort.files.map(file => file.id)).toEqual(['chat_history.jsonl.gz', 'summary.json', 'updates.jsonl'])
  await cohort.assertCurrent(); await writeFile(join(directory, 'late-original'), 'late')
  await expect(cohort.assertCurrent()).rejects.toMatchObject({ code: 'RECOVERY_NATIVE_COHORT_CHANGED' })
  await unlink(join(directory, 'late-original'))
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'foreign-native', cwd: path } }))
  await expect(grokRecoveryFiles(context)).rejects.toThrow()
})

it('semantic sources scan only the composing owner roots, preserving unrelated application data', async () => {
  const path = await root(), output = join(path, 'output'), identity = join(path, 'semantic-runtime.json')
  await mkdir(output); await writeFile(identity, 'original-identity'); await mkdir(join(path, 'browser-profile')); await writeFile(join(path, 'browser-profile/large-private-file'), 'unrelated')
  const source = semanticRecoverySource(path, join(path, 'recovery'), [identity])
  const result = await source.capture(output)
  expect(result.members.map(member => member.target)).toEqual([identity]); expect(result.gaps).toEqual([])
  expect(await readFile(join(path, 'browser-profile/large-private-file'), 'utf8')).toBe('unrelated')
})

it('a failed source watch stays visible until that subscription actually recovers, without blocking other owners', async () => {
  const path = await root(), file = join(path, 'original'); await writeFile(file, 'original')
  const healthyFile = join(path, 'healthy'); await writeFile(healthyFile, 'healthy')
  let broken = true
  const failing = { ...fileSource('watch-failure', file), subscribe: vi.fn(() => { if (broken) throw Object.assign(Error('watch unavailable'), { code: 'EACCES' }); return () => {} }) }
  const healthy = { ...fileSource('healthy', healthyFile), subscribe: vi.fn(() => () => {}) }
  const recovery = owner(path, [failing, healthy]); recovery.start()
  expect(healthy.subscribe).toHaveBeenCalledTimes(1)
  expect(recovery.status().state).toBe('unavailable')
  const captured = await recovery.capture()
  expect(captured.gaps).toContainEqual({ sourceId: 'watch-failure', code: 'EACCES' })
  expect(recovery.status().state).toBe('unavailable')
  broken = false
  await recovery.capture()
  expect(recovery.status().state).toBe('idle'); expect(healthy.subscribe).toHaveBeenCalledTimes(1)
})

it('the Session source observes another valid Store writer rather than only its own object callbacks', async () => {
  const path = await root(), first = new AgentMuxFileAgentSessionStore(join(path, 'sessions.sqlite')), second = new AgentMuxFileAgentSessionStore(first.path)
  await first.loadMetadata()
  let changed!: () => void
  const observed = new Promise<void>(resolve => { changed = resolve }), source = sessionRecoverySource(first), stop = source.subscribe!(changed)
  try {
    const session = normalizeStoredAgentSession({ kind: 'agent', agentSessionId: 'independent-writer', providerId: 'claude', executorId: 'proof',
      hostId: 'local', workspacePath: path, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'binding', hookToken: 'token' })
    await second.compareAndSwap(null, session)
    await Promise.race([observed, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(Error('Original Session source did not observe the independent writer.')), 2000); timer.unref() })])
    expect((await first.readMetadata(session.agentSessionId))?.run.runId).toBe('original-run')
  } finally { stop() }
})

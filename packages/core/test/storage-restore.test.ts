import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { startHeadlessAgentMux } from '../src/headless-runtime.js'
import { createHash } from 'node:crypto'
import { AgentMuxStorageRecovery, hashRecoveryFile, snapshotRecoveryFile, recoveryDirectorySource, restoreMissingRecoveryFile, type RecoverySource } from '../src/storage-recovery.js'
import { openAgentMuxStorageRecovery, startAgentMuxStorageRecovery } from '../src/storage-recovery-maintenance.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { sessionRecoverySource, semanticRecoverySource } from '../src/storage-recovery-sources.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { terminalPromptPhaseOperationIdentity } from '../src/prompt-submission-record.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { parseStorageRecoveryParams } from '../src/storage-recovery-rpc.js'
import { runStorageSourceCli } from './helpers/storage-recovery-source-cli.js'
import { inspectPromptInSecondProcess } from './helpers/prompt-receipt-process.js'
import type { AgentMuxStoredAgentSession, AgentPromptSubmissionRecord } from '../src/types.js'

const control = vi.hoisted(() => ({ directory: '', afterTarget: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: any[]) => { const file = await (fs.open as any)(...args)
    if (String(args[0]) === control.directory && (await file.stat()).isDirectory()) file.sync = async () => { if (!control.afterTarget || await fs.lstat(control.afterTarget).then(() => true, () => false)) throw Object.assign(Error('controlled directory EIO'), { code: 'EIO' }) }; return file } }
})
const roots: string[] = [], stops: Array<() => Promise<unknown>> = []
const privateWrite = async (path: string, bytes: string) => { await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600) }
async function fixture() {
  const path = await mkdtemp('/tmp/amx-restore-'); roots.push(path)
  const file = join(path, 'original'), source = recoveryDirectorySource('original-owner', path, { restoreInertFiles: true, exclude: p => p !== path && p !== file })
  await privateWrite(file, 'original-saved-data')
  const owner = new AgentMuxStorageRecovery(join(path, 'recovery'), 'original-runtime', [source]); stops.push(() => owner.dispose())
  const generation = await owner.capture(), request = { operationId: 'original-operation', generationId: generation.generationId, manifestHash: generation.manifestHash }
  return { path, file, source, owner, generation, request }
}
afterEach(async () => { control.directory = ''; control.afterTarget = ''; for (const stop of stops.splice(0).reverse()) await stop(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); vi.restoreAllMocks() })

it('preflights exact missing data and restores it through the original owner without overwriting newer work', async () => {
  const f = await fixture(); await unlink(f.file)
  expect((await f.owner.restorePreflight(f.request)).items[0]?.state).toBe('missing')
  expect(await readFile(f.file, 'utf8').catch(() => null)).toBeNull()
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('complete')
  expect(await readFile(f.file, 'utf8')).toBe('original-saved-data')
  await privateWrite(f.file, 'newer-independent-work')
  const retry = await f.owner.restoreApply(f.request.operationId)
  expect(retry.items[0]?.state).toBe('restored'); expect(await readFile(f.file, 'utf8')).toBe('newer-independent-work')
})

it('retries the same durable operation after lost target directory ACK and reconfirms equal bytes', async () => {
  const f = await fixture(); await unlink(f.file); await f.owner.restorePreflight(f.request)
  control.directory = f.path; control.afterTarget = f.file
  const unknown = await f.owner.restoreApply(f.request.operationId)
  expect(unknown.state).toBe('unknown'); expect(await readFile(f.file, 'utf8')).toBe('original-saved-data')
  // Equal bytes alone must never stand in for a durable acknowledgment.
  const original = (await f.owner.readManifest(f.generation.generationId)).manifest.sources[0]!.members[0]!
  await expect(restoreMissingRecoveryFile(f.owner.blobPath(original.sha256), f.file, original.sha256)).rejects.toMatchObject({ code: 'EIO' })
  await expect(f.owner.restoreApply(f.request.operationId)).rejects.toMatchObject({ code: 'EIO' })
  control.directory = ''
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('complete')
})

it('rejects another generation or a changed manifest under the same operation ID', async () => {
  const f = await fixture(); await f.owner.restorePreflight(f.request)
  await expect(f.owner.restorePreflight({ ...f.request, manifestHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
  await expect(f.owner.restorePreflight({ ...f.request, operationId: 'other-operation', manifestHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
  expect(await readFile(f.file, 'utf8')).toBe('original-saved-data')
})

it('restores only prepared held bytes and rejects owner target or source substitution', async () => {
  const f = await fixture(); await unlink(f.file)
  f.source.prepareRestore = async (members, directory) => {
    const { mkdir } = await import('node:fs/promises'); await mkdir(directory, { mode: 0o700 })
    const file = join(directory, 'held'); await privateWrite(file, 'old-intent-held')
    return { state: 'prepared', members: [{ ...members[0]!, file, ...(await hashRecoveryFile(file)) }] }
  }
  await f.owner.restorePreflight(f.request); await f.owner.restoreApply(f.request.operationId)
  expect(await readFile(f.file, 'utf8')).toBe('old-intent-held')
  await unlink(f.file); f.source.prepareRestore = async members => ({ state: 'prepared', members: [{ ...members[0]!, target: join(f.path, 'another') }] })
  await expect(f.owner.restorePreflight({ ...f.request, operationId: 'different-target' })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
})

it('keeps unsafe intent selectors unavailable and can inspect generations without an active source', async () => {
  const f = await fixture(); await unlink(f.file)
  f.source.prepareRestore = async () => ({ state: 'unavailable', selectors: [{ reason: 'RECOVERY_PENDING_LIFECYCLE_UNAVAILABLE' }] })
  expect((await f.owner.restorePreflight(f.request)).state).toBe('unavailable')
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('unavailable')
  expect(await readFile(f.file).catch(() => null)).toBeNull()
  const maintenance = new AgentMuxStorageRecovery(f.owner.directory, 'original-runtime', [])
  expect((await maintenance.inspect(f.generation.generationId)).manifestHash).toBe(f.generation.manifestHash)
  expect((await maintenance.restorePreflight({ ...f.request, operationId: 'missing-original-owner' })).state).toBe('unavailable')
})

it('refuses corrupt staged material after preflight and retains the current missing target', async () => {
  const f = await fixture(); await unlink(f.file); await f.owner.restorePreflight(f.request)
  const member = (await f.owner.readManifest(f.generation.generationId)).manifest.sources[0]!.members[0]!
  await privateWrite(f.owner.blobPath(member.sha256), 'corrupted')
  await expect(f.owner.restoreApply(f.request.operationId)).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
  expect(await readFile(f.file).catch(() => null)).toBeNull()
})

it('keeps current different bytes across a cold operation reader and same-path no-overwrite publication', async () => {
  const f = await fixture(); await privateWrite(f.file, 'authored-after-backup')
  expect((await f.owner.restorePreflight(f.request)).items[0]?.state).toBe('retained-current')
  const cold = new AgentMuxStorageRecovery(f.owner.directory, 'original-runtime', [f.source])
  expect((await cold.restoreInspect(f.request.operationId)).items[0]?.state).toBe('retained-current')
  expect((await cold.restoreApply(f.request.operationId)).state).toBe('complete')
  expect(await readFile(f.file, 'utf8')).toBe('authored-after-backup')
  expect(await restoreMissingRecoveryFile(f.owner.blobPath((await f.owner.readManifest(f.generation.generationId)).manifest.sources[0]!.members[0]!.sha256), f.file, '0'.repeat(64))).toBe('conflict')
  expect(await readFile(f.file, 'utf8')).toBe('authored-after-backup')
})

it('serializes two original owners and binds one operation ID to the first admitted request', async () => {
  const f = await fixture(); await unlink(f.file)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  f.source.prepareRestore = async (members, directory) => {
    if (++calls === 1) { enter(); await held }
    await mkdir(directory, { mode: 0o700 })
    const file = join(directory, 'prepared'); await snapshotRecoveryFile(members[0]!.file, file)
    return { state: 'prepared', members: [{ ...members[0]!, file }] }
  }
  const one = f.owner.restorePreflight(f.request); await entered
  const other = new AgentMuxStorageRecovery(f.owner.directory, 'original-runtime', [f.source])
  try { await expect(other.restorePreflight({ ...f.request, selectors: [{ sourceId: 'original-owner', memberId: 'original' }] })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_BUSY' }) } finally { release() }
  expect((await one).state).toBe('prepared')
  delete f.source.prepareRestore
  await f.owner.restorePreflight(f.request)
  await expect(other.restorePreflight({ ...f.request, manifestHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
})

it('pins an admitted operation source and refuses a changed manifest after preflight', async () => {
  const f = await fixture(); await unlink(f.file); await f.owner.restorePreflight(f.request)
  await privateWrite(f.file, 'newer-live-file')
  for (let i = 0; i < 7; i++) { await privateWrite(f.file, 'newer-' + i); await f.owner.capture() }
  expect((await f.owner.list()).some(value => value.generationId === f.generation.generationId)).toBe(true)
  const path = join(f.owner.directory, 'generations', f.generation.generationId + '.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.createdAt++
  await privateWrite(path, JSON.stringify(manifest) + '\n')
  await expect(f.owner.restoreApply(f.request.operationId)).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
  expect(await readFile(f.file, 'utf8')).toBe('newer-6')
})

it('serves real typed Unix SDK and second-process source CLI and refuses Agent or remote restore authority', async () => {
  const f = await fixture(), socket = join(f.path, 'control.sock'), server = new AgentMuxControlServer({ socketPath: socket, storageRecovery: f.owner })
  await server.start(); stops.push(() => server.stop()); await unlink(f.file)
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); stops.push(() => sdk.dispose())
  expect((await sdk.call('storage.restore.preflight', f.request)).operation.state).toBe('prepared')
  expect((await sdk.call('storage.restore.apply', { operationId: f.request.operationId })).operation.state).toBe('complete')
  const cli = await runStorageSourceCli(f.path, socket, ['storage', 'restore', 'inspect', '--operation', f.request.operationId])
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.operation.state).toBe('complete')
  const service = new AgentMuxRpcService({ storageRecovery: f.owner })
  for (const context of [{ transport: 'http' as const, principal: { kind: 'user' as const, id: 'local' } }, { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'local' }, caller: { agentSessionId: 'other', capability: 'synthetic' } }])
    await expect(service.call('storage.restore.apply', { operationId: f.request.operationId }, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(() => parseStorageRecoveryParams('storage.restore.preflight', { ...f.request, record: { acknowledged: true } })).toThrow()
})

it('reaches original data-only maintenance after identity and database loss without minting either', async () => {
  const f = await fixture()
  const maintenance = await openAgentMuxStorageRecovery({ stateDirectory: f.path, storePath: join(f.path, 'sessions.sqlite'), recoverySources: [f.source] }); stops.push(() => maintenance.close())
  expect(await readFile(join(f.path, 'semantic-runtime.json')).catch(() => null)).toBeNull()
  expect(await readFile(join(f.path, 'sessions.sqlite')).catch(() => null)).toBeNull()
  await expect(openAgentMuxStorageRecovery({ stateDirectory: f.path, storePath: join(f.path, 'sessions.sqlite') })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_BUSY' })
  await unlink(f.file)
  expect((await maintenance.recovery.restorePreflight(f.request)).state).toBe('prepared')
  expect((await maintenance.recovery.restoreApply(f.request.operationId)).state).toBe('complete')
  expect(await readFile(f.file, 'utf8')).toBe('original-saved-data')
})

it('does not mistake a contradictory original namespace for a new maintenance owner', async () => {
  const f = await fixture(); await privateWrite(join(f.path, 'semantic-runtime.json'), JSON.stringify({ schema: 'agentmux.semantic-runtime.v1', runtimeId: 'different-runtime' }))
  await expect(openAgentMuxStorageRecovery({ stateDirectory: f.path, storePath: join(f.path, 'sessions.sqlite') })).rejects.toMatchObject({ code: 'IDENTITY_SOURCE_UNCONFIRMED' })
})

it('publishes the actual data-only factory endpoint and source CLI without activating Native or initializing a Store', async () => {
  const f = await fixture(), connect = vi.spyOn(CtxmuxRunAdapter.prototype, 'connect').mockRejectedValue(Error('controlled unavailable Native leaf'))
  const socket = join(f.path, 'maintenance.sock'), owner = await startAgentMuxStorageRecovery({ stateDirectory: f.path, storePath: join(f.path, 'missing.sqlite'), socketPath: socket, recoverySources: [f.source] })
  stops.push(() => owner.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); stops.push(() => sdk.dispose())
  const inspected = (await sdk.call('storage.backup.inspect', { generationId: f.generation.generationId })).generation
  expect(inspected.coverage).toEqual([{ sourceId: 'original-owner', memberId: 'original', kind: 'file' }])
  expect(JSON.stringify(inspected)).not.toContain(f.path)
  const cli = await runStorageSourceCli(f.path, socket, ['storage', 'backup', 'inspect', '--generation', f.generation.generationId])
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.generation.manifestHash).toBe(f.generation.manifestHash)
  expect(connect).not.toHaveBeenCalled()
  for (const name of ['missing.sqlite', 'semantic-runtime.json', 'agent-creation-identity.json']) expect(await readFile(join(f.path, name)).catch(() => null)).toBeNull()
})

it('imports exact offline SQLite evidence and restores only the original retired input receipt through its Store', async () => {
  const f = await fixture(), source = new AgentMuxFileAgentSessionStore(join(f.path, 'original.sqlite')), target = new AgentMuxFileAgentSessionStore(join(f.path, 'sessions.sqlite'))
  const one: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', run: { runId: 'original-run' }, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.path, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'synthetic-only', createdAt: 1, updatedAt: 1 }
  const text = 'original synthetic body', id = 'original-input', plan = { kind: 'render-then-submit' as const, payload: text, renderedText: text, submit: '\r' }, start = 10
  const phase = (name: 'payload' | 'submit', data: string, offset: number) => ({ operationId: terminalPromptPhaseOperationIdentity(one, id, name, data), inputByteRange: { startByte: offset, endByte: offset + Buffer.byteLength(data) }, acknowledged: true })
  const payload = phase('payload', text, start), submit = phase('submit', '\r', payload.inputByteRange.endByte)
  const record: AgentPromptSubmissionRecord = { agentSessionId: one.agentSessionId, run: one.run, admission: { operationId: payload.operationId, submissionId: id, startByte: start, endByte: submit.inputByteRange.endByte, acknowledged: true,
    inputKey: { kind: 'prompt', agentSessionId: one.agentSessionId, expectedRun: one.run, submissionId: id }, intent: { run: one.run, ownerInstanceId: 'synthetic-runtime', prompt: text, plan, message: { userContent: text }, execution: 'immediate' } },
    terminalPromptSubmission: { run: one.run, submissionId: id, promptDigest: createHash('sha256').update(text).digest('base64url'), outputCursorBytes: 1, payload, submit } }
  await source.compareAndSwap(null, { ...one, promptCompletionAdmission: record.admission, terminalPromptSubmission: record.terminalPromptSubmission })
  await target.compareAndSwap(null, { ...one, promptCompletionAdmission: record.admission })
  const reservation = { kind: 'stop' as const, agentSessionId: one.agentSessionId, expectedRun: one.run, reservationId: 'original-stop', ownerId: 'test-owner', ownerPid: process.pid, expiresAt: Date.now() + 30000, operationId: 'original-stop', stopOperation: { daemonInstance: 'no-runtime', operationKey: 'original-stop', runId: one.run.runId } }
  await target.reserveLifecycle(reservation); const retirement = await target.commitLifecycle(reservation, null)
  const owner = new AgentMuxStorageRecovery(join(f.path, 'input-recovery'), 'original-runtime', [sessionRecoverySource(target)]); stops.push(() => owner.dispose())
  const socket = join(f.path, 'input-recovery.sock'), server = new AgentMuxControlServer({ socketPath: socket, storageRecovery: owner })
  await server.start(); stops.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); stops.push(() => sdk.dispose())
  const { generation } = await sdk.call('storage.backup.import', { sourcePath: source.path, sha256: (await hashRecoveryFile(source.path)).sha256 })
  const request = { operationId: 'original-input-operation', generationId: generation.generationId, manifestHash: generation.manifestHash, inputs: [{ agentSessionId: one.agentSessionId, runId: one.run.runId, submissionId: id }] }
  expect((await sdk.call('storage.restore.preflight', request)).operation.state).toBe('prepared')
  expect((await sdk.call('storage.restore.apply', { operationId: request.operationId })).operation.state).toBe('complete')
  expect((await owner.restoreApply(request.operationId)).state).toBe('complete')
  expect((await target.readPromptAdmission(one.agentSessionId, one.run, id))?.terminalPromptSubmission).toEqual(record.terminalPromptSubmission)
  const { DatabaseSync } = await import('node:sqlite')
  const rawRecord = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?').get(one.agentSessionId, one.run.runId, JSON.stringify(['submission', id]))!.json } finally { db.close() } }
  expect(rawRecord(target.path)).toBe(rawRecord(source.path))
  expect(await target.readMetadata(one.agentSessionId)).toBeNull(); expect(await target.readRetiredAgentSession(one.agentSessionId)).toEqual(retirement)
  const cold = await inspectPromptInSecondProcess(f.path, record.admission!.inputKey!, target.path)
  expect(cold.cli.result.record.terminalPromptSubmission).toEqual(record.terminalPromptSubmission)
  await expect(owner.importSessionBackup({ sourcePath: source.path, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
})

it('uses the real Session source preparation before publishing the missing original database', async () => {
  const f = await fixture(), store = new AgentMuxFileAgentSessionStore(join(f.path, 'sessions.sqlite'))
  const one: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'kept-session', run: { runId: 'kept-run' }, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.path, retiredRuns: [], hookBindingId: 'kept-hook', hookToken: 'synthetic-only', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, one)
  const recovery = new AgentMuxStorageRecovery(join(f.path, 'session-recovery'), 'original-runtime', [sessionRecoverySource(store)]); stops.push(() => recovery.dispose())
  const generation = await recovery.capture(), request = { operationId: 'restore-original-session', generationId: generation.generationId, manifestHash: generation.manifestHash }
  await unlink(store.path)
  expect((await recovery.restorePreflight(request)).state).toBe('prepared')
  expect((await recovery.restoreApply(request.operationId)).state).toBe('complete')
  const restored = await new AgentMuxFileAgentSessionStore(store.path).readMetadata(one.agentSessionId)
  expect(restored?.agentSessionId).toBe(one.agentSessionId); expect(restored?.run).toEqual(one.run)
  expect(restored?.inputEpoch).toMatch(/^restore:/u)
  expect(restored?.inputRestoration?.operationId).toBe(request.operationId)
  expect(await store.readPromptAdmission(one.agentSessionId, one.run, 'never-claimed')).toBeNull()
})

it('observes manifest coverage and restores one owner without reading an unrelated native artifact', async () => {
  const f = await fixture(), nativeFile = join(f.path, 'unrelated-native')
  await privateWrite(nativeFile, 'unrelated-source')
  const native = recoveryDirectorySource('unrelated-native-owner', f.path, { exclude: path => path !== f.path && path !== nativeFile })
  const owner = new AgentMuxStorageRecovery(join(f.path, 'scoped-recovery'), 'original-runtime', [f.source, native]); stops.push(() => owner.dispose())
  const generation = await owner.capture(), manifest = (await owner.readManifest(generation.generationId)).manifest
  const member = manifest.sources.find(source => source.id === 'unrelated-native-owner')!.members[0]!
  await privateWrite(owner.blobPath(member.sha256), 'corrupt-unrelated-artifact'); await unlink(f.file)
  expect((await owner.list())[0]?.verification).toBe('manifest-only')
  await expect(owner.restorePreflight({ operationId: 'restore-one-owner', generationId: generation.generationId, manifestHash: generation.manifestHash,
    selectors: [{ sourceId: 'original-owner', memberId: 'original' }] })).resolves.toMatchObject({ state: 'prepared' })
  expect((await owner.restoreApply('restore-one-owner')).state).toBe('complete')
  expect(await readFile(f.file, 'utf8')).toBe('original-saved-data')
  await expect(owner.inspect(generation.generationId)).rejects.toMatchObject({ code: 'STORAGE_RECOVERY_INVALID' })
})


it('keeps a lost publication ACK unknown after newer work or a second loss instead of publishing the old point again', async () => {
  const f = await fixture(); await unlink(f.file); await f.owner.restorePreflight(f.request)
  control.directory = f.path; control.afterTarget = f.file
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('unknown')
  control.directory = ''
  await privateWrite(f.file, 'new-work-after-unknown-publication')
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('unknown')
  expect(await readFile(f.file, 'utf8')).toBe('new-work-after-unknown-publication')
  await unlink(f.file)
  expect((await f.owner.restoreApply(f.request.operationId)).state).toBe('unknown')
  expect(await readFile(f.file).catch(() => null)).toBeNull()
})

function originalGraph(path: string) {
  return { spaces: [{ spaceId: 'original-space', kind: 'topic' as const, name: 'Original', hostId: 'host', directoryPath: path, projectId: null }],
    zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory' as const, hostId: 'host', directoryPath: path, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['agent', 'browser'] }],
    regions: [{ regionId: 'agent', tabId: 'tab', kind: 'agent' as const, agentSessionId: 'original-session', runId: 'original-run', execution: { hostId: 'host', cwd: join(path, 'execution') } },
      { regionId: 'browser', tabId: 'tab', kind: 'browser' as const, agentSessionId: null, runId: null, execution: null }],
    bindings: [{ zoneId: 'zone', spaceId: 'original-space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.35, first: { type: 'leaf' as const, regionId: 'agent' }, second: { type: 'leaf' as const, regionId: 'browser' } }, activeRegionId: 'agent' } },
    resources: { tab: { browserId: 'original-browser', draft: 'unsaved-original-body' } } }
}
async function coldSpatial(path: string, socket: string, root: string) {
  const loader = fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs', import.meta.url))
  const file = fileURLToPath(new URL('./helpers/storage-spatial-reader.mjs', import.meta.url))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  if (process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS) env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS = process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, file, path, socket], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const close = new Promise<void>(resolve => child.once('close', () => resolve()))
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes })
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000)
  try {
    const ready = await new Promise<{ pid: number }>((resolve, reject) => { let text = ''; child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]!)) }); child.once('error', reject); child.once('close', code => reject(Error('Cold spatial owner exited ' + code + ': ' + errors))) })
    expect(ready.pid).not.toBe(process.pid)
    const result = await runStorageSourceCli(root, socket, ['space', 'state'])
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result.state
  } finally { clearTimeout(timer); child.stdin.end(); await close }
}

it('restores the original topology through its data-only enrolled owner and two cold SDK Unix CLI processes', async () => {
  const f = await fixture(), spatial = new AgentMuxSpatialStateStore(join(f.path, 'spatial-state.json'))
  const graph = originalGraph(f.path)
  await spatial.commit({ expectedRevision: 0, graph })
  const saved = await spatial.commit({ expectedRevision: 1, graph })
  const recovery = new AgentMuxStorageRecovery(join(f.path, 'recovery'), 'original-runtime', [spatial.storageRecoverySource()]); stops.push(() => recovery.dispose())
  const generation = await recovery.capture(); await unlink(spatial.path)
  const native = vi.spyOn(CtxmuxRunAdapter.prototype, 'connect')
  const owner = await openAgentMuxStorageRecovery({ stateDirectory: f.path, storePath: join(f.path, 'sessions.sqlite'), generationId: generation.generationId }); stops.push(() => owner.close())
  const prepared = await owner.recovery.restorePreflight({ operationId: 'restore-original-topology', generationId: generation.generationId, manifestHash: generation.manifestHash, selectors: [{ sourceId: 'core.spatial', memberId: 'original' }] })
  expect(prepared.state).toBe('prepared')
  expect((await owner.recovery.restoreApply(prepared.operationId)).state).toBe('complete')
  for (let restart = 0; restart < 2; restart++) expect(await coldSpatial(spatial.path, join(f.path, 'spatial-' + restart + '.sock'), f.path)).toEqual(saved)
  expect(native).not.toHaveBeenCalled()
  expect(await readFile(join(f.path, 'sessions.sqlite')).catch(() => null)).toBeNull()
})

it('keeps missing primary topology unknown and restores its explicit retained previous point without defaults', async () => {
  const f = await fixture(), spatial = new AgentMuxSpatialStateStore(join(f.path, 'spatial-state.json')), graph = originalGraph(f.path)
  const first = await spatial.commit({ expectedRevision: 0, graph }); await spatial.commit({ expectedRevision: 1, graph }); await unlink(spatial.path)
  await expect(spatial.read()).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' })
  await expect(spatial.commit({ expectedRevision: 0, graph })).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' })
  const owner = new AgentMuxStorageRecovery(join(f.path, 'spatial-recovery'), 'original-runtime', [spatial.storageRecoverySource()]); stops.push(() => owner.dispose())
  const generation = await owner.capture(); expect(generation.gaps.some(gap => gap.memberId === 'original')).toBe(true)
  const request = { operationId: 'restore-retained-topology', generationId: generation.generationId, manifestHash: generation.manifestHash, selectors: [{ sourceId: 'core.spatial', memberId: 'original' }] }
  expect((await owner.restorePreflight(request)).state).toBe('prepared')
  expect((await owner.restoreApply(request.operationId)).state).toBe('complete')
  expect(await spatial.read()).toEqual(first)
})

it('refuses an old topology point when a newer original previous document remains', async () => {
  const f = await fixture(), spatial = new AgentMuxSpatialStateStore(join(f.path, 'spatial-state.json')), graph = originalGraph(f.path)
  await spatial.commit({ expectedRevision: 0, graph })
  const owner = new AgentMuxStorageRecovery(join(f.path, 'spatial-recovery'), 'original-runtime', [spatial.storageRecoverySource()]); stops.push(() => owner.dispose())
  const generation = await owner.capture()
  await spatial.commit({ expectedRevision: 1, graph }); const newer = await spatial.commit({ expectedRevision: 2, graph }); await spatial.commit({ expectedRevision: 3, graph }); await unlink(spatial.path)
  const request = { operationId: 'old-topology-point', generationId: generation.generationId, manifestHash: generation.manifestHash, selectors: [{ sourceId: 'core.spatial', memberId: 'original' }] }
  await owner.restorePreflight(request)
  const result = await owner.restoreApply(request.operationId)
  expect(result).toMatchObject({ state: 'unknown', items: [expect.objectContaining({ code: 'SPATIAL_RECOVERY_NEWER_ORIGINAL_AVAILABLE' })] })
  expect(JSON.parse(await readFile(spatial.path + '.previous', 'utf8'))).toEqual(newer)
  expect(await readFile(spatial.path).catch(() => null)).toBeNull()
})

it('refuses Headless empty initialization when the original database and identity markers were lost but a recovery generation remains', async () => {
  const f = await fixture(), store = new AgentMuxFileAgentSessionStore(join(f.path, 'sessions.sqlite'))
  await store.loadMetadata()
  const owner = new AgentMuxStorageRecovery(join(f.path, 'recovery'), 'original-runtime', [sessionRecoverySource(store)]); stops.push(() => owner.dispose())
  await owner.capture()
  for (const path of [store.path, store.path + '.sqlite-identity', store.path + '.sqlite-identity.original']) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  const native = vi.spyOn(CtxmuxRunAdapter.prototype, 'connect').mockRejectedValue(Error('Controlled private Native leaf must not activate'))
  await expect(startHeadlessAgentMux({ stateDirectory: f.path, socketPath: join(f.path, 'headless.sock'), store })).rejects.toMatchObject({ code: 'IDENTITY_SOURCE_MISSING' })
  expect(native).not.toHaveBeenCalled()
  expect(await readFile(store.path).catch(() => null)).toBeNull()
  expect(await readFile(join(f.path, 'semantic-runtime.json')).catch(() => null)).toBeNull()
})


it('keeps historical source grants inert for creation and messages while restoring the exact original identity independently', async () => {
  const f = await fixture(), state = join(f.path, 'semantic'), directory = join(f.path, 'semantic-recovery')
  const original = new AgentMuxCreationAuthority({ stateDirectory: state, runtimeId: 'original-runtime' })
  const peer = new AgentMuxCreationAuthority({ stateDirectory: join(f.path, 'peer'), runtimeId: 'peer-runtime' })
  const [identity, sender] = await Promise.all([original.identity(), peer.identity()])
  const permission = { sourceRuntimeId: sender.runtimeId, publicKey: sender.publicKey, targetRuntimeId: identity.runtimeId, targetKeyFingerprint: identity.fingerprint }
  const principal = { kind: 'user' as const, id: 'original-person' }
  await original.trust(permission, principal); await original.trustMessageSource(permission, principal)
  const source = semanticRecoverySource(state, directory, original.recoveryPaths())
  const owner = new AgentMuxStorageRecovery(directory, identity.runtimeId, [source]); stops.push(() => owner.dispose())
  const generation = await owner.capture(), manifest = (await owner.readManifest(generation.generationId)).manifest
  const members = manifest.sources[0]!.members
  const grants = members.filter(member => member.target.includes('-trusted-sources/'))
  expect(grants).toHaveLength(2)
  for (const member of grants) await unlink(member.target)
  const request = { operationId: 'historical-source-approval', generationId: generation.generationId, manifestHash: generation.manifestHash,
    selectors: grants.map(member => ({ sourceId: source.id, memberId: member.id })) }
  expect(await owner.restorePreflight(request)).toMatchObject({ state: 'unavailable', items: grants.map(() => expect.objectContaining({ state: 'unavailable', code: 'RECOVERY_AUTHORITY_REAPPROVAL_REQUIRED' })) })
  expect((await owner.restoreApply(request.operationId)).state).toBe('unavailable')
  for (const member of grants) await expect(source.restoreMissing!({ ...member, file: owner.blobPath(member.sha256), operationId: request.operationId })).rejects.toMatchObject({ code: 'RECOVERY_AUTHORITY_REAPPROVAL_REQUIRED' })
  expect(await original.listTrusted()).toEqual([]); expect(await original.listTrustedMessageSources()).toEqual([])
  const key = members.find(member => member.target.endsWith('/agent-creation-identity.json'))!
  await unlink(key.target)
  const identityRequest = { operationId: 'original-identity-only', generationId: generation.generationId, manifestHash: generation.manifestHash, selectors: [{ sourceId: source.id, memberId: key.id }] }
  expect((await owner.restorePreflight(identityRequest)).state).toBe('prepared')
  expect((await owner.restoreApply(identityRequest.operationId)).state).toBe('complete')
  expect(await new AgentMuxCreationAuthority({ stateDirectory: state, runtimeId: identity.runtimeId }).identity()).toEqual(identity)
  // Fresh explicit approval remains the one existing owner of these grants.
  await original.trust(permission, principal); await original.trustMessageSource(permission, principal)
  expect(await original.listTrusted()).toHaveLength(1); expect(await original.listTrustedMessageSources()).toHaveLength(1)
})

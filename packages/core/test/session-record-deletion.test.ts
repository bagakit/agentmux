import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { parseAgentSessionRecordInspection, parseAgentSessionRecordReceipt, parseAgentSessionRecordDeletion } from '../src/agent-session-record.js'
import { agentSessionRetirementRevision } from '../src/agent-session-store.js'
import { capturedStorageSession } from './helpers/captured-history-fixture.js'
import { AgentMuxClient } from '../src/client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { DatabaseSync } from 'node:sqlite'
import { commitCapturedMutation } from '../src/captured-history.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'

const environment = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'amx-delete-env-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries({ HOME: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(key, value)
  return root
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(environment, { recursive: true, force: true }) })
const cleanups: Array<() => Promise<unknown>> = []
let forbiddenRuntime: Array<ReturnType<typeof vi.spyOn>> = []
beforeEach(() => { forbiddenRuntime = ['connect'].map(method => vi.spyOn(AgentMuxClient.prototype, method as 'connect').mockRejectedValue(new Error('Private record fixture must not prepare Runtime'))) })
afterEach(async () => { for (const operation of forbiddenRuntime) expect(operation, 'delete-keeps-runtime-owner-untouched').not.toHaveBeenCalled(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(memory = false, storedHostId = 'local') {
  const root = await mkdtemp(join(tmpdir(), 'amx-delete-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const store = memory ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session = { ...capturedStorageSession(root, 'record-original'), hostId: storedHostId, creation: { createOperationId: 'original-create', initialPrompt: 'not-requested' as const } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'record-body', agentSessionId: session.agentSessionId,
    kind: 'user_message', source: 'user', status: 'complete', title: 'Synthetic retained input', content: 'Original synthetic body 中🙂', createdAt: 1, updatedAt: 1 } })
  const reservation = { kind: 'stop' as const, reservationId: 'fixture-retirement', ownerId: 'private-delete-fixture', ownerPid: process.pid,
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'fixture-retirement', expiresAt: Date.now() + 60000,
    stopOperation: { daemonInstance: 'not-a-runtime', operationKey: 'fixture-only', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); const retired = (await store.commitLifecycle(reservation, null))!
  return { root, store, session, retired }
}

for (const memory of [false, true]) it(`${memory ? 'Memory' : 'File'} keeps one terminal operation on the original retirement and rejects full-fact drift`, async () => {
  const f = await fixture(memory), original = structuredClone(f.retired), revision = agentSessionRetirementRevision(original)
  await expect(f.store.deleteRecord({ ...original, history: { ...original.history!, workspacePath: join(f.root, 'another-source') } }, 'delete-original')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await f.store.readRecordDeletion(f.session.agentSessionId)).toBeNull()
  const first = await f.store.deleteRecord(original, 'delete-original')
  expect(first.admitted).toBe(true)
  expect(first.retirement).toMatchObject({ ...original, recordDeletion: { operationId: 'delete-original', retirementRevision: revision, phase: 'pending' } })
  expect(original).toEqual(f.retired)
  expect(await f.store.loadCreationSessionId('original-create'), 'delete-keeps-original-creation-binding').toBe(f.session.agentSessionId)
  const repeated = await f.store.deleteRecord(original, 'delete-original')
  expect(repeated.admitted).toBe(false); expect(repeated.retirement).toEqual(first.retirement)
  await expect(f.store.deleteRecord(original, 'different-delete')).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_OPERATION_CONFLICT' })
  expect(await f.store.confirmRecordDeletion(first.retirement)).toEqual(first.retirement)
  let record = first.retirement
  for (let page = 0; record.recordDeletion!.phase === 'pending' && page < 10; page++) record = await f.store.cleanRecord(record)
  expect(record.recordDeletion!.phase).toBe('complete')
  expect(await f.store.loadCreationSessionId('original-create')).toBe(f.session.agentSessionId)
  expect(await f.store.loadRetiredRuns()).toContainEqual(f.session.run)
})

for (const memory of [false, true]) it(`${memory ? 'Memory' : 'File'} refuses deletion while the exact retired owner has an in-flight reopen`, async () => {
  const f = await fixture(memory)
  await f.store.reserveLifecycle({ kind: 'reopen', reservationId: 'pending-reopen', ownerId: 'private-other-owner', ownerPid: process.pid,
    agentSessionId: f.session.agentSessionId, operationId: 'pending-reopen', callerOperationId: 'caller-reopen',
    expectedRetirement: f.retired, expiresAt: Date.now() + 60000 })
  await expect(f.store.deleteRecord(f.retired, 'delete-original')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await f.store.readRecordDeletion(f.session.agentSessionId)).toBeNull()
  expect(await f.store.readLifecycleReservation(f.session.agentSessionId)).toMatchObject({ operationId: 'pending-reopen', expectedRetirement: f.retired })
})

it('a second FileStore sees the applied terminal fact after a lost COMMIT reply and confirms only that original operation', async () => {
  const f = await fixture(), store = f.store as AgentMuxFileAgentSessionStore
  const owner = store as unknown as { commit(signal?: AbortSignal, onAttempt?: () => void): Promise<void> }, commit = owner.commit.bind(owner)
  vi.spyOn(owner, 'commit').mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('Private applied COMMIT lost acknowledgement') })
  await expect(store.deleteRecord(f.retired, 'delete-original')).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
  const second = new AgentMuxFileAgentSessionStore(store.path), observed = (await second.readRetiredAgentSession(f.session.agentSessionId))!
  expect(observed.recordDeletion).toMatchObject({ operationId: 'delete-original', phase: 'pending' })
  const confirmed = await second.confirmRecordDeletion(observed)
  expect(confirmed.recordDeletion).toEqual(observed.recordDeletion)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const inspected = parseAgentSessionRecordInspection({ ...ref, observedAt: Date.now(), state: 'deleted', operationIdMatched: false,
    receipt: { ...ref, retiredAt: observed.observedAt, deletion: observed.recordDeletion, persistence: 'confirmed' } }, { ...ref, operationId: 'another-request' })
  expect(inspected).toMatchObject({ state: 'deleted', operationIdMatched: false })
  expect(await second.loadCreationSessionId('original-create')).toBe(f.session.agentSessionId)
})

for (const memory of [false, true]) it(`${memory ? 'Memory' : 'File'} actual SDK deletes only its original record while preserving independent journal and live decoys`, async () => {
  const f = await fixture(memory), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No Runtime connect is allowed'))
  const decoy = capturedStorageSession(f.root, 'healthy-decoy'); await f.store.compareAndSwap(null, decoy)
  const queue = new DurableAgentMuxMessageQueue(client.agentMessageQueuePath())
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-unsent' }
  const intent = { key, admissionIntent: { kind: 'manual-actor' as const, expectedRun: f.session.run }, execution: 'immediate' as const,
    environment: { providerId: f.session.providerId, executorId: f.session.executorId }, source: { kind: 'prompt' as const, prompt: 'Independent original input body 中🙂', authorHuman: true } }
  await queue.savePromptInput(intent)
  const otherKey = { ...key, agentSessionId: decoy.agentSessionId, expectedRun: decoy.run, submissionId: 'decoy-input' }
  await queue.savePromptInput({ ...intent, key: otherKey, admissionIntent: { ...intent.admissionIntent, expectedRun: decoy.run }, source: { ...intent.source, prompt: 'Independent decoy input' } })
  expect((await client.readAgentInputMailbox({ agentSessionId: key.agentSessionId })).items).toHaveLength(1)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const observed = await client.inspectAgentSessionRecord(ref)
  expect(observed.state).toBe('retired'); if (observed.state !== 'retired') throw new Error('Original retirement required')
  const input = { ...ref, operationId: 'delete-original', expectedRetiredAt: observed.retiredAt, expectedRetirementRevision: observed.retirementRevision }
  const receipt = await client.deleteAgentSessionRecord(input)
  expect(receipt).toMatchObject({ ...ref, persistence: 'confirmed', deletion: { operationId: input.operationId, phase: 'complete' } })
  expect(await client.inspectAgentSessionRecord({ ...ref, operationId: input.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt })
  expect(await client.inspectAgentSessionRecord({ ...ref, operationId: 'another-request' })).toMatchObject({ state: 'deleted', operationIdMatched: false })
  expect(await client.sessionHistorySources({ agentSessionId: ref.agentSessionId })).toEqual([{ ...ref, state: 'deleted', retiredAt: f.retired.observedAt, recordDeletion: receipt.deletion }])
  for (const read of [() => client.sessionTimeline(ref.agentSessionId), () => client.readAgentConversation(ref),
    () => client.readAgentInputMailbox({ agentSessionId: ref.agentSessionId }), () => client.readAgentInputChanges({ agentSessionId: ref.agentSessionId }),
    () => client.inspectAgentInput({ key }), () => client.inspectAgentPromptSubmission(key),
    () => client.readAgentSessionUsage(ref), () => f.store.readCapturedHistory(ref.agentSessionId)]) {
    await expect(read(), 'delete-blocks-original-body-reader').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  }
  await expect(client.reopenAgent({ agentSessionId: ref.agentSessionId, expectedRetiredAt: f.retired.observedAt, operationId: 'old-reopen' })).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  await expect(f.store.compareAndSwap(null, f.session)).rejects.toBeInstanceOf(Error)
  expect(await client.resolveAgentCreationSessionId('original-create')).toBe(ref.agentSessionId)
  expect((await client.inspectAgentCreation(ref.agentSessionId))).toMatchObject({ kind: 'retired-agent', recordDeletion: receipt.deletion })
  expect((await client.readAgentInputMailbox({ agentSessionId: decoy.agentSessionId })).items).toHaveLength(1)
  expect(await f.store.readMetadata(decoy.agentSessionId)).toMatchObject(decoy)
  expect((await queue.inspectInput({ key }))?.intent.source).toEqual(intent.source)
  expect(await f.store.loadRetiredRuns()).toContainEqual(f.session.run)
  expect(connect).not.toHaveBeenCalled()
})

it('real Unix RPC, Hosted owner and source CLI delete and inspect one original selected Host without borrowing another operation ACK', async () => {
  const f = await fixture(), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Runtime is not part of record deletion'))
  vi.spyOn(client, 'connectRuntime').mockRejectedValue(new Error('Private Hosted bootstrap has no Native owner'))
  vi.spyOn(client, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
  const owner = new AgentMuxHostedRuntimeService(client, (f.store as AgentMuxFileAgentSessionStore).path,
    () => ({ runtimeId: 'record-owner', ownerInstanceId: 'record-owner-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }))
  cleanups.push(() => owner.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'selected-host', client }], hostedRuntime: () => owner }, join(f.root, 'record.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const sdk = await connectHostedAgentMux({ rpc }); cleanups.push(() => sdk.dispose())
  const reference = { hostId: 'selected-host', agentSessionId: f.session.agentSessionId }
  const observed = await rpc.call('agent.history.record.inspect', reference)
  expect(observed.state).toBe('retired'); if (observed.state !== 'retired') throw new Error('Expected original retirement')
  expect(await sdk.inspectAgentSessionRecord({ ...reference, hostId: 'local' })).toMatchObject({ state: 'retired', retirementRevision: observed.retirementRevision })
  const input = { ...reference, operationId: 'original-delete', expectedRetiredAt: observed.retiredAt, expectedRetirementRevision: observed.retirementRevision }
  const capability = issueAgentCapability(), managed = { ...capturedStorageSession(f.root, 'managed-reader'), capabilityHash: hashAgentCapability(capability) }
  await f.store.compareAndSwap(null, managed)
  // The managed-authority fixture uses the Core's original semantic namespace;
  // the outer Unix fixture below independently proves the configured route label.
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] }); cleanups.push(() => service.dispose())
  for (const context of [{ transport: 'unix' as const }, { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'private-user' },
    caller: { agentSessionId: managed.agentSessionId, capability } }])
    await expect(service.call('agent.history.record.delete', input, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(rpc.call('agent.history.record.delete', { ...input, hostId: 'unavailable-host' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await expect(rpc.call('agent.history.record.delete', { ...input, expectedRetiredAt: input.expectedRetiredAt + 1 })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await f.store.readRecordDeletion(reference.agentSessionId)).toBeNull()
  const root = resolve(import.meta.dirname, '../../..'), loader = pathToFileURL(join(root, 'packages/core/test/fixtures/hook-delivery/source-loader.mjs')).href
  const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', `data:text/javascript,import {register} from 'node:module';register(${JSON.stringify(loader)});`, join(root, 'packages/core/src/agentmux.ts'), ...args],
      { env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data)
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
  })
  const result = await cli(['--endpoint', `unix:${server.path}`, 'agent', 'history', 'record', 'delete', '--host', input.hostId,
    '--session', input.agentSessionId, '--operation-id', input.operationId, '--retired-at', String(input.expectedRetiredAt), '--retirement-revision', input.expectedRetirementRevision])
  expect(result.code, result.stderr + result.stdout).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ ...reference, persistence: 'confirmed', deletion: { operationId: input.operationId, phase: 'complete' } })
  const checked = await cli(['--endpoint', `unix:${server.path}`, 'agent', 'history', 'record', 'inspect', '--host', input.hostId,
    '--session', input.agentSessionId, '--operation-id', 'another-request'])
  expect(checked.code, checked.stderr + checked.stdout).toBe(0)
  expect(JSON.parse(checked.stdout).result).toMatchObject({ state: 'deleted', operationIdMatched: false })
  expect(await sdk.inspectAgentSessionRecord({ hostId: 'local', agentSessionId: input.agentSessionId, operationId: input.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true })
  expect(connect).not.toHaveBeenCalled()
})

it('bounded real cleanup yields between original transactions so a healthy unrelated writer commits before cleanup completes', async () => {
  const f = await fixture(), store = f.store as AgentMuxFileAgentSessionStore, client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  const internal = store as unknown as { enqueue(operation: () => Promise<void>, signal?: AbortSignal, id?: string): Promise<void>; db: DatabaseSync; dirty: boolean }
  await internal.enqueue(async () => {
    for (let at = 0; at < 400; at++) commitCapturedMutation(internal.db, { type: 'append', agentSessionId: f.session.agentSessionId,
      item: { id: 'bulk-' + at, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Synthetic stored version', content: 'Private fixture body', createdAt: at + 5, updatedAt: at + 5 } })
    internal.dirty = true
  }, undefined, f.session.agentSessionId)
  const decoy = capturedStorageSession(f.root, 'healthy-writer'); await store.compareAndSwap(null, decoy)
  let pages = 0, writerSettledAt = 0, cleanupCompleteAt = 0, write!: Promise<void>
  const clean = store.cleanRecord.bind(store)
  vi.spyOn(store, 'cleanRecord').mockImplementation(async (...args) => {
    const result = await clean(...args); pages++
    if (pages === 1) {
      const db = new DatabaseSync(store.path, { readOnly: true })
      try { expect(Number(db.prepare('SELECT COUNT(*) AS n FROM captured_record_versions WHERE session_id=?').get(f.session.agentSessionId)!.n), 'delete-bounded-first-payload-step').toBeGreaterThanOrEqual(401 - 128) }
      finally { db.close() }
      write = store.compareAndSwap(decoy, { ...decoy, updatedAt: decoy.updatedAt + 1 }).then(() => { writerSettledAt = pages })
    }
    if (result.recordDeletion!.phase === 'complete') cleanupCompleteAt = pages
    return result
  })
  await client.deleteAgentSessionRecord({ hostId: 'local', agentSessionId: f.session.agentSessionId, operationId: 'bounded-delete',
    expectedRetiredAt: f.retired.observedAt, expectedRetirementRevision: agentSessionRetirementRevision(f.retired) })
  await write
  expect(pages).toBeGreaterThan(3); expect(writerSettledAt, 'delete-keeps-unrelated-writer-progress').toBeLessThan(cleanupCompleteAt)
  expect((await store.readMetadata(decoy.agentSessionId))!.updatedAt).toBe(decoy.updatedAt + 1)
})

it('a current second owner cannot return or retain a late original cached conversation body after confirmed deletion', async () => {
  const f = await fixture(), a = new AgentMuxClient({ store: f.store }), bStore = new AgentMuxFileAgentSessionStore((f.store as AgentMuxFileAgentSessionStore).path), b = new AgentMuxClient({ store: bStore })
  cleanups.push(() => a.dispose(), () => b.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  expect((await b.readAgentConversation(ref)).items.length).toBeGreaterThan(0)
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  const read = bStore.readCapturedHistory.bind(bStore)
  vi.spyOn(bStore, 'readCapturedHistory').mockImplementationOnce(async (...args) => { const page = await read(...args); entered(); await hold; return page })
  const late = b.readAgentConversation(ref); const outcome = late.then(value => ({ value, error: null }), error => ({ value: null, error }))
  await ready
  await a.deleteAgentSessionRecord({ ...ref, operationId: 'original-delete', expectedRetiredAt: f.retired.observedAt, expectedRetirementRevision: agentSessionRetirementRevision(f.retired) })
  release()
  expect((await outcome).error, 'delete-does-not-republish-late-body').toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  expect((await outcome).value).toBeNull()
  const state = b as unknown as { conversationReadState: { views: Map<string, unknown> } }
  expect(state.conversationReadState.views.size).toBe(0)
})

it('Memory prepares all fallible receipts before terminal admission or cleanup and rechecks cancellation before changing target maps', async () => {
  const f = await fixture(true), store = f.store as AgentMuxMemoryAgentSessionStore
  const internal = store as unknown as { timelines: Map<string, unknown> }, originalMap = internal.timelines.get(f.session.agentSessionId)
  expect(originalMap).toBeDefined()
  const clone = globalThis.structuredClone.bind(globalThis)
  const failure = new Error('Private Memory receipt clone refused')
  const refuse = (phase: string) => vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if ((value as { recordDeletion?: { phase: string } })?.recordDeletion?.phase === phase) throw failure
    return clone(value, options)
  })
  const initial = refuse('pending')
  await expect(store.deleteRecord(f.retired, 'original-delete')).rejects.toBe(failure)
  initial.mockRestore()
  expect(await store.readRecordDeletion(f.session.agentSessionId)).toBeNull()
  expect(internal.timelines.get(f.session.agentSessionId)).toBe(originalMap)
  const admitted = (await store.deleteRecord(f.retired, 'original-delete')).retirement
  const before = structuredClone(admitted), cleanup = refuse('complete')
  await expect(store.cleanRecord(admitted)).rejects.toBe(failure)
  cleanup.mockRestore()
  expect(await store.readRetiredAgentSession(f.session.agentSessionId), 'delete-memory-stage-does-not-commit-clone-failure').toEqual(before)
  expect(internal.timelines.get(f.session.agentSessionId)).toBe(originalMap)
  const controller = new AbortController(), reason = new Error('Private cancellation during staged receipt')
  const cancel = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    const prepared = clone(value, options)
    if ((value as { recordDeletion?: { phase: string } })?.recordDeletion?.phase === 'complete') controller.abort(reason)
    return prepared
  })
  const cancelledOutcome = await store.cleanRecord(admitted, controller.signal).then(() => null, error => error)
  expect(cancelledOutcome, 'delete-memory-rechecks-cancel-before-target-commit').toBe(reason)
  cancel.mockRestore()
  expect(await store.readRetiredAgentSession(f.session.agentSessionId)).toEqual(before)
  expect(internal.timelines.get(f.session.agentSessionId)).toBe(originalMap)
})

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const deletionInput = (f: Awaited<ReturnType<typeof fixture>>, operationId = 'original-delete') => ({ hostId: 'local', agentSessionId: f.session.agentSessionId,
  operationId, expectedRetiredAt: f.retired.observedAt, expectedRetirementRevision: agentSessionRetirementRevision(f.retired) })
async function hostedFixture(transport: 'http' | 'unix' = 'http', storedHostId = 'local') {
  const f = await fixture(false, storedHostId), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  vi.spyOn(client, 'connectRuntime').mockRejectedValue(new Error('Private Hosted bootstrap has no Native owner'))
  vi.spyOn(client, 'runtimeProjection').mockResolvedValue({ hostId: 'local', subjects: [] })
  const owner = new AgentMuxHostedRuntimeService(client, (f.store as AgentMuxFileAgentSessionStore).path,
    () => ({ runtimeId: 'record-owner', ownerInstanceId: 'record-owner-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }))
  cleanups.push(() => owner.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => owner, http: { host: '127.0.0.1', port: 0, token: 'private-record-cancellation' } }, join(f.root, 'record.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix' ? { transport: 'unix', path: server.path } : { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-record-cancellation' } }); cleanups.push(() => rpc.dispose())
  const sdk = await connectHostedAgentMux({ rpc }); cleanups.push(() => sdk.dispose())
  return { ...f, client, owner, rpc, sdk }
}

it('actual HTTP Hosted SDK mid-cleanup cancellation reaches the original Store, keeps pending and only explicit same-op continue completes', async () => {
  const f = await hostedFixture(), store = f.store as AgentMuxFileAgentSessionStore
  const entered = deferred(), cancelled = deferred(), finished = deferred(), controller = new AbortController()
  const clean = store.cleanRecord.bind(store); let steps = 0
  const watched = vi.spyOn(store, 'cleanRecord').mockImplementation(async (...args) => {
    const result = await clean(args[0], args[1]); steps++
    if (steps === 1) {
      expect(args[1], 'delete-HTTP-signal-reaches-original-cleanup-owner').toBeDefined()
      entered.resolve()
      await new Promise<void>(resolve => {
        if (args[1]?.aborted) { cancelled.resolve(); resolve(); return }
        args[1]?.addEventListener('abort', () => { cancelled.resolve(); resolve() }, { once: true })
      })
    }
    return result
  })
  const actualDelete = f.client.deleteAgentSessionRecord.bind(f.client)
  vi.spyOn(f.client, 'deleteAgentSessionRecord').mockImplementation(async (...args) => { try { return await actualDelete(...args) } finally { finished.resolve() } })
  const request = deletionInput(f), call = f.sdk.deleteAgentSessionRecord(request, { signal: controller.signal })
  const outcome = call.then(value => ({ value, error: null }), error => ({ value: null, error }))
  await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('Delete settled before entering cleanup') })]); controller.abort(new Error('Private Hosted Stop waiting'))
  await cancelled.promise; await finished.promise
  expect((await outcome).error, 'delete-hosted-cancel-rejects-original-call').toBeTruthy()
  expect(steps, 'delete-hosted-cancel-no-following-cleanup-step').toBe(1)
  expect(await store.readRecordDeletion(request.agentSessionId)).toMatchObject({ operationId: request.operationId, phase: 'pending' })
  expect(await f.sdk.inspectAgentSessionRecord({ hostId: request.hostId, agentSessionId: request.agentSessionId, operationId: request.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt: { deletion: { phase: 'pending' } } })
  expect((await f.sdk.deleteAgentSessionRecord(request)).deletion.phase, 'delete-same-op-retry-only-confirms').toBe('pending')
  expect(steps).toBe(1); watched.mockRestore()
  expect((await f.sdk.deleteAgentSessionRecord({ ...request, continue: true })).deletion.phase).toBe('complete')
})

it('actual HTTP Hosted usage signal reaches the already-entered original history source reader independently of deletion', async () => {
  const f = await hostedFixture(), entered = deferred(), cancelled = deferred(), done = deferred(), controller = new AbortController()
  const read = f.store.readHistorySource.bind(f.store)
  vi.spyOn(f.store, 'readHistorySource').mockImplementationOnce(async (id: string, signal?: AbortSignal) => {
    expect(signal, 'usage-HTTP-signal-reaches-original-source-owner').toBeDefined()
    await read(id, signal); entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { cancelled.resolve(); reject(signal!.reason) }
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    })
    throw new Error('Unreachable retained reader')
  })
  const original = f.client.readAgentSessionUsage.bind(f.client)
  vi.spyOn(f.client, 'readAgentSessionUsage').mockImplementation(async (...args) => { try { return await original(...args) } finally { done.resolve() } })
  const call = f.sdk.readAgentSessionUsage({ hostId: 'local', agentSessionId: f.session.agentSessionId }, { signal: controller.signal })
  const outcome = call.then(value => ({ value, error: null }), error => ({ value: null, error }))
  await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('Usage settled before entering source read') })]); controller.abort(new Error('Private Hosted usage Stop'))
  await cancelled.promise; await done.promise
  expect((await outcome).error, 'usage-hosted-cancel-reaches-history-source').toBeTruthy()
  expect(await f.store.readRecordDeletion(f.session.agentSessionId)).toBeNull()
  expect((await f.sdk.readAgentSessionUsage({ hostId: 'local', agentSessionId: f.session.agentSessionId })).captured.status).toBe('measured')
})

for (const deletionKnown of [true, false]) it(`late cancelled real conversation read preserves its primary error and ${deletionKnown ? 'purges a confirmed deleted' : 'keeps an unknown healthy'} original view`, async () => {
  const f = await fixture(), a = new AgentMuxClient({ store: f.store }), bStore = new AgentMuxFileAgentSessionStore((f.store as AgentMuxFileAgentSessionStore).path), b = new AgentMuxClient({ store: bStore })
  cleanups.push(() => a.dispose(), () => b.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  await b.readAgentConversation(ref)
  const state = b as unknown as { conversationReadState: { views: Map<string, unknown> } }, originalSize = state.conversationReadState.views.size
  expect(originalSize).toBeGreaterThan(0)
  const entered = deferred(), release = deferred(), controller = new AbortController(), error = new Error('Original IO/cancel error identity')
  const read = bStore.readCapturedHistory.bind(bStore)
  vi.spyOn(bStore, 'readCapturedHistory').mockImplementationOnce(async (...args) => { await read(...args); entered.resolve(); await release.promise; throw error })
  const late = b.readAgentConversation(ref, { signal: controller.signal }), outcome = late.then(value => ({ value, error: null }), error => ({ value: null, error }))
  await entered.promise
  if (deletionKnown) await a.deleteAgentSessionRecord(deletionInput(f))
  else vi.spyOn(bStore, 'readRecordDeletion').mockRejectedValueOnce(new Error('Private deletion observation unavailable'))
  controller.abort(error); release.resolve()
  expect((await outcome).error, 'delete-late-error-preserves-primary-object').toBe(error)
  expect(state.conversationReadState.views.size, deletionKnown ? 'delete-late-error-purges-confirmed-body' : 'delete-unknown-observer-preserves-healthy-view').toBe(deletionKnown ? 0 : originalSize)
})

it('two current Core owners race the original held request and explicit same-op retry with only one admitted tombstone', async () => {
  const f = await fixture(), a = new AgentMuxClient({ store: f.store }), bStore = new AgentMuxFileAgentSessionStore((f.store as AgentMuxFileAgentSessionStore).path), b = new AgentMuxClient({ store: bStore })
  cleanups.push(() => a.dispose(), () => b.dispose())
  const entered = deferred(), release = deferred(), original = f.store.deleteRecord.bind(f.store); let admissions = 0
  vi.spyOn(f.store, 'deleteRecord').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; const result = await original(args[0], args[1], args[2]); admissions += Number(result.admitted); return result })
  const retry = bStore.deleteRecord.bind(bStore)
  vi.spyOn(bStore, 'deleteRecord').mockImplementation(async (...args) => { const result = await retry(...args); admissions += Number(result.admitted); return result })
  const request = deletionInput(f), first = a.deleteAgentSessionRecord(request)
  await entered.promise
  expect(await b.inspectAgentSessionRecord({ hostId: request.hostId, agentSessionId: request.agentSessionId, operationId: request.operationId }), 'delete-retired-observation-is-not-not-applied').toMatchObject({ state: 'retired', retirementRevision: request.expectedRetirementRevision })
  const repeated = await b.deleteAgentSessionRecord(request)
  release.resolve(); const late = await first
  expect(late, 'delete-original-race-keeps-first-terminal-receipt').toEqual(repeated)
  expect(admissions, 'delete-only-one-terminal-admission').toBe(1)
  await expect(b.deleteAgentSessionRecord({ ...request, expectedRetirementRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await expect(b.deleteAgentSessionRecord({ ...request, operationId: 'another-delete' })).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_OPERATION_CONFLICT' })
  expect(await b.inspectAgentSessionRecord({ hostId: request.hostId, agentSessionId: request.agentSessionId, operationId: 'another-delete' })).toMatchObject({ state: 'deleted', operationIdMatched: false })
})

it('Memory active body and input read fences do not scan unrelated retired Sessions', async () => {
  const f = await fixture(true), active = capturedStorageSession(f.root, 'healthy-active'), store = f.store as AgentMuxMemoryAgentSessionStore
  await store.compareAndSwap(null, active)
  const internal = store as unknown as { retiredAgentSessions: Array<unknown> }
  vi.spyOn(internal.retiredAgentSessions, 'find').mockImplementation(() => { throw new Error('Unrelated retired scan on active path') })
  expect(await store.readRecordDeletion(active.agentSessionId)).toBeNull()
  expect((await store.readCapturedHistory(active.agentSessionId)).records).toEqual([])
  expect(await store.hasCapturedActivity(active.agentSessionId, 'missing')).toBe(false)
  expect(await store.readPromptAdmission(active.agentSessionId, active.run, 'missing')).toBeNull()
})

for (const memory of [false, true]) it(`${memory ? 'Memory' : 'File'} cleanup retains G original captured retirement cut while all deleted stream readers and writers are fenced`, async () => {
  const f = await fixture(memory), store = f.store
  let before: unknown
  if (memory) before = (store as unknown as { timelines: Map<string, { stream: unknown; retirementAfterSequence?: number }> }).timelines.get(f.session.agentSessionId)
  else {
    const db = new DatabaseSync((store as AgentMuxFileAgentSessionStore).path, { readOnly: true })
    try { before = db.prepare('SELECT * FROM captured_retirement_cuts WHERE session_id=?').all(f.session.agentSessionId) } finally { db.close() }
  }
  const client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  await client.deleteAgentSessionRecord(deletionInput(f))
  if (memory) {
    const retained = (store as unknown as { timelines: Map<string, { stream: unknown; retirementAfterSequence?: number; heads: Map<string, unknown>; versions: unknown[] }> }).timelines.get(f.session.agentSessionId)!
    expect(retained.retirementAfterSequence, 'delete-keeps-original-memory-G-cut').toBe((before as typeof retained).retirementAfterSequence)
    expect(retained.stream).toEqual((before as typeof retained).stream); expect(retained.versions).toEqual([]); expect(retained.heads.size).toBe(0)
  } else {
    const db = new DatabaseSync((store as AgentMuxFileAgentSessionStore).path, { readOnly: true })
    try { expect(db.prepare('SELECT * FROM captured_retirement_cuts WHERE session_id=?').all(f.session.agentSessionId), 'delete-keeps-original-SQL-G-cut').toEqual(before) } finally { db.close() }
  }
  await expect(store.readCapturedHistory(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  await expect(store.hasCapturedActivity(f.session.agentSessionId, 'activity')).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  await expect(store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id: 'late-item', agentSessionId: f.session.agentSessionId,
    kind: 'user_message', source: 'user', status: 'complete', title: 'Late synthetic write', content: 'Must not reactivate original stream', createdAt: 900, updatedAt: 900 } })).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  for (const read of [() => client.listMessages({ participantSessionId: f.session.agentSessionId, direction: 'incoming' }), () => client.listMessageEvents({ participantSessionId: f.session.agentSessionId }),
    () => client.listDispatches({ participantSessionId: f.session.agentSessionId })]) await expect(read(), 'delete-fences-original-session-journal-selector').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
})

it('shared Unix SDK Stop waiting keeps its healthy connection and the original admitted operation may finish without replay', async () => {
  const f = await hostedFixture('unix'), entered = deferred(), release = deferred(), finished = deferred(), controller = new AbortController()
  const clean = f.store.cleanRecord.bind(f.store); let steps = 0, serverSignal: AbortSignal | undefined
  vi.spyOn(f.store, 'cleanRecord').mockImplementation(async (...args) => {
    const result = await clean(args[0], args[1]); steps++
    if (steps === 1) { serverSignal = args[1]; entered.resolve(); await release.promise }
    return result
  })
  const original = f.client.deleteAgentSessionRecord.bind(f.client)
  const invoke = vi.spyOn(f.client, 'deleteAgentSessionRecord').mockImplementation(async (...args) => { try { return await original(...args) } finally { finished.resolve() } })
  const request = deletionInput(f), outcome = f.sdk.deleteAgentSessionRecord(request, { signal: controller.signal }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  await Promise.race([entered.promise, outcome.then(result => { throw result.error ?? new Error('Original operation did not enter cleanup') })])
  controller.abort(new Error('Only stop waiting for this shared Unix call'))
  expect((await outcome).error).toBeTruthy()
  expect(serverSignal?.aborted, 'delete-shared-Unix-does-not-claim-server-cancellation').toBe(false)
  expect((await f.sdk.sessionHistorySources()).some(source => source.agentSessionId === request.agentSessionId), 'delete-shared-Unix-keeps-same-connection-readable').toBe(true)
  release.resolve(); await finished.promise
  expect(await f.sdk.inspectAgentSessionRecord({ hostId: request.hostId, agentSessionId: request.agentSessionId, operationId: request.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt: { deletion: { phase: 'complete' } } })
  expect(invoke, 'delete-stopped-wait-inspection-does-not-replay').toHaveBeenCalledTimes(1)
})

it('the direct finite Hosted owner keeps the same user/device authority and refuses missing or managed principals', async () => {
  const f = await hostedFixture(), request = deletionInput(f)
  const params = { consumerId: 'private-authority-check', fence: { runtimeId: 'record-owner', ownerInstanceId: 'record-owner-instance' }, invocation: { method: 'deleteAgentSessionRecord', args: [request] } }
  for (const context of [{}, { principal: { kind: 'user' as const, id: '' } },
    { principal: { kind: 'user' as const, id: 'private-user' }, caller: { agentSessionId: 'managed-original', capability: 'not-authorized' } }])
    await expect(f.owner.call('runtime.invoke', params, context), 'delete-named-Hosted-cannot-assert-human-authority').rejects.toBeInstanceOf(Error)
  expect(await f.store.readRecordDeletion(request.agentSessionId)).toBeNull()
  const current = vi.fn(async () => {}), receipt = await f.owner.call('runtime.invoke', params, { principal: { kind: 'user', id: 'private-user' }, assertCurrent: current })
  expect(receipt).toMatchObject({ value: { hostId: request.hostId, agentSessionId: request.agentSessionId, deletion: { phase: 'complete' } } })
  expect(current).toHaveBeenCalled()
})

it('the delete API freezes its original primitive target and witness before its first awaited owner read', async () => {
  const f = await fixture(), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  const entered = deferred(), release = deferred(), read = f.store.readRetiredAgentSession.bind(f.store)
  vi.spyOn(f.store, 'readRetiredAgentSession').mockImplementationOnce(async (...args) => { const value = await read(args[0], args[1]); entered.resolve(); await release.promise; return value })
  const request = deletionInput(f), original = structuredClone(request), pending = client.deleteAgentSessionRecord(request)
  await entered.promise; request.agentSessionId = 'other-live-identity'; request.operationId = 'substituted-op'; request.expectedRetirementRevision = '0'.repeat(64); release.resolve()
  expect(await pending, 'delete-freezes-original-target-before-await').toMatchObject({ agentSessionId: original.agentSessionId, deletion: { operationId: original.operationId, retirementRevision: original.expectedRetirementRevision } })
  expect(await f.store.readRecordDeletion(request.agentSessionId)).toBeNull()
})

for (const failureKind of ['SQL', 'applied-COMMIT'] as const) it(`an actual FileStore ${failureKind} cleanup failure retains the original pending terminal fact and never resumes on inspection`, async () => {
  const f = await fixture(), store = f.store as AgentMuxFileAgentSessionStore, client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  const internal = store as unknown as { db: DatabaseSync; commit(signal?: AbortSignal, onAttempt?: () => void): Promise<void>; enqueue(operation: () => Promise<void>, signal?: AbortSignal, id?: string): Promise<void> }, error = new Error('Private original cleanup failure')
  const clean = store.cleanRecord.bind(store); let steps = 0
  const watched = vi.spyOn(store, 'cleanRecord').mockImplementation(async (...args) => {
    steps++
    if (steps === 1 && failureKind === 'SQL') {
      const enqueue = internal.enqueue.bind(internal)
      vi.spyOn(internal, 'enqueue').mockImplementationOnce((operation, signal, id) => enqueue(async () => {
        const db = internal.db, prepare = db.prepare.bind(db)
        const fault = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { if (sql.startsWith('DELETE FROM captured_record_versions ')) throw error; return prepare(sql) })
        try { await operation() } finally { fault.mockRestore() }
      }, signal, id))
      return await clean(...args)
    }
    if (steps === 1) {
      const commit = internal.commit.bind(internal)
      vi.spyOn(internal, 'commit').mockImplementationOnce(async (...values) => { await commit(...values); throw error })
    }
    return await clean(...args)
  })
  const request = deletionInput(f), outcome = await client.deleteAgentSessionRecord(request).then(() => null, error => error)
  expect(outcome, 'delete-keeps-actual-cleanup-failure').toBeTruthy()
  if (failureKind === 'SQL') { expect(outcome).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' }); expect(outcome.cause, 'delete-keeps-original-SQL-error-cause').toBe(error) }
  else expect(outcome).toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
  expect(await store.readRecordDeletion(request.agentSessionId)).toMatchObject({ operationId: request.operationId, phase: 'pending' })
  expect(await client.inspectAgentSessionRecord({ hostId: request.hostId, agentSessionId: request.agentSessionId, operationId: request.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt: { deletion: { phase: 'pending' } } })
  expect(steps, 'delete-inspect-does-not-resume-failed-cleanup').toBe(1)
  watched.mockRestore()
  expect((await client.deleteAgentSessionRecord({ ...request, continue: true })).deletion.phase).toBe('complete')
})

it('invalid direct SDK changes requests are rejected before looking up a deleted target', async () => {
  const f = await fixture(), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  const observation = vi.spyOn(f.store, 'readRecordDeletion').mockRejectedValue(new Error('Original observer unavailable'))
  await expect(client.readConversationChanges({ hostId: 'local', agentSessionId: f.session.agentSessionId, unsupported: true } as never), 'delete-keeps-invalid-request-parser-before-observer').rejects.not.toThrow('Original observer unavailable')
  expect(observation, 'delete-invalid-request-does-not-read-owner').not.toHaveBeenCalled()
})


for (const providerId of ['codex', 'claude'] as const) it(`deleting an AgentMux record preserves real ${providerId} Provider originals and generic Provider reading`, async () => {
  const f = await fixture(), client = new AgentMuxClient({ store: f.store }); cleanups.push(() => client.dispose())
  const home = join(f.root, 'independent-provider'), workspace = join(f.root, 'native-workspace')
  const env = providerId === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }
  const directory = providerId === 'codex' ? join(home, 'sessions') : join(home, 'projects', 'workspace')
  await mkdir(directory, { recursive: true }); await mkdir(workspace)
  const file = join(directory, providerId === 'codex' ? 'rollout-native-original.jsonl' : 'native-original.jsonl'), records = providerId === 'codex' ? [
    { type: 'session_meta', payload: { id: 'native-original', cwd: workspace, source: 'cli', timestamp: '2026-01-01T00:00:00.000Z' } },
    { timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { id: 'native-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic Provider original' }] } }
  ] : [{ timestamp: '2026-01-01T00:00:01.000Z', type: 'user', uuid: 'native-user', sessionId: 'native-original', cwd: workspace, isSidechain: false, message: { role: 'user', content: 'Synthetic Provider original' } }]
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const bytes = await readFile(file), found = await client.listNativeAgentSessions({ providerId, env, workspacePath: workspace })
  expect(found.sessions.length, 'delete-independent-native-source-is-real').toBe(1)
  const source = found.sessions[0]!.source
  const before = await client.readNativeAgentHistory({ source, env })
  expect(before.items.length).toBeGreaterThan(0)
  await client.deleteAgentSessionRecord(deletionInput(f))
  const after = await client.readNativeAgentHistory({ source, env })
  expect(after, 'delete-retains-independent-native-original-reader').toEqual(before)
  expect(await readFile(file), 'delete-does-not-touch-provider-native-bytes').toEqual(bytes)
})


it('strict original record receipts cannot confirm another Host, Session, operation or retirement witness', () => {
  const expected = { hostId: 'selected-host', agentSessionId: 'original-session', operationId: 'original-delete', expectedRetiredAt: 1, expectedRetirementRevision: '1'.repeat(64) }
  const receipt = { hostId: expected.hostId, agentSessionId: expected.agentSessionId, retiredAt: 1, persistence: 'confirmed', deletion: { operationId: expected.operationId, retirementRevision: expected.expectedRetirementRevision, deletedAt: 2, phase: 'pending' } }
  expect(parseAgentSessionRecordReceipt(receipt, expected)).toBe(receipt)
  for (const phase of ['pending', 'complete'] as const) expect(parseAgentSessionRecordReceipt({ ...receipt, deletion: { ...receipt.deletion, phase } }, expected).deletion.phase).toBe(phase)
  for (const phase of [['pending'], ['complete'], [], {}, null, true, false, 1]) {
    expect(() => parseAgentSessionRecordReceipt({ ...receipt, deletion: { ...receipt.deletion, phase } }, expected), 'delete-phase-requires-original-primitive-literal').toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseAgentSessionRecordDeletion({ ...receipt.deletion, phase }), 'delete-stored-phase-requires-original-primitive-literal').toThrow(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
  }
  for (const foreign of [{ ...receipt, hostId: 'another-host' }, { ...receipt, agentSessionId: 'another-session' }, { ...receipt, retiredAt: 3 },
    { ...receipt, deletion: { ...receipt.deletion, operationId: 'another-original-operation' } }, { ...receipt, deletion: { ...receipt.deletion, retirementRevision: '2'.repeat(64) } }])
    expect(() => parseAgentSessionRecordReceipt(foreign, expected), 'delete-strict-receipt-binds-exact-original-request').toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})

it('actual Hosted event wire rejects malformed terminal facts without dropping its owner and continues exact healthy reads and later valid events', async () => {
  const f = await hostedFixture('unix'), healthy = capturedStorageSession(f.root, 'healthy-wire-reader')
  await f.store.compareAndSwap(null, healthy)
  const events: import('../src/types.js').AgentMuxClientEvent[] = [], unsubscribe = f.sdk.onEvent(event => { events.push(event) }); cleanups.push(async () => unsubscribe())
  const publisher = (f.client as unknown as { publisher: { publish(event: import('../src/types.js').AgentMuxClientEvent): void } }).publisher
  const originalOwner = f.sdk.runtimeOwnerIdentity()
  const fact = { type: 'agent-session-record-deleted', agentSessionId: healthy.agentSessionId, retiredAt: 1,
    recordDeletion: { operationId: 'invalid-wire-delete', retirementRevision: '1'.repeat(64), deletedAt: 2, phase: ['complete'] } }
  for (const invalid of [fact, { ...fact, agentSessionId: { id: healthy.agentSessionId }, retiredAt: 'not-a-machine-timestamp', recordDeletion: { ...fact.recordDeletion, phase: 'complete' } }]) {
    const count = events.length
    publisher.publish(invalid as unknown as import('../src/types.js').AgentMuxClientEvent)
    // An exact post-publication read uses the same transport and a later real response.
    expect(await f.sdk.inspectAgentSessionRecord({ hostId: 'local', agentSessionId: healthy.agentSessionId })).toMatchObject({ state: 'active' })
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(count))
    const observed = events.slice(count)
    expect(observed.filter(event => event.type === 'agent-session-record-deleted'), 'delete-wire-invalid-terminal-does-not-reach-consumer').toEqual([])
    const errors = observed.filter(event => event.type === 'agent-error' && event.code === 'CONTROL_PROTOCOL_ERROR')
    expect(errors.length, 'delete-wire-invalid-terminal-retains-visible-protocol-diagnostic').toBeGreaterThan(0)
    for (const error of errors) { if (error.type !== 'agent-error') throw new Error('Expected the exact protocol diagnostic'); expect(error).not.toHaveProperty('agentSessionId'); expect(error).not.toHaveProperty('run'); expect(error.evidence).not.toHaveProperty('run') }
    expect(f.sdk.runtimeOwnerIdentity(), 'delete-wire-invalid-terminal-keeps-original-owner-lease').toEqual(originalOwner)
    expect(await f.store.readRecordDeletion(healthy.agentSessionId)).toBeNull()
  }
  const request = deletionInput(f), receipt = await f.sdk.deleteAgentSessionRecord(request)
  await vi.waitFor(() => expect(events.some(event => event.type === 'agent-session-record-deleted' && event.agentSessionId === request.agentSessionId && event.recordDeletion.operationId === request.operationId && event.recordDeletion.phase === 'complete'), 'delete-wire-later-valid-terminal-still-delivers').toBe(true))
  expect(receipt.deletion.phase).toBe('complete')
  expect(await f.sdk.inspectAgentSessionRecord({ hostId: 'local', agentSessionId: healthy.agentSessionId })).toMatchObject({ state: 'active' })
  expect(f.sdk.runtimeOwnerIdentity()).toEqual(originalOwner)
})

it('actual original Unix reopen.check refuses a deleted record before Native preparation and retains the original request and terminal receipt', async () => {
  const f = await hostedFixture('unix'), originalCheck = { agentSessionId: f.session.agentSessionId, expectedRetiredAt: f.retired.observedAt, operationId: 'original-retained-reopen-check' }
  const saved = structuredClone(originalCheck), kernel = (f.client as unknown as { kernel: { start(...args: unknown[]): unknown; stop(...args: unknown[]): unknown; input(...args: unknown[]): unknown } }).kernel
  const controls = ['start', 'stop', 'input'].map(name => vi.spyOn(kernel, name as 'start').mockImplementation(() => { throw new Error('Private old check cannot control Native') }))
  const receipt = await f.sdk.deleteAgentSessionRecord(deletionInput(f)), read = vi.spyOn(f.client, 'sessionHistorySources')
  await expect(f.rpc.call('agent.reopen.check', originalCheck), 'delete-old-reopen-check-stops-at-original-terminal-owner').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  await expect(f.sdk.reopenAgent(originalCheck), 'delete-named-reopen-stops-before-original-native-preparation').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  await expect(f.sdk.reconcileAgentReopen(originalCheck), 'delete-named-reconcile-stops-before-original-native-preparation').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  expect(originalCheck).toEqual(saved)
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: originalCheck.agentSessionId }))
  for (const invoke of [f.sdk.reopenAgent.bind(f.sdk), f.sdk.reconcileAgentReopen.bind(f.sdk)]) for (const agentSessionId of [undefined, null, '', { id: originalCheck.agentSessionId }]) {
    read.mockClear()
    await expect(invoke({ ...originalCheck, agentSessionId } as never), 'delete-named-preparation-never-broadens-an-invalid-session-id').rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(read, 'delete-invalid-session-id-cannot-trigger-source-catalogue').not.toHaveBeenCalled()
  }
  for (const control of controls) expect(control).not.toHaveBeenCalled()
  expect(await f.sdk.inspectAgentSessionRecord({ hostId: 'local', agentSessionId: originalCheck.agentSessionId, operationId: receipt.deletion.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt })
})

it('actual named Unix reopen and reconcile preserve a nonlocal stored Host and refuse its terminal record before Native preparation', async () => {
  const storedHostId = 'original-stored-host', f = await hostedFixture('unix', storedHostId)
  const original = { agentSessionId: f.session.agentSessionId, expectedRetiredAt: f.retired.observedAt, operationId: 'original-nonlocal-reopen' }, saved = structuredClone(original)
  const kernel = (f.client as unknown as { kernel: { start(...args: unknown[]): unknown; stop(...args: unknown[]): unknown; input(...args: unknown[]): unknown } }).kernel
  const controls = ['start', 'stop', 'input'].map(name => vi.spyOn(kernel, name as 'start').mockImplementation(() => { throw new Error('Private original Host cannot control Native') }))
  expect(await f.client.sessionHistorySources({ agentSessionId: original.agentSessionId })).toContainEqual(expect.objectContaining({ hostId: storedHostId, state: 'retired' }))
  const receipt = await f.sdk.deleteAgentSessionRecord(deletionInput(f))
  for (const invoke of [f.sdk.reopenAgent.bind(f.sdk), f.sdk.reconcileAgentReopen.bind(f.sdk)])
    await expect(invoke(original), 'delete-named-original-store-host-is-not-route-alias').rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
  expect(await f.client.sessionHistorySources({ agentSessionId: original.agentSessionId })).toContainEqual(expect.objectContaining({ hostId: storedHostId, state: 'deleted' }))
  expect(await f.sdk.inspectAgentSessionRecord({ hostId: 'local', agentSessionId: original.agentSessionId, operationId: receipt.deletion.operationId })).toMatchObject({ state: 'deleted', operationIdMatched: true, receipt })
  expect(original).toEqual(saved)
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})

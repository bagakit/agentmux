import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, realpath, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { messageJournalIo } from './helpers/message-journal-io.js'
import type { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { holdReceiptSync } from './fixtures/hook-transaction/faults.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { projectRuntimeEvent, type SessionProjectionState } from '../../../apps/desktop/src/renderer/src/lib/session-state.js'
import type { SessionSnapshot } from '../../../apps/desktop/src/shared/contracts.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function hookOwner(providerId: 'codex' | 'claude') {
  const id = 'transaction-' + providerId, native = 'native-' + id
  const owner = await rpcOwnerFixture([id], undefined, () => ({ providerId, executorId: providerId }))
  cleanup.push(owner.close)
  const transcript = join(owner.root, 'original-transcript.jsonl'); await writeFile(transcript, '')
  const handle = { kind: 'provider' as const, providerId, sessionId: native, ...(providerId === 'codex' ? { transcriptPath: transcript } : {}) }
  Reflect.get(owner.client, 'hookNativeWitnesses').set('run-' + id, { candidate: JSON.stringify(native), handle })
  Reflect.set(owner.client, 'ensureNativeStatusObservation', async () => {})
  owner.inner.kernel.identity = () => ({ daemonInstanceId: 'private-hook-transaction', buildIdentity: 'fixture', protocolVersion: 25 })
  const hooks = Reflect.get(owner.client, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const binding = hooks.createBinding(id, providerId); await binding.bindRun('run-' + id)
  const events: AgentMuxClientEvent[] = []; owner.client.onEvent(event => events.push(event))
  const post = (receiptId: string, eventName = 'PreToolUse', callId = receiptId) => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: 'Bearer ' + binding.endpoint.token, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, eventName, payload: { hook_event_name: eventName, session_id: native,
      ...(providerId === 'codex' ? { turn_id: 'original-turn', transcript_path: transcript } : { cwd: owner.root }),
      tool_use_id: callId, tool_name: 'Bash',
      tool_input: { command: 'printf original-tool' }, ...(eventName === 'PostToolUse' ? { tool_response: 'original tool result' } : {}) } })
  })
  return { ...owner, id, handle, binding, post, events }
}

it.each(['codex', 'claude'] as const)('%s warm Tool HTTP owner commits receipt and original history exactly once', async provider => {
  const f = await hookOwner(provider), io = await messageJournalIo(); cleanup.push(io.close)
  expect((await f.post('warm')).status).toBe(204)
  expect((await f.post('warm-end', 'PostToolUse', 'warm')).status).toBe(204)
  const path = await realpath(f.store.path), execute = DatabaseSync.prototype.exec
  io.target(path)
  let commits = 0
  const samples: unknown[] = []
  let originalPosition: number | undefined
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && this.prepare('PRAGMA database_list').all().some(row => row.file === path)) commits++
    return execute.call(this, sql)
  })
  for (const [receiptId, eventName, callId] of [['pre', 'PreToolUse', 'original-call'], ['post', 'PostToolUse', 'original-call']] as const) {
    commits = 0; io.reset(); f.events.splice(0)
    const response = await f.post(receiptId, eventName, callId)
    expect(response.status, await response.text()).toBe(204)
    const measured = { receiptId, eventName, commits, sqliteVfs: io.stats() }
    samples.push(measured)
    expect(measured.commits, receiptId + ': one original SQLite transaction, not metadata then history').toBe(1)
    expect(measured.sqliteVfs.writes).toBeGreaterThan(0); expect(measured.sqliteVfs.syncs).toBeGreaterThan(0)
    expect(await f.store.readMetadata(f.id)).toMatchObject({ hookReceipt: { id: receiptId }, run: { runId: 'run-' + f.id }, nativeHandle: f.handle })
    const history = await f.store.readCapturedHistory(f.id)
    const record = history.records.find(row => row.item.kind === 'tool_call' &&
      row.item.conversation?.invocations?.some(value => value.invocation.callId === callId))
    expect(record).toBeDefined()
    expect(record!.item).toMatchObject({ status: eventName === 'PreToolUse' ? 'streaming' : 'complete', toolInput: expect.stringContaining('original-tool') })
    originalPosition ??= record!.firstSequence
    expect(record!.firstSequence).toBe(originalPosition)
    const published = f.events.filter(event => event.type === 'agent-timeline')
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ position: { id: record!.item.id, firstSequence: record!.firstSequence,
      sequence: record!.sequence, revision: record!.revision }, stream: { epoch: history.stream.epoch } })
  }
  expect(f.rawInput).not.toHaveBeenCalled()
  const evidence = process.env.AGENTMUX_TEST_HOOK_TRANSACTION_EVIDENCE
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, provider + '-cost.json'), JSON.stringify({
    samples, scope: 'Private source HTTP Hook + SQLite VFS. Runtime/native witness are controlled ports; explicit Node file/directory syncs and whole-App latency are not claimed.' }, null, 2) + '\n') }
})

it('real generic SQL history failure keeps accepted receipt, original HTTP failure and healthy input owner', async () => {
  const f = await hookOwner('claude')
  expect((await f.post('warm')).status).toBe(204)
  const db = new DatabaseSync(f.store.path)
  try { db.exec("CREATE TRIGGER controlled_history BEFORE INSERT ON captured_record_versions WHEN NEW.record_id LIKE 'tool_%' BEGIN SELECT RAISE(ABORT, 'controlled Tool history SQL failure'); END") } finally { db.close() }
  f.events.splice(0)
  const response = await f.post('accepted-receipt-history-failed')
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: 'AGENT_SESSION_STORE_UNAVAILABLE', accepted: 'unknown', receiptId: 'accepted-receipt-history-failed' })
  expect((await f.store.readMetadata(f.id))?.hookReceipt?.id).toBe('accepted-receipt-history-failed')
  expect(f.client.agentSession(f.id)).toMatchObject({ run: { runId: 'run-' + f.id }, nativeHandle: f.handle,
    hookDeliveryObservation: { accepted: 'unknown', code: 'AGENT_SESSION_STORE_UNAVAILABLE' } })
  expect(f.events.filter(event => event.type === 'agent-timeline')).toEqual([])
  expect(f.rawInput).not.toHaveBeenCalled()
  const input = await f.client.writeAgent({ agentSessionId: f.id, expectedRun: { runId: 'run-' + f.id }, data: 'original healthy bytes', source: 'user' })
  expect(input.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('original healthy bytes') })
  expect(f.rawInput).toHaveBeenCalledExactlyOnceWith('run-' + f.id, 'original healthy bytes')
  const repaired = new DatabaseSync(f.store.path); repaired.exec('DROP TRIGGER controlled_history'); repaired.close()
  expect((await f.post('next-original-observation')).status).toBe(204)
  expect(f.client.agentSession(f.id).hookDeliveryObservation).toBeUndefined()
})

it('actual invalid captured preparation warns and ACKs a valid receipt without claiming metadata uncertainty', async () => {
  const f = await hookOwner('claude')
  const current = (await f.store.readMetadata(f.id))!
  const next = { ...current, nativeHandle: f.handle,
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 },
    activityCommit: { latest: { id: 'prior-original-activity', source: 'native-hook' as const, createdAt: 1,
      activityState: { run: current.run, state: 'working' as const } }, latestCommitted: true } }
  await f.store.compareAndSwapMetadata(current, next)
  const registry = Reflect.get(f.client, 'registry') as import('../src/agent-session-registry.js').AgentMuxAgentSessionRegistry
  await registry.refresh(f.id, current.run)
  const path = Reflect.get(f.store, 'timelinePath').call(f.store, f.id) as string
  await mkdir(path, { recursive: true })
  f.events.splice(0)
  expect((await f.post('valid-receipt-invalid-history')).status).toBe(204)
  expect((await f.store.readMetadata(f.id))?.hookReceipt?.id).toBe('valid-receipt-invalid-history')
  expect(registry.isDurabilityUnconfirmed(f.id)).toBe(false)
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_WORK_HISTORY_PERSIST_FAILED' }))
  expect(f.events.filter(event => event.type === 'agent-timeline')).toEqual([])
  expect(f.rawInput).not.toHaveBeenCalled()
})

it('same durable Hook receipt and history reach actual RPC, source CLI and the Renderer timeline consumer', async () => {
  const f = await hookOwner('claude')
  expect((await f.post('warm')).status).toBe(204)
  const stored = f.client.agentSession(f.id), snapshot: SessionSnapshot = { kind: 'agent', id: f.id, providerId: stored.providerId,
    executorId: stored.executorId, hostId: 'local', workspacePath: stored.workspacePath, label: 'Original Agent',
    createdAt: stored.createdAt, updatedAt: stored.updatedAt, agentSessionUpdatedAt: stored.updatedAt,
    processState: 'running', latestOutputBytes: 3, status: stored.semanticStatus!, semanticStatus: stored.semanticStatus!, nativeHandle: f.handle,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: f.id, run: stored.run } }
  let state: SessionProjectionState = { sessions: [snapshot], timelines: { [f.id]: await f.client.sessionTimeline(f.id) },
    pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  f.events.splice(0)
  expect((await f.post('public-tool', 'PreToolUse', 'public-native-call')).status).toBe(204)
  const event = f.events.find(event => event.type === 'agent-timeline')
  expect(event).toBeDefined(); if (event?.type !== 'agent-timeline') throw new Error('Expected the actual committed timeline event')
  for (const event of f.events) state = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event }).state
  const rendered = state.timelines[f.id]!
  expect(rendered.items.some(item => item.id === event.position!.id)).toBe(true)
  expect(rendered.stream?.positions).toContainEqual(event.position)
  const sdk = await f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: f.id, source: 'captured', limit: 10 })
  expect(sdk.items).toContainEqual(expect.objectContaining({ kind: 'item', item: expect.objectContaining({ id: event.position!.id }) }))
  const server = new AgentMuxControlServer({ coreClients: f.coreClients }, join(f.root, 't.sock')); await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const request = { hostId: 'local', agentSessionId: f.id, source: 'captured' as const, limit: 10 }
  const history = await rpc.call('agent.history', request)
  expect(history.items).toEqual(sdk.items); expect(history.capturedStream).toEqual(sdk.capturedStream)
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.id } })
  expect(inspected.session).toMatchObject({ agentSessionId: f.id, run: stored.run, nativeHandle: f.handle, hookReceipt: { id: 'public-tool' } })
  const env = objectCliEnvironment(f.root, { AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED: process.env.AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED })
  const cli = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'history', '--host', 'local', '--session', f.id,
    '--source', 'captured', '--limit', '10'], env, '', 15000, new URL('./fixtures/hook-delivery/source-loader.mjs', import.meta.url))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.items).toEqual(sdk.items)
  const final = await f.store.readMetadata(f.id)
  expect(final).toMatchObject({ agentSessionId: f.id, run: stored.run, nativeHandle: f.handle, hookReceipt: { id: 'public-tool' } })
  expect(f.rawInput).not.toHaveBeenCalled()
})

it('no accepted Session or timeline is published before the original durable receipt ACK', async () => {
  const f = await hookOwner('claude')
  expect((await f.post('warm')).status).toBe(204)
  const before = f.client.agentSession(f.id), held = await holdReceiptSync(f.store.path, f.id, 'held-original-receipt')
  f.events.splice(0)
  const pending = f.post('held-original-receipt')
  try {
    await held.entered
    expect(f.client.agentSession(f.id).hookReceipt).toEqual(before.hookReceipt)
    expect(f.events.filter(event => event.type === 'agent-timeline' || event.type === 'agent-session' &&
      event.session.hookReceipt?.id === 'held-original-receipt')).toEqual([])
  } finally { held.release(); expect((await pending).status).toBe(204) }
  expect(f.client.agentSession(f.id).hookReceipt?.id).toBe('held-original-receipt')
  expect(f.events.filter(event => event.type === 'agent-timeline')).toHaveLength(1)
})

it('a real second Store changes activity eligibility before CAS and the existing retry re-evaluates actual current', async () => {
  const f = await hookOwner('claude')
  expect((await f.post('warm')).status).toBe(204)
  const compound = f.store.compareAndSwapMetadataWithTimeline.bind(f.store), second = new AgentMuxFileAgentSessionStore(f.store.path)
  const selected = vi.spyOn(f.store, 'compareAndSwapMetadataWithTimeline').mockImplementationOnce(async (expected, next, mutation, signal) => {
    const current = (await second.readMetadata(f.id))!
    await second.compareAndSwapMetadata(current, { ...current, updatedAt: current.updatedAt + 1, activityCommit: {
      ...current.activityCommit!, pending: { id: 'actual-pending-activity', source: 'native-hook', createdAt: 1,
        activityState: { run: current.run, state: 'waiting' } }
    } })
    return await compound(expected, next, mutation, signal)
  })
  const metadata = vi.spyOn(f.store, 'compareAndSwapMetadata')
  f.events.splice(0)
  expect((await f.post('exact-cas-retry')).status).toBe(204)
  expect(selected).toHaveBeenCalledOnce() // First selection was rejected by the real second connection.
  expect(metadata).toHaveBeenCalledOnce() // The actual pending flush is outside this optimization.
  const current = (await second.readMetadata(f.id))!
  expect(current).toMatchObject({ agentSessionId: f.id, run: { runId: 'run-' + f.id }, nativeHandle: f.handle,
    hookReceipt: { id: 'exact-cas-retry' }, activityCommit: { pending: { id: 'actual-pending-activity' } } })
  expect(f.events.filter(event => event.type === 'agent-timeline')).toHaveLength(1)
  expect(f.rawInput).not.toHaveBeenCalled()
})

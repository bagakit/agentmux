import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { parseAgentSessionUsageInput, parseAgentSessionUsagePage } from '../src/agent-session-usage.js'
import { capturedStorageSession } from './helpers/captured-history-fixture.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const environment = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'amx-usage-environment-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries({ HOME: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })) vi.stubEnv(key, value)
  return directory
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(environment, { recursive: true, force: true }) })

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-usage-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const store = memory ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session = capturedStorageSession(root, 'usage-original')
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Runtime must remain unobserved'))
  const item = { id: 'one', agentSessionId: session.agentSessionId, kind: 'user_message' as const, source: 'user' as const,
    status: 'complete' as const, title: 'Synthetic record', content: 'Synthetic exact bytes 中🙂', createdAt: 1, updatedAt: 1 }
  const reference = { hostId: 'local', agentSessionId: session.agentSessionId }
  return { root, store, session, client, connect, item, reference }
}

for (const memory of [false, true]) it(`${memory ? 'Memory' : 'File'} exact version pages freeze sequence, preserve bytes and original cursor identity`, async () => {
  const f = await fixture(memory), items = [f.item, { ...f.item, content: 'Second original revision 中🙂', updatedAt: 2 }, { ...f.item, id: 'two', content: 'Third record', updatedAt: 3 }]
  for (const item of items) await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.session.agentSessionId, item })
  const first = await f.client.readAgentSessionUsage({ ...f.reference, limit: 1 })
  expect(first.captured, 'usage-exact-target').toMatchObject({ status: 'measured', records: 1, logicalBytes: 0, throughSequence: 3, complete: false })
  if (first.captured.status !== 'measured') throw Error('Expected measured original')
  expect(first.unmeasured).toEqual(['other-core-records', 'provider-native', 'ctxmux-runtime', 'shared-database-physical'])
  const other = capturedStorageSession(f.root, 'usage-decoy'); await f.store.compareAndSwap(null, other)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: other.agentSessionId, item: { ...f.item, agentSessionId: other.agentSessionId, content: 'Decoy body' } })
  await expect(f.client.readAgentSessionUsage({ ...f.reference, agentSessionId: other.agentSessionId, cursor: first.captured.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.session.agentSessionId, item: { ...f.item, content: 'Later append outside cut', updatedAt: 4 } })
  const rest = await f.client.readAgentSessionUsage({ ...f.reference, cursor: first.captured.nextCursor!, limit: 10 })
  expect(rest.captured).toMatchObject({ records: 2, logicalBytes: Buffer.byteLength(JSON.stringify(items[2])), throughSequence: 3, lastSequence: 3, complete: true, nextCursor: null })
  await expect(f.client.readAgentSessionUsage({ ...f.reference, hostId: 'another-host' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(f.connect).not.toHaveBeenCalled()
})

it('missing captured source remains unmeasured, empty prepared source can be measured, abort grants no Runtime action', async () => {
  const f = await fixture()
  const missing = await f.client.readAgentSessionUsage(f.reference)
  expect(missing.captured, 'usage-unknown-not-zero').toMatchObject({ status: 'not-measured', reason: expect.any(String) })
  expect(missing.captured).not.toHaveProperty('logicalBytes')
  await f.store.loadTimeline(f.session.agentSessionId)
  expect((await f.client.readAgentSessionUsage(f.reference)).captured).toMatchObject({ status: 'measured', logicalBytes: 0, records: 0, complete: true })
  const abort = new AbortController(); abort.abort(new Error('Private reader cancelled'))
  await expect(f.client.readAgentSessionUsage(f.reference, { signal: abort.signal })).rejects.toThrow('Private reader cancelled')
  expect(f.connect).not.toHaveBeenCalled()
})

it('usage Stop cancels an entered exact source read while its original Store writer continues', async () => {
  const f = await fixture(), abort = new AbortController()
  let enteredWriter!: () => void, releaseWriter!: () => void, enteredSource!: () => void, writerDone = false
  const entered = new Promise<void>(done => { enteredWriter = done })
  const held = new Promise<void>(done => { releaseWriter = done })
  const observing = new Promise<void>(done => { enteredSource = done })
  const owner = f.store as unknown as { enqueue(operation: () => Promise<void>, signal?: AbortSignal, sessionId?: string): Promise<void> }
  const writer = owner.enqueue(async () => { enteredWriter(); await held }, undefined, f.session.agentSessionId).then(() => { writerDone = true })
  await entered
  const original = f.store.readHistorySource.bind(f.store)
  const source = vi.spyOn(f.store, 'readHistorySource').mockImplementation((id: string, signal?: AbortSignal) => { enteredSource(); return original(id, signal) })
  const stopped = f.client.readAgentSessionUsage(f.reference, { signal: abort.signal }).then(() => null, error => error)
  try {
    await observing
    const reason = new Error('Stop this exact usage reader')
    abort.abort(reason)
    const result = await Promise.race([stopped, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Usage reader remained blocked behind its writer after Stop')), 500))])
    expect(result, 'usage-source-read-cancelled-before-writer').toBe(reason)
    expect(source).toHaveBeenCalledWith(f.session.agentSessionId, abort.signal)
    expect(writerDone).toBe(false)
  } finally { releaseWriter(); await writer; await stopped }
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
  expect((await f.client.readAgentSessionUsage(f.reference)).lifecycle.state).toBe('active')
  expect(f.connect).not.toHaveBeenCalled()
})

it('File usage visits indexed bounded metadata without parsing bodies or writing original bytes', async () => {
  const f = await fixture(), store = f.store as AgentMuxFileAgentSessionStore
  for (let i = 0; i < 8; i++) await store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { ...f.item, id: `record-${i}`, content: 'Synthetic huge body marker 中🙂'.repeat(300) } })
  const db = new DatabaseSync(store.path); closes.push(() => db.close())
  const before = db.prepare('SELECT total_changes() AS n').get()!.n
  const originalPrepare = DatabaseSync.prototype.prepare, observed: Array<{ sql: string; rows: number }> = []
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql)
    if (sql.includes('AS logicalBytes')) { const all = statement.all.bind(statement); statement.all = (...args) => { const rows = Reflect.apply(all, statement, args) as ReturnType<typeof all>; observed.push({ sql, rows: rows.length }); return rows } }
    return statement
  })
  const originalParse = JSON.parse
  vi.spyOn(JSON, 'parse').mockImplementation((value, reviver) => { expect(String(value)).not.toContain('Synthetic huge body marker'); return originalParse(value, reviver) })
  const page = await f.client.readAgentSessionUsage({ ...f.reference, limit: 2 })
  expect(page.captured).toMatchObject({ status: 'measured', records: 2, complete: false })
  expect(observed.length).toBe(1); expect(observed[0]!.rows).toBe(3)
  expect(observed[0]!.sql).toContain('octet_length(item_json)')
  const stream = db.prepare('SELECT epoch FROM captured_streams WHERE session_id=?').get(f.session.agentSessionId)!
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + observed[0]!.sql).all(f.session.agentSessionId, stream.epoch!, 0, 8, 3)
  expect(plan.some(row => String(row.detail).includes('session_id=? AND epoch=? AND sequence>? AND sequence<?'))).toBe(true)
  expect(plan.some(row => String(row.detail).includes('SCAN captured_record_versions'))).toBe(false)
  expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
  expect(f.connect).not.toHaveBeenCalled()
})

it('retired and pending-reopen facts remain original while RPC and actual source CLI inspect the selected Host', async () => {
  const f = await fixture()
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: f.item })
  const reservation = { kind: 'stop' as const, reservationId: 'usage-retire', ownerId: 'private-usage', ownerPid: process.pid, agentSessionId: f.session.agentSessionId,
    expectedRun: f.session.run, operationId: 'usage-retire-op', expiresAt: Date.now() + 60000,
    stopOperation: { daemonInstance: 'no-runtime', operationKey: 'not-a-stop', runId: f.session.run.runId } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  const first = await f.client.readAgentSessionUsage(f.reference)
  expect(first.lifecycle).toMatchObject({ state: 'retired', retiredAt: expect.any(Number) })
  const hostedOwner = new AgentMuxHostedRuntimeService(f.client, (f.store as AgentMuxFileAgentSessionStore).path, () => ({
    runtimeId: 'usage-semantic-owner', ownerInstanceId: 'usage-owner-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }))
  closes.push(() => hostedOwner.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'selected-host', client: f.client }], hostedRuntime: () => hostedOwner }, join(f.root, 'control.sock'))
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { ...f.reference, hostId: 'selected-host' }
  const remote = await rpc.call('agent.history.usage', ref)
  expect(remote).toMatchObject({ ...ref, lifecycle: { state: 'retired' }, captured: first.captured })
  const hosted = await connectHostedAgentMux({ rpc }); closes.push(() => hosted.dispose())
  expect(await hosted.readAgentSessionUsage(f.reference)).toMatchObject({ ...f.reference, lifecycle: { state: 'retired' }, captured: first.captured })
  await expect(rpc.call('agent.history.usage', { ...ref, hostId: 'unavailable-host' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  const root = resolve(import.meta.dirname, '../../..'), loader = pathToFileURL(join(root, 'packages/core/test/fixtures/hook-delivery/source-loader.mjs')).href
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', `data:text/javascript,import {register} from 'node:module';register(${JSON.stringify(loader)});`, join(root, 'packages/core/src/agentmux.ts'), ...args],
      { env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text)
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
  })
  const result = await run(['--endpoint', `unix:${server.path}`, 'agent', 'history', 'usage', '--host', ref.hostId, '--session', ref.agentSessionId, '--limit', '1'])
  expect(result.code, result.stdout + result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ ...ref, lifecycle: { state: 'retired' }, captured: first.captured })
  const help = await run(['agent', 'history', 'usage', '--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('reclaimable')
  const retirement = await f.store.readRetiredAgentSession(f.session.agentSessionId)
  expect(retirement).not.toBeNull()
  const pending = { kind: 'reopen' as const, reservationId: 'usage-pending-reopen', ownerId: 'private-reopen', ownerPid: process.pid,
    agentSessionId: f.session.agentSessionId, operationId: 'usage-original-reopen', callerOperationId: 'usage-original-reopen',
    expectedRetirement: retirement!, expiresAt: Date.now() + 60000 }
  await f.store.reserveLifecycle(pending)
  expect((await f.client.readAgentSessionUsage(f.reference)).lifecycle).toMatchObject({ state: 'retired', retiredAt: retirement!.observedAt, pendingReopen: true })
  expect(await f.store.readRetiredAgentSession(f.session.agentSessionId)).toEqual(retirement)
  expect(f.connect).not.toHaveBeenCalled()
})

it('wire codec retains exact target, unknown scopes and bounded options', () => {
  for (const limit of [0, 257, -1, 1.5]) expect(() => parseAgentSessionUsageInput({ hostId: 'local', agentSessionId: 'original', limit })).toThrow()
  const page = { hostId: 'local', agentSessionId: 'original', observedAt: 1, lifecycle: { state: 'retired' },
    captured: { status: 'not-measured', reason: 'Original source unavailable' },
    unmeasured: ['other-core-records', 'provider-native', 'ctxmux-runtime', 'shared-database-physical'] }
  expect(parseAgentSessionUsagePage(page, page)).toBe(page)
  expect(() => parseAgentSessionUsagePage(page, { ...page, hostId: 'other-host' })).toThrow()
  expect(() => parseAgentSessionUsagePage({ ...page, unmeasured: [] }, page)).toThrow()
  expect(() => parseAgentSessionUsagePage({ ...page, captured: { ...page.captured, logicalBytes: 0 } }, page)).toThrow()
})

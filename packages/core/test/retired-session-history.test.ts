import { fixtureClock, fixtureDay } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions, sessionHistoryMetadata, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
const clients: AgentMuxClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})
async function retire(store: AgentMuxAgentSessionStore, session: AgentMuxStoredAgentSession) {
  const reservation = { kind: 'stop' as const, reservationId: 'retained-stop', ownerId: 'retained-owner', ownerPid: process.pid,
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'retained-stop-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation)
  await store.commitLifecycle(reservation, null)
}
async function captured(store: AgentMuxAgentSessionStore, id: string) {
  await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: {
    id: 'captured-input', agentSessionId: id, kind: 'user_message', status: 'complete', source: 'user',
    createdAt: 100, updatedAt: 100, title: 'Input', content: 'Retained captured body' } })
}
async function fixture(provider: 'claude' | 'pi') {
  const value = await nativeHistoryFixture(provider, root => jsonl(provider === 'claude'
    ? [{ sessionId: 'native-main', uuid: 'native-input', type: 'user', timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z", message: { role: 'user', content: 'Retained native body' } }]
    : [{ type: 'session', version: 3, id: 'native-main', cwd: root, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z" },
      { type: 'message', id: 'native-input', parentId: null, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 1, 0) + "Z", message: { role: 'user', content: 'Retained native body' } }]))
  fixtures.push(value)
  return value
}

function freshHistoryReader(storePath: string) {
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name as 'start'))
  return { store, client, assertNoRunControls: () => {
    expect(connect).not.toHaveBeenCalled()
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  } }
}
async function expectOriginalHistory(reader: ReturnType<typeof freshHistoryReader>, f: Awaited<ReturnType<typeof fixture>>) {
  const sources = await reader.client.sessionHistorySources()
  expect(sources.find(source => source.agentSessionId === f.session.agentSessionId)).toEqual({
    agentSessionId: f.session.agentSessionId, hostId: 'local', state: 'retired', retiredAt: expect.any(Number),
    history: sessionHistoryMetadata(f.session)
  })
  expect((await reader.client.sessionHistoryPage(f.session.agentSessionId)).items.map(item => [item.id, item.contentParts])).toEqual([
    ['native-input', [{ kind: 'text', text: 'Retained native body' }]]
  ])
  expect((await reader.client.sessionTimeline(f.session.agentSessionId)).items.map(item => [item.id, item.content])).toEqual([
    ['captured-input', 'Retained captured body']
  ])
  expect(await readFile(f.path)).toEqual(f.before.native)
  reader.assertNoRunControls()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}

it.each(['claude', 'pi'] as const)('retains public %s and captured history across actual retirement and fresh durable instances', async provider => {
  const f = await fixture(provider)
  await captured(f.store, f.session.agentSessionId)
  const before = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(before.items.map(item => [item.id, item.kind, item.contentParts])).toEqual([
    ['native-input', 'user-message', [{ kind: 'text', text: 'Retained native body' }]]
  ])
  await retire(f.store, f.session)
  const store = new AgentMuxFileAgentSessionStore(f.storePath)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  expect(await loadAgentSessions(store)).toEqual([])
  const sources = await client.sessionHistorySources()
  expect(sources).toEqual([{ agentSessionId: f.session.agentSessionId, hostId: 'local', state: 'retired',
    retiredAt: expect.any(Number), history: { providerId: provider, executorId: provider, workspacePath: f.root,
      createdAt: 1, nativeHandle: f.session.nativeHandle } }])
  expect(sources[0]).not.toHaveProperty('run')
  expect(sources[0]!.history).not.toHaveProperty('hookToken')
  expect(await client.sessionHistoryPage(f.session.agentSessionId)).toEqual(before)
  expect((await client.sessionTimeline(f.session.agentSessionId)).items.map(item => [item.id, item.content])).toEqual([['captured-input', 'Retained captured body']])
  expect(await readFile(f.path)).toEqual(f.before.native)
  expect(connect).not.toHaveBeenCalled()
  expect(f.controls).toHaveLength(6)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('missing native identity leaves retained captured content independently readable', async () => {
  const f = await fixture('claude')
  const current = (await loadAgentSessions(f.store))[0]!
  expect(current.agentSessionId).toBe('private-agent')
  const { nativeHandle: _locator, ...unlocated } = current
  await f.store.compareAndSwap(current, unlocated)
  await captured(f.store, f.session.agentSessionId)
  await retire(f.store, unlocated)
  expect((await f.client.sessionHistorySources()).map(entry => [entry.agentSessionId, entry.history?.nativeHandle])).toEqual([['private-agent', undefined]])
  await expect(f.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect((await f.client.sessionTimeline('private-agent')).items.map(item => item.content)).toEqual(['Retained captured body'])
})

it('retireRuns preserves the earliest source, metadata and captured body after 257 retired Runs', async () => {
  const f = await fixture('claude')
  await captured(f.store, f.session.agentSessionId)
  await retire(f.store, f.session)
  const sidecars = await readdir(join(f.root, 'agent-timelines'))
  expect(sidecars).toHaveLength(1)
  const addedRuns = Array.from({ length: 256 }, (_, index) => ({ runId: `unbound-retained-${index}` }))
  await f.store.retireRuns(addedRuns)
  // Neither writer maintenance nor a fresh reader may erase the oldest readable identity.
  expect(await readdir(join(f.root, 'agent-timelines'))).toEqual(sidecars)
  const reader = freshHistoryReader(f.storePath)
  await expectOriginalHistory(reader, f)
  expect(await reader.store.loadRetiredRuns()).toEqual([f.session.run, ...addedRuns])
  expect(await reader.store.loadRetiredAgentSessions()).toEqual([expect.objectContaining({
    agentSessionId: f.session.agentSessionId, run: f.session.run, history: sessionHistoryMetadata(f.session)
  })])
  expect(await loadAgentSessions(reader.store)).toEqual([])
  expect(await readdir(join(f.root, 'agent-timelines'))).toEqual(sidecars)
})

it('releaseLifecycle preserves the earliest source and captured material after 257 retired Runs', async () => {
  const f = await fixture('claude')
  await captured(f.store, f.session.agentSessionId)
  await retire(f.store, f.session)
  const sidecars = await readdir(join(f.root, 'agent-timelines'))
  expect(sidecars).toHaveLength(1)
  const reservation = { kind: 'create' as const, reservationId: 'cleanup-release', ownerId: 'retained-owner',
    ownerPid: process.pid, agentSessionId: 'unused-reservation', operationId: 'cleanup-release', expiresAt: Date.now() + 60_000 }
  await f.store.reserveLifecycle(reservation)
  const addedRuns = Array.from({ length: 256 }, (_, index) => ({ runId: `released-${index}` }))
  await f.store.releaseLifecycle(reservation, addedRuns)
  expect(await readdir(join(f.root, 'agent-timelines'))).toEqual(sidecars)
  const reader = freshHistoryReader(f.storePath)
  await expectOriginalHistory(reader, f)
  expect(await reader.store.loadRetiredRuns()).toEqual([f.session.run, ...addedRuns])
  expect(await reader.store.loadRetiredAgentSessions()).toEqual([expect.objectContaining({
    agentSessionId: f.session.agentSessionId, run: f.session.run, history: sessionHistoryMetadata(f.session)
  })])
  expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toEqual([])
  expect(await readdir(join(f.root, 'agent-timelines'))).toEqual(sidecars)
})

it('a real sidecar maintenance error cannot reject a durably committed resume', async () => {
  const f = await fixture('claude')
  // A file where the directory should be gives the real filesystem ENOTDIR.
  await writeFile(join(f.root, 'agent-timelines'), 'private maintenance fault')
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  try {
    const reservation = { kind: 'resume' as const, reservationId: 'healthy-resume', ownerId: 'retained-owner',
      ownerPid: process.pid, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run,
      operationId: 'healthy-resume', expiresAt: Date.now() + 60_000 }
    await f.store.reserveLifecycle(reservation)
    const next = { ...f.session, run: { runId: 'healthy-resumed-run' }, retiredRuns: [f.session.run] }
    const commitError = await f.store.commitLifecycle(reservation, next).then(() => null, error => error)
    expect(commitError).toBeNull()
    const durable = JSON.parse(await readFile(f.storePath, 'utf8'))
    expect(durable.sessions.map((session: AgentMuxStoredAgentSession) => session.run.runId)).toEqual(['healthy-resumed-run'])
    expect(durable.reservations).toEqual([])
    // The public reader exposes maintenance failure without losing the committed Session.
    expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(f.storePath))).map(session => session.run.runId)).toEqual(['healthy-resumed-run'])
    expect(warning.mock.calls.map(call => call[1])).toContainEqual({ code: 'AGENT_SESSION_TIMELINE_CLEANUP_FAILED' })
  } finally { warning.mockRestore() }
})

it('legal retired metadata exceeding 1 MiB retains all 67 original sources and readable bodies', async () => {
  const f = await fixture('claude')
  await captured(f.store, f.session.agentSessionId)
  await retire(f.store, f.session)
  const original = JSON.parse(await readFile(f.storePath, 'utf8'))
  const seeded = Array.from({ length: 58 }, (_, index) => ({
    agentSessionId: `seeded-history-${index}`, hostId: 'local', run: { runId: `seeded-run-${index}` },
    source: 'user', observedAt: index + 1,
    history: sessionHistoryMetadata({ ...f.session, workspacePath: '/'.padEnd(16 * 1024, 'a') })
  }))
  const initial = `${JSON.stringify({ ...original,
    retiredRuns: [...original.retiredRuns, ...seeded.map(session => session.run)],
    retiredAgentSessions: [...original.retiredAgentSessions, ...seeded]
  }, null, 2)}\n`
  expect(Buffer.byteLength(initial)).toBeLessThan(1024 * 1024)
  await writeFile(f.storePath, initial)
  const addedSessions: AgentMuxStoredAgentSession[] = []
  const sidecars = await readdir(join(f.root, 'agent-timelines'))
  for (let index = 0; index < 8; index += 1) {
    const session = { ...f.session, agentSessionId: `large-history-${index}`, run: { runId: `large-run-${index}` },
      workspacePath: '/'.padEnd(16 * 1024, 'a') }
    addedSessions.push(session)
    const createError = await f.store.compareAndSwap(null, session).then(() => null, error => error)
    expect(createError).toBeNull()
    const stopError = await retire(f.store, session).then(() => null, error => error)
    expect(stopError).toBeNull()
  }
  const bytes = await readFile(f.storePath)
  const durable = JSON.parse(bytes.toString('utf8'))
  const expectedSources = [
    { agentSessionId: f.session.agentSessionId, history: sessionHistoryMetadata(f.session) },
    ...seeded.map(session => ({ agentSessionId: session.agentSessionId, history: session.history })),
    ...addedSessions.map(session => ({ agentSessionId: session.agentSessionId, history: sessionHistoryMetadata(session) }))
  ]
  expect(durable.retiredAgentSessions.map((session: { agentSessionId: string; history: unknown }) => ({
    agentSessionId: session.agentSessionId, history: session.history
  }))).toEqual(expectedSources)
  expect(bytes.length).toBeGreaterThan(1024 * 1024)
  expect(durable.retiredRuns).toEqual([f.session.run, ...seeded.map(session => session.run), ...addedSessions.map(session => session.run)])
  expect(durable.sessions).toEqual([])
  expect(durable.reservations).toEqual([])
  expect(await readdir(join(f.root, 'agent-timelines'))).toEqual(sidecars)
  const reader = freshHistoryReader(f.storePath)
  expect(await reader.store.loadRetiredRuns()).toHaveLength(67)
  expect(await reader.store.loadRetiredAgentSessions()).toHaveLength(67)
  expect((await reader.client.sessionHistorySources()).map(source => ({
    agentSessionId: source.agentSessionId, history: source.history
  }))).toEqual(expectedSources)
  await expectOriginalHistory(reader, f)
  expect((await reader.client.sessionHistoryPage('large-history-7')).items.map(item => [item.id, item.contentParts])).toEqual([
    ['native-input', [{ kind: 'text', text: 'Retained native body' }]]
  ])
  reader.assertNoRunControls()
  expect(await readFile(f.path)).toEqual(f.before.native)
}, 30_000)

it('a real sidecar maintenance error cannot reject an already committed retirement', async () => {
  const f = await fixture('claude')
  await writeFile(join(f.root, 'agent-timelines'), 'private maintenance fault')
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  try {
    const commitError = await retire(f.store, f.session).then(() => null, error => error)
    expect(commitError).toBeNull()
    const durable = JSON.parse(await readFile(f.storePath, 'utf8'))
    expect(durable.sessions).toEqual([])
    expect(durable.reservations).toEqual([])
    expect(durable.retiredAgentSessions.map((session: {agentSessionId: string}) => session.agentSessionId)).toEqual(['private-agent'])
    expect(warning.mock.calls.map(call => call[1])).toEqual([{ code: 'AGENT_SESSION_TIMELINE_CLEANUP_FAILED' }])
  } finally { warning.mockRestore() }
})

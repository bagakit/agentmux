const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import type { AgentMuxClient } from '../../../packages/core/src/client.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod } from '../../../packages/core/src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentSessionHistoryObservation, AgentSessionHistoryPage } from '@agentmux/core'

vi.setConfig({ testTimeout: 20_000 })
const control = { hostId: 'local', agentSessionId: 'private-history-session', kind: 'agent' as const, run: { runId: 'private-run' } }
const source = { providerId: 'codex' as const, nativeSessionId: 'private-native-source' }
const invalidated: AgentSessionHistoryObservation = { kind: 'invalidated', agentSessionId: control.agentSessionId, source }
const unavailable: Extract<AgentSessionHistoryObservation, { kind: 'unavailable' }> = { kind: 'unavailable', agentSessionId: control.agentSessionId, source,
  code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', message: 'Private SQLite writer is mid-commit; original watch remains valid.' }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function fixture(options: { unavailableDuringAdmission?: boolean; sourceChangedDuringAdmission?: boolean } = {}) {
  let page: AgentSessionHistoryPage = { agentSessionId: control.agentSessionId, source,
    items: [{ id: 'original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original native reply remains readable.' }] }], nextCursor: null }
  let nativeSource = source
  const callbacks: Array<(value: AgentSessionHistoryObservation) => void> = [], releases: Array<ReturnType<typeof vi.fn>> = []
  const identity = { hostId: 'local', instanceId: 'private-daemon', buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123, ownership: 'owned' as const }
  const owner = hostedTestOwner({ runtimeIdentity: () => identity })
  const core = {
    connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
    onEvent: vi.fn((_listener: (event: AgentMuxClientEvent) => void) => () => {}),
    runtimeIdentity: () => identity, catalog: () => [], agentSessions: () => [], async readAgentSessions() { return this.agentSessions() },
    metadata: { pendingIds: () => [], read: async () => {}, retainObservation: () => null }, agentMessageQueuePath: () => _hygiene_fixturePath("private/messages.ndjson"),
    runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: [] })),
    sessionHistoryPage: vi.fn(async () => page),
    observeSessionHistory: vi.fn(async (_id: string, listener: (value: AgentSessionHistoryObservation) => void) => {
      const release = vi.fn(); releases.push(release); callbacks.push(listener)
      if (options.unavailableDuringAdmission) listener(unavailable)
      if (options.sourceChangedDuringAdmission) listener({ ...unavailable, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'The original source changed during admission.' })
      return { source: nativeSource, dispose: release }
    }),
    submitAgentPrompt: vi.fn(), stopTerminal: vi.fn(), writeAgentInput: vi.fn()
  }
  const service = new AgentMuxHostedRuntimeService(core as unknown as AgentMuxClient, _hygiene_fixturePath("private/sessions.json"), () => owner)
  const leases: Array<{ method: string; close(): Promise<void> }> = []
  let failHistory = false, historyAttempts = 0
  const rpc = {
    call: async (method: string, params: unknown, context?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), context))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      if (method === 'runtime.history-watch') {
        historyAttempts++
        if (failHistory) throw new Error('Private history transport is unavailable; general events remain connected.')
      }
      let closed = false
      const subscription = await service.subscribe(method, JSON.parse(JSON.stringify(params)), event => {
        if (closed) return
        handlers.onEvent(event)
        if (event.type === 'end' && !closed) { closed = true; handlers.onEnd?.() }
      }, handlers.signal ? { signal: handlers.signal } : {})
      const close = async () => { if (closed) return; closed = true; await subscription.dispose(); handlers.onEnd?.(new Error('Private history connection lost')) }
      try { handlers.onInitial(subscription.initial as AgentMuxHostedStreamInitial<AgentMuxHostedStreamMethod>); await subscription.start?.() }
      catch (error) { await close(); throw error }
      leases.push({ method, close })
      return { dispose: close }
    }
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc })
  return { core, client, service, callbacks, releases, leases,
    attempts: () => historyAttempts, fail: () => { failHistory = true }, recover: () => { failHistory = false },
    append: () => { page = { ...page, items: [...page.items, { id: 'later', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Later native input arrives on the same source.' }] }] } },
    close: async () => {
      await client.dispose(); await service.dispose()
      expect(core.submitAgentPrompt).not.toHaveBeenCalled(); expect(core.writeAgentInput).not.toHaveBeenCalled(); expect(core.stopTerminal).not.toHaveBeenCalled()
    }
  }
}

// The public raw history-watch protocol keeps its own admission and reconnect
// contract. Current Conversation readers instead use runtime.conversation-watch;
// their retained DOM, Range and recovery are tested by its actual consumers.
it.each([false, true])('the public Hosted history watch retains its original lease through unavailable during admission=%s', async duringAdmission => {
  const f = await fixture({ unavailableDuringAdmission: duringAdmission }), events: AgentSessionHistoryObservation[] = []
  try {
    const handle = await f.client.observeSessionHistory(control.agentSessionId, event => events.push(event))
    const original = await f.client.sessionHistoryPage(control.agentSessionId)
    expect(handle.source).toEqual(source); expect(original.items.map(item => item.id)).toEqual(['original'])
    if (!duringAdmission) f.callbacks[0]!(unavailable)
    await vi.waitFor(() => expect(events).toContainEqual(unavailable))
    expect(f.releases[0]).not.toHaveBeenCalled()
    f.append(); f.callbacks[0]!(invalidated)
    await vi.waitFor(() => expect(events.at(-1)).toEqual(invalidated))
    const current = await f.client.sessionHistoryPage(control.agentSessionId)
    expect(current.source).toEqual(source); expect(current.items.map(item => item.id)).toEqual(['original', 'later'])
    expect(original.items.map(item => item.id)).toEqual(['original'])
    expect(f.core.observeSessionHistory).toHaveBeenCalledOnce(); expect(f.attempts()).toBe(1)
    handle.dispose(); await vi.waitFor(() => expect(f.releases[0]).toHaveBeenCalledOnce())
  } finally { await f.close() }
})
it('a source change before raw history admission remains an authoritative observation rather than a substituted cancellation', async () => {
  const f = await fixture({ sourceChangedDuringAdmission: true }), events: AgentSessionHistoryObservation[] = []
  try {
    await expect(f.client.observeSessionHistory(control.agentSessionId, event => events.push(event))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
    expect(events).toEqual([{ ...unavailable, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'The original source changed during admission.' }])
    expect(f.releases[0]).toHaveBeenCalledOnce(); expect(f.attempts()).toBe(1)
    f.callbacks[0]!(invalidated)
    expect(events).toHaveLength(1)
    expect((await f.client.sessionHistoryPage(control.agentSessionId)).items.map(item => item.id)).toEqual(['original'])
  } finally { await f.close() }
})
it('the raw Hosted history observer survives eight failed reconnects and cancels its pending retry when released', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const handle = await f.client.observeSessionHistory(control.agentSessionId, event => events.push(event))
  vi.useFakeTimers()
  try {
    f.fail(); await f.leases.find(value => value.method === 'runtime.history-watch')!.close()
    for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800]) await vi.advanceTimersByTimeAsync(delay)
    expect(f.attempts()).toBe(9)
    expect(events.at(-1)).toMatchObject({ kind: 'unavailable', source, code: 'AGENT_SESSION_HISTORY_CONNECTION_UNCONFIRMED' })
    f.recover(); f.append(); await vi.advanceTimersByTimeAsync(25600); await vi.advanceTimersByTimeAsync(50)
    expect(f.attempts()).toBe(10); expect(events.at(-1)).toEqual(invalidated)
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(2)
    expect((await f.client.sessionHistoryPage(control.agentSessionId)).items.map(item => item.id)).toEqual(['original', 'later'])
    f.fail(); await f.leases.filter(value => value.method === 'runtime.history-watch').at(-1)!.close()
    const before = f.attempts(); handle.dispose(); await vi.advanceTimersByTimeAsync(120_000)
    expect(f.attempts()).toBe(before)
  } finally { await f.close() }
})

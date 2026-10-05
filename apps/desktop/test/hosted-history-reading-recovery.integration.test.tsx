const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import type { AgentMuxClient } from '../../../packages/core/src/client.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod, AgentMuxRuntimeOwnerIdentity } from '../../../packages/core/src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentSessionHistoryObservation, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.setConfig({ testTimeout: 20_000 }) // Includes loading the actual Desktop presentation and its dependency graph.
const control = { hostId: 'local', agentSessionId: 'private-history-session', kind: 'agent' as const, run: { runId: 'private-run' } }
const source = { providerId: 'codex' as const, nativeSessionId: 'private-native-source' }
const invalidated: AgentSessionHistoryObservation = { kind: 'invalidated', agentSessionId: control.agentSessionId, source }
const unavailable: Extract<AgentSessionHistoryObservation, { kind: 'unavailable' }> = { kind: 'unavailable', agentSessionId: control.agentSessionId, source,
  code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', message: 'Private SQLite writer is mid-commit; original watch remains valid.' }

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { delete window.agentmux; vi.useRealTimers(); vi.restoreAllMocks() })

async function fixture(options: { unavailableDuringAdmission?: boolean; sourceChangedDuringAdmission?: boolean } = {}) {
  let page: AgentSessionHistoryPage = { agentSessionId: control.agentSessionId, source,
    items: [{ id: 'original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original native reply remains readable.' }] }], nextCursor: null }
  let nativeSource = source
  const callbacks: Array<(value: AgentSessionHistoryObservation) => void> = [], releases: Array<ReturnType<typeof vi.fn>> = []
  const identity = { hostId: 'local', instanceId: 'private-daemon', buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123, ownership: 'owned' as const }
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-runtime', ownerInstanceId: 'private-owner', protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: identity }
  const core = {
    connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
    onEvent: vi.fn((_listener: (event: AgentMuxClientEvent) => void) => () => {}),
    runtimeIdentity: () => identity, catalog: () => [], agentSessions: () => [], agentMessageQueuePath: () => _hygiene_fixturePath("private/messages.ndjson"),
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
  // Control only the isolated preload port; the production Desktop API, observation
  // adapter, shared reader, ActivityView, Hosted service, SDK and codec are real.
  const observe = vi.fn<AgentMuxPreloadApi['sessions']['observeHistory']>(async (reference, listener, config) => {
    const controller = new AbortController(), remove = config?.onAbort?.(() => controller.abort())
    const handle = await client.observeSessionHistory(reference.agentSessionId, listener, { signal: controller.signal })
    return { source: handle.source, dispose: () => { remove?.(); handle.dispose() } }
  })
  window.agentmux = { control: {}, sessions: { observeHistory: observe,
    historyPage: async (reference: Parameters<AgentMuxPreloadApi['sessions']['historyPage']>[0]) => client.sessionHistoryPage(reference.agentSessionId), onEvent: () => () => {} } } as unknown as AgentMuxPreloadApi
  const { useSessionUserMessages } = await import('../src/renderer/src/lib/session-user-messages')
  const { ActivityView } = await import('../src/renderer/src/components/ActivityView')
  const { createClientUiRoot } = await import('./helpers/client-ui-render')
  let reading!: ReturnType<typeof useSessionUserMessages>
  function Reader() {
    reading = useSessionUserMessages(control)
    return <><span data-observation-error>{reading.observationError?.message}</span>
      <ActivityView sessionId={control.agentSessionId} items={[]} userMessages={reading.messages}
        nativeHistoryPage={reading.nativeHistoryPage} capability="complete-events" displayState="done" /></>
  }
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  await act(async () => root.render(<Reader />))
  let mounted = true
  const unmount = async () => { if (!mounted) return; mounted = false; await act(async () => root.unmount()); host.remove() }
  return { core, client, service, callbacks, releases, leases, observe, host,
    reading: () => reading, attempts: () => historyAttempts, fail: () => { failHistory = true },
    recover: () => { failHistory = false }, changeSource: () => { nativeSource = { ...source, nativeSessionId: 'another-source' }; page = { ...page, source: nativeSource } },
    append: () => { page = { ...page, items: [...page.items, { id: 'later', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Later native input arrives on the same source.' }] }] } },
    unmount,
    close: async () => { await unmount(); await client.dispose(); await service.dispose() }
  }
}

it.each([false, true])('keeps the original mounted reader through transient unavailable (during admission=%s) and clears only its recovered notice', async duringAdmission => {
  const f = await fixture({ unavailableDuringAdmission: duringAdmission })
  try {
    const original = f.host.querySelector('[data-native-record-id="original"]')!
    const range = document.createRange(); range.selectNodeContents(original)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    if (!duringAdmission) await act(async () => { f.callbacks[0]!(unavailable) })
    expect(f.reading().observationError?.message).toContain('mid-commit')
    expect(f.releases[0]).not.toHaveBeenCalled()
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    f.append()
    await act(async () => { f.callbacks[0]!(invalidated); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(f.reading().observationError).toBeNull()
    expect(f.host.querySelector('[data-native-record-id="later"]')?.textContent).toContain('Later native input')
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(range.startContainer).toBe(original)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(1)
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled(); expect(f.core.writeAgentInput).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('retains a confirmed source change reported before watch admission instead of overwriting it with cancellation', async () => {
  const f = await fixture({ sourceChangedDuringAdmission: true })
  try {
    expect(f.reading().sourceChanged).toBe(true)
    expect(f.reading().observationError?.message).toContain('source changed during admission')
    expect(f.releases[0]).toHaveBeenCalledTimes(1)
    expect(f.host.querySelector('[data-native-record-id="original"]')?.textContent).toContain('Original native reply')
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled(); expect(f.core.writeAgentInput).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('continues the same reader after eight failed history-only reconnects and releases a pending slow retry when its Consumer leaves', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  try {
    const original = f.host.querySelector('[data-native-record-id="original"]')
    f.fail()
    await act(async () => { await f.leases.find(value => value.method === 'runtime.history-watch')!.close() })
    for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800]) await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
    expect(f.attempts()).toBe(9)
    expect(f.reading().observationError).not.toBeNull()
    f.recover(); f.append()
    await act(async () => { await vi.advanceTimersByTimeAsync(25600); await vi.advanceTimersByTimeAsync(50) })
    expect(f.attempts()).toBe(10)
    expect(f.reading().observationError).toBeNull()
    expect(f.host.querySelector('[data-native-record-id="later"]')?.textContent).toContain('Later native input')
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(2)
    f.fail()
    await act(async () => { await f.leases.filter(value => value.method === 'runtime.history-watch').at(-1)!.close() })
    const attempts = f.attempts()
    await f.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.attempts()).toBe(attempts)
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled(); expect(f.core.stopTerminal).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each(['native-event', 'reconnect'])('retains the original window and requires explicit refresh after confirmed source change via %s', async shape => {
  const f = await fixture()
  try {
    const original = f.host.querySelector('[data-native-record-id="original"]')
    if (shape === 'native-event') await act(async () => { f.changeSource(); f.callbacks[0]!({ ...unavailable, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'The original source changed.' }) })
    else {
      vi.useFakeTimers(); f.changeSource()
      await act(async () => { await f.leases.find(value => value.method === 'runtime.history-watch')!.close(); await vi.advanceTimersByTimeAsync(100) })
    }
    expect(f.reading().sourceChanged).toBe(true)
    expect(f.releases.every(release => release.mock.calls.length === 1)).toBe(true)
    const reads = f.core.sessionHistoryPage.mock.calls.length, attempts = f.attempts()
    f.append()
    await act(async () => { f.callbacks[0]!(invalidated) })
    if (shape === 'reconnect') await vi.advanceTimersByTimeAsync(120_000)
    else await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.attempts()).toBe(attempts)
    expect(f.core.sessionHistoryPage).toHaveBeenCalledTimes(reads)
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(f.host.querySelector('[data-native-record-id="later"]')).toBeNull()
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled()
    await act(async () => { await f.reading().refresh() })
    expect(f.reading().sourceChanged).toBe(false)
    expect(f.reading().nativeHistoryPage?.source.nativeSessionId).toBe('another-source')
    expect(f.host.querySelector('[data-native-record-id="later"]')?.textContent).toContain('Later native input')
    expect(f.observe).toHaveBeenCalledTimes(2)
  } finally { await f.close() }
})

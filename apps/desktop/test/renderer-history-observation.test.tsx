// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle, AgentSessionHistoryPage } from '@agentmux/core'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
const reference = { hostId: 'local', agentSessionId: 'native-reader-session' }
const control = { ...reference, kind: 'agent' as const, run: { runId: 'native-reader-run' } }
const source = { providerId: 'codex' as const, nativeSessionId: 'native-reader-source' }
const event: AgentSessionHistoryObservation = { ...reference, source, kind: 'invalidated' }
let api: (typeof import('../src/renderer/src/lib/api'))['api']
let transport: ReturnType<typeof vi.fn<AgentMuxPreloadApi['sessions']['observeHistory']>>
let releases: Array<ReturnType<typeof vi.fn>>
let callbacks: Array<(value: AgentSessionHistoryObservation) => void>
beforeEach(async () => {
  vi.resetModules(); releases = []; callbacks = []
  transport = vi.fn<AgentMuxPreloadApi['sessions']['observeHistory']>(async (_reference, listener, options) => {
    let disposed = false
    callbacks.push(value => { if (!disposed) listener(value) })
    let unsubscribe: (() => void) | undefined
    const release = vi.fn(() => { if (disposed) return; disposed = true; unsubscribe?.() })
    unsubscribe = options?.onAbort?.(release)
    releases.push(release)
    // Explicit transport boundary: AbortSignal must never enter an isolated preload world.
    if (options && 'signal' in options) throw new Error('AbortSignal crossed contextBridge')
    return { source, dispose: release }
  })
  window.agentmux = { control: {}, sessions: { observeHistory: transport, onEvent: () => () => {} } } as unknown as AgentMuxPreloadApi
  api = (await import('../src/renderer/src/lib/api')).api
})
afterEach(() => { delete window.agentmux; vi.restoreAllMocks() })
it('actual Desktop API acquires via function-only transport and releases the local signal listener', async () => {
  const controller = new AbortController(), receive = vi.fn()
  const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
  const handle = await api.sessions.observeHistory(reference, receive, { signal: controller.signal })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(transport.mock.calls[0]![2]).toEqual({ onAbort: expect.any(Function) })
  expect(add).toHaveBeenCalledTimes(1)
  callbacks[0]!(event); expect(receive).toHaveBeenCalledWith(event)
  handle.dispose(); expect(remove).toHaveBeenCalledTimes(1)
  callbacks[0]!(event); expect(receive).toHaveBeenCalledTimes(1)
})
it('pre-cancelled acquisition stays entirely local and preserves its original reason', async () => {
  const controller = new AbortController(), reason = new Error('Original Renderer cancellation')
  controller.abort(reason)
  await expect(api.sessions.observeHistory(reference, () => {}, { signal: controller.signal })).rejects.toBe(reason)
  expect(transport).not.toHaveBeenCalled()
})
it('pending cancellation rejects a late handle instead of installing another active observation', async () => {
  const controller = new AbortController(), release = vi.fn(), receive = vi.fn()
  let ready!: (handle: AgentSessionHistoryObservationHandle) => void
  transport.mockImplementationOnce(async (_reference, _listener, options) => {
    options?.onAbort?.(() => {})
    return new Promise(resolve => { ready = resolve })
  })
  const reason = new Error('Cancelled during acquisition')
  const pending = api.sessions.observeHistory(reference, receive, { signal: controller.signal })
  const rejected = expect(pending).rejects.toBe(reason)
  controller.abort(reason); ready({ source, dispose: release })
  await rejected; expect(release).toHaveBeenCalledTimes(1)
})
it('native invalidation refreshes the shared reading surface without Hook events', async () => {
  const original: AgentSessionHistoryPage = { ...reference, source, items: [{
    id: 'initial-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Ready for terminal input.' }]
  }], nextCursor: null }
  const updated: AgentSessionHistoryPage = { ...original, items: [...original.items, {
    id: 'terminal-user-record', kind: 'user-message', contentParts: [{ kind: 'text', text: 'A new message typed directly in the terminal.' }]
  }] }
  let changed = false
  const read = vi.fn<AgentMuxPreloadApi['sessions']['historyPage']>(async () => changed ? updated : original)
  window.agentmux!.sessions.historyPage = read
  // api is already constructed from this same preload. Install history read via its public method.
  api.sessions.historyPage = read
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const { useSessionUserMessages } = await import('../src/renderer/src/lib/session-user-messages')
  const { ActivityView } = await import('../src/renderer/src/components/ActivityView')
  let observationError: Error | null = null
  function Reader({ enabled }: { enabled: boolean }) {
    const reading = useSessionUserMessages(control, { enabled }); observationError = reading.observationError
    return <ActivityView sessionId={reference.agentSessionId} items={[]} userMessages={reading.messages}
      nativeHistoryPage={reading.nativeHistoryPage} capability="complete-events" displayState="done" />
  }
  const { createClientUiRoot } = await import('./helpers/client-ui-render')
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  try {
    await act(async () => root.render(<Reader enabled={true} />))
    expect(observationError).toBeNull(); expect(transport).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('A new message typed directly in the terminal.')
    changed = true
    await act(async () => { callbacks[0]!(event); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(observationError).toBeNull()
    const row = host.querySelector('[data-native-record-id="terminal-user-record"]')
    expect(row?.textContent).toContain('A new message typed directly in the terminal.')
    expect(read.mock.calls.length).toBeGreaterThan(1)
    const count = read.mock.calls.length
    await act(async () => root.render(<Reader enabled={false} />))
    await act(async () => { callbacks[0]!(event); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(read).toHaveBeenCalledTimes(count)
    expect(host.querySelector('[data-native-record-id="terminal-user-record"]')).toBe(row)
  } finally { await act(async () => root.unmount()); host.remove() }
})

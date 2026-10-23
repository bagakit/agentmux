// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from '@agentmux/core'
import { createRendererHistoryObservation } from '../src/renderer/src/lib/history-observation'

const reference = { hostId: 'local', agentSessionId: 'native-reader-session' }
const source = { providerId: 'codex' as const, nativeSessionId: 'native-reader-source' }
const event: AgentSessionHistoryObservation = { ...reference, source, kind: 'invalidated' }
let observeHistory: ReturnType<typeof createRendererHistoryObservation>
let transport: ReturnType<typeof vi.fn<AgentMuxPreloadApi['sessions']['observeHistory']>>
let releases: Array<ReturnType<typeof vi.fn>>
let callbacks: Array<(value: AgentSessionHistoryObservation) => void>
beforeEach(() => {
  releases = []; callbacks = []
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
  observeHistory = createRendererHistoryObservation(transport)
})
afterEach(() => { vi.restoreAllMocks() })
it('actual Desktop history observation owner acquires via function-only transport and releases the local signal listener', async () => {
  const controller = new AbortController(), receive = vi.fn()
  const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
  const handle = await observeHistory(reference, receive, { signal: controller.signal })
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
  await expect(observeHistory(reference, () => {}, { signal: controller.signal })).rejects.toBe(reason)
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
  const pending = observeHistory(reference, receive, { signal: controller.signal })
  const rejected = expect(pending).rejects.toBe(reason)
  controller.abort(reason); ready({ source, dispose: release })
  await rejected; expect(release).toHaveBeenCalledTimes(1)
})

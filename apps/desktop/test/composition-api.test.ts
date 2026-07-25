import { describe, expect, it, vi } from 'vitest'
import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  type AgentMuxCompositionRequest,
  type AgentMuxCompositionResult
} from '@agentmux/core'
import type {
  AgentMuxPreloadApi,
  DesktopCompositionCancellation
} from '../src/shared/contracts.js'
import { createRendererCompositionApi } from '../src/renderer/src/lib/composition-api.js'

type CompositionPreloadApi = AgentMuxPreloadApi['composition']

function request(): AgentMuxCompositionRequest {
  return {
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: 'launch-claude-right',
    operation: 'launch',
    caller: { agentSessionId: 'caller' },
    executorId: 'claude-review',
    placement: 'split-right',
    relativeTo: { kind: 'self' }
  }
}

function contextResult(): AgentMuxCompositionResult {
  return {
    operation: 'context',
    context: {
      agentSessionId: 'caller',
      workspaceId: 'workspace',
      viewId: 'view',
      regionId: 'region',
      tabGroupId: 'group',
      regions: [{
        regionId: 'region',
        kind: 'agent',
        providerId: 'codex',
        executorId: 'codex',
        agentSessionId: 'caller',
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      }],
      executors: [{ executorId: 'codex', label: 'Codex', providerId: 'codex', available: true }]
    }
  }
}

function createPreloadHarness(): {
  preload: CompositionPreloadApi
  deliverRequest(request: AgentMuxCompositionRequest): void
  deliverCancellation(cancellation: DesktopCompositionCancellation): void
  responses: Parameters<CompositionPreloadApi['respond']>[0][]
  disposeRequests: ReturnType<typeof vi.fn>
  disposeCancellations: ReturnType<typeof vi.fn>
} {
  let requestListener!: Parameters<CompositionPreloadApi['onRequest']>[0]
  let cancellationListener!: Parameters<CompositionPreloadApi['onCancellation']>[0]
  const responses: Parameters<CompositionPreloadApi['respond']>[0][] = []
  const disposeRequests = vi.fn()
  const disposeCancellations = vi.fn()
  return {
    preload: {
      onRequest(listener) {
        requestListener = listener
        return disposeRequests
      },
      onCancellation(listener) {
        cancellationListener = listener
        return disposeCancellations
      },
      respond: (response) => responses.push(response)
    },
    deliverRequest: (value) => requestListener(value),
    deliverCancellation: (value) => cancellationListener(value),
    responses,
    disposeRequests,
    disposeCancellations
  }
}

describe('Renderer Composition API', () => {
  it('owns a real AbortSignal inside the Renderer world', async () => {
    const harness = createPreloadHarness()
    const composition = createRendererCompositionApi(harness.preload)
    let observedSignal!: AbortSignal
    let resolveAborted!: (reason: unknown) => void
    let resolveResult!: (result: AgentMuxCompositionResult) => void
    const aborted = new Promise<unknown>((resolve) => {
      resolveAborted = resolve
    })
    const result = new Promise<AgentMuxCompositionResult>((resolve) => {
      resolveResult = resolve
    })
    composition.onRequest((_request, signal) => {
      observedSignal = signal
      signal.addEventListener('abort', () => resolveAborted(signal.reason), { once: true })
      return result
    })
    harness.deliverRequest(request())
    await Promise.resolve()

    expect(observedSignal).toBeInstanceOf(AbortSignal)
    expect(typeof observedSignal.addEventListener).toBe('function')
    const cancellation: DesktopCompositionCancellation = {
      requestId: 'launch-claude-right',
      code: 'COMPOSITION_TIMEOUT',
      message: 'Desktop Composition request timed out.'
    }
    harness.deliverCancellation(cancellation)

    await expect(aborted).resolves.toMatchObject({
      code: cancellation.code,
      message: cancellation.message
    })
    resolveResult(contextResult())
    await Promise.resolve()
    expect(harness.responses).toEqual([])
  })

  it('settles a completed request exactly once', async () => {
    const harness = createPreloadHarness()
    const composition = createRendererCompositionApi(harness.preload)
    composition.onRequest(() => contextResult())

    harness.deliverRequest(request())
    await vi.waitFor(() => expect(harness.responses).toHaveLength(1))

    expect(harness.responses[0]).toMatchObject({
      requestId: 'launch-claude-right',
      ok: true,
      result: { operation: 'context' }
    })
  })

  it('returns a typed failure once when the Renderer transaction fails', async () => {
    const harness = createPreloadHarness()
    const composition = createRendererCompositionApi(harness.preload)
    composition.onRequest(() => {
      throw Object.assign(new Error('Target Region is stale.'), { code: 'STALE_REGION_TARGET' })
    })

    harness.deliverRequest(request())
    await vi.waitFor(() => expect(harness.responses).toHaveLength(1))

    expect(harness.responses).toEqual([{
      requestId: 'launch-claude-right',
      ok: false,
      code: 'STALE_REGION_TARGET',
      message: 'Target Region is stale.'
    }])
  })

  it('aborts every owned transaction when the Renderer owner is disposed', async () => {
    const harness = createPreloadHarness()
    const composition = createRendererCompositionApi(harness.preload)
    let resolveAborted!: (reason: unknown) => void
    const aborted = new Promise<unknown>((resolve) => {
      resolveAborted = resolve
    })
    const dispose = composition.onRequest((_request, signal) => {
      signal.addEventListener('abort', () => resolveAborted(signal.reason), { once: true })
      return new Promise(() => {})
    })
    harness.deliverRequest(request())
    await Promise.resolve()

    dispose()

    await expect(aborted).resolves.toMatchObject({
      code: 'COMPOSITION_UNAVAILABLE',
      message: 'Desktop Composition owner was disposed.'
    })
    expect(harness.disposeRequests).toHaveBeenCalledOnce()
    expect(harness.disposeCancellations).toHaveBeenCalledOnce()
    expect(harness.responses).toEqual([])
  })
})

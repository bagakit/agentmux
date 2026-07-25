import { describe, expect, it, vi } from 'vitest'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest,
  type AgentMuxControlResult
} from '@agentmux/core'
import type {
  AgentMuxPreloadApi,
  DesktopControlCancellation
} from '../src/shared/contracts.js'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api.js'

type ControlPreloadApi = AgentMuxPreloadApi['control']

function request(): AgentMuxControlRequest {
  return {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'open-claude-right',
    operation: 'open.agent',
    caller: { agentSessionId: 'caller' },
    content: { kind: 'new-agent', executorId: 'claude-review' },
    destination: { kind: 'split', direction: 'right', region: { kind: 'self' } }
  }
}

function result(): AgentMuxControlResult {
  return {
    operation: 'open.agent',
    region: {
      kind: 'agent',
      tabId: 'tab',
      regionId: 'region',
      workspaceId: 'workspace',
      agentSessionId: 'caller',
      providerId: 'codex',
      executorId: 'codex'
    }
  }
}

function createPreloadHarness(): {
  preload: ControlPreloadApi
  deliverRequest(request: AgentMuxControlRequest): void
  deliverCancellation(cancellation: DesktopControlCancellation): void
  responses: Parameters<ControlPreloadApi['respond']>[0][]
  disposeRequests: ReturnType<typeof vi.fn>
  disposeCancellations: ReturnType<typeof vi.fn>
} {
  let requestListener!: Parameters<ControlPreloadApi['onRequest']>[0]
  let cancellationListener!: Parameters<ControlPreloadApi['onCancellation']>[0]
  const responses: Parameters<ControlPreloadApi['respond']>[0][] = []
  const disposeRequests = vi.fn()
  const disposeCancellations = vi.fn()

  return {
    preload: {
      onRequest: (listener) => {
        requestListener = listener
        return disposeRequests
      },
      onCancellation: (listener) => {
        cancellationListener = listener
        return disposeCancellations
      },
      respond: (response) => {
        responses.push(response)
      }
    },
    deliverRequest: (req) => requestListener(req),
    deliverCancellation: (cancellation) => cancellationListener(cancellation),
    responses,
    disposeRequests,
    disposeCancellations
  }
}

describe('Renderer Control API', () => {
  it('delivers requests, tracks signals, and responds with successful results', async () => {
    const harness = createPreloadHarness()
    const api = createRendererControlApi(harness.preload)
    const observedSignals: AbortSignal[] = []

    const dispose = api.onRequest(async (req, signal) => {
      observedSignals.push(signal)
      expect(req).toEqual(request())
      return result()
    })

    harness.deliverRequest(request())
    await vi.waitFor(() => {
      expect(observedSignals).toHaveLength(1)
      expect(observedSignals[0]!.aborted).toBe(false)
      expect(harness.responses).toEqual([{
        requestId: 'open-claude-right',
        ok: true,
        result: result()
      }])
    })

    dispose()
    expect(harness.disposeRequests).toHaveBeenCalledTimes(1)
    expect(harness.disposeCancellations).toHaveBeenCalledTimes(1)
  })

  it('aborts active signals when the main process cancels a pending transaction', async () => {
    const harness = createPreloadHarness()
    const api = createRendererControlApi(harness.preload)
    let activeSignal: AbortSignal | null = null

    api.onRequest((_req, signal) => {
      activeSignal = signal
      return new Promise<AgentMuxControlResult>(() => {})
    })

    harness.deliverRequest(request())
    await Promise.resolve()
    expect(activeSignal).not.toBeNull()
    expect(activeSignal!.aborted).toBe(false)

    harness.deliverCancellation({
      requestId: 'open-claude-right',
      code: 'CONTROL_TIMEOUT',
      message: 'Desktop Control request timed out.'
    })

    expect(activeSignal!.aborted).toBe(true)
    expect(activeSignal!.reason).toMatchObject({
      code: 'CONTROL_TIMEOUT',
      message: 'Desktop Control request timed out.'
    })
  })

  it('closes unknown error codes and malformed ambiguity candidates', async () => {
    const harness = createPreloadHarness()
    const api = createRendererControlApi(harness.preload)
    api.onRequest(() => {
      throw Object.assign(new Error('bad owner error'), {
        code: 'PRIVATE_OWNER_ERROR',
        candidates: [{ agentSessionId: '', regionIds: [] }]
      })
    })

    harness.deliverRequest(request())

    await vi.waitFor(() => expect(harness.responses).toEqual([{
      requestId: 'open-claude-right',
      ok: false,
      error: {
        code: 'CONTROL_FAILED',
        message: 'Desktop Control owner returned unexpected message target candidates.'
      }
    }]))
  })
})

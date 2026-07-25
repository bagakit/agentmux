import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  type AgentMuxCompositionRequest
} from '@agentmux/core'
import { DesktopCompositionIpcBridge } from '../src/main/composition-ipc-bridge.js'

function contextRequest(requestId: string): AgentMuxCompositionRequest {
  return {
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId,
    operation: 'context',
    caller: { agentSessionId: 'caller' }
  }
}

function launchRequest(requestId: string): AgentMuxCompositionRequest {
  return {
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId,
    operation: 'launch',
    caller: { agentSessionId: 'caller' },
    executorId: 'codex',
    placement: 'split-right',
    relativeTo: { kind: 'self' }
  }
}

afterEach(() => vi.useRealTimers())

describe('Desktop Composition IPC bridge', () => {
  it('cancels the Renderer transaction when a launch times out and ignores its late response', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const cancellations: unknown[] = []
    const bridge = new DesktopCompositionIpcBridge({
      isAvailable: () => true,
      sendRequest: (request) => sent.push(request),
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })

    const pending = bridge.execute(launchRequest('launch-timeout'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPOSITION_TIMEOUT' })
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)

    await rejected
    expect(cancellations).toEqual([{
      requestId: 'launch-timeout',
      code: 'COMPOSITION_TIMEOUT',
      message: 'Desktop Composition request timed out.'
    }])
    expect(bridge.accept({
      requestId: 'launch-timeout',
      ok: true,
      result: {
        operation: 'launch',
        agentSessionId: 'late',
        region: {
          viewId: 'late-view',
          regionId: 'late-region',
          kind: 'agent',
          agentSessionId: 'late',
          workspaceId: 'workspace',
          tabGroupId: 'group'
        }
      }
    })).toBe(false)
  })

  it('cancels every pending Renderer transaction when the owner is disposed', async () => {
    const cancellations: unknown[] = []
    const bridge = new DesktopCompositionIpcBridge({
      isAvailable: () => true,
      sendRequest: () => {},
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })
    const pending = bridge.execute(contextRequest('dispose-me'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPOSITION_UNAVAILABLE' })

    bridge.dispose()

    await rejected
    expect(cancellations).toEqual([expect.objectContaining({ requestId: 'dispose-me' })])
  })
})

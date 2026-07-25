import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'

function inspectRequest(requestId: string): AgentMuxControlRequest {
  return {
    schemaVersion: AGMUX_CONTROL_SCHEMA_VERSION,
    requestId,
    operation: 'inspect.tab',
    caller: { agentSessionId: 'caller' },
    target: { kind: 'self' }
  }
}

function openRequest(requestId: string): AgentMuxControlRequest {
  return {
    schemaVersion: AGMUX_CONTROL_SCHEMA_VERSION,
    requestId,
    operation: 'open.agent',
    caller: { agentSessionId: 'caller' },
    content: { kind: 'new-agent', executorId: 'codex' },
    destination: { kind: 'new-tab', after: { kind: 'self' } }
  }
}

const AGMUX_CONTROL_SCHEMA_VERSION = AGENTMUX_CONTROL_SCHEMA_VERSION

afterEach(() => vi.useRealTimers())

describe('Desktop Control IPC bridge', () => {
  it('cancels the Renderer transaction when a long request times out and ignores its late response', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const cancellations: unknown[] = []
    const bridge = new DesktopControlIpcBridge({
      isAvailable: () => true,
      sendRequest: (request) => sent.push(request),
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })

    const pending = bridge.execute(openRequest('open-timeout'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)

    await rejected
    expect(cancellations).toEqual([{
      requestId: 'open-timeout',
      code: 'CONTROL_TIMEOUT',
      message: 'Desktop Control request timed out.'
    }])
    expect(bridge.accept({
      requestId: 'open-timeout',
      ok: true,
      result: {
        operation: 'open.agent',
        region: {
          kind: 'agent',
          tabId: 'late-tab',
          regionId: 'late-region',
          workspaceId: 'workspace',
          agentSessionId: 'late',
          providerId: 'codex',
          executorId: 'codex'
        }
      }
    })).toBe(false)
  })

  it('cancels every pending Renderer transaction when the owner is disposed', async () => {
    const cancellations: unknown[] = []
    const bridge = new DesktopControlIpcBridge({
      isAvailable: () => true,
      sendRequest: () => {},
      sendCancellation: (cancellation) => cancellations.push(cancellation)
    })
    const pending = bridge.execute(inspectRequest('dispose-me'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })

    bridge.dispose()

    await rejected
    expect(cancellations).toEqual([expect.objectContaining({ requestId: 'dispose-me' })])
  })
})

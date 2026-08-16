import { describe, expect, it } from 'vitest'
import { buildReplayScript } from '../src/main/browser-view-manager'

describe('Browser semantic replay', () => {
  it('resolves targets by role/name/ordinal and checks page identity', () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-1',
      url: 'https://example.test/path',
      steps: [{ method: 'click', url: 'https://example.test/path', target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 }, args: [] }]
    })
    expect(script).toContain('pageIdentity.url')
    expect(script).toContain('node.role === expected.role')
    expect(script).toContain('Replay target changed')
    expect(script).not.toContain('Input.dispatchMouseEvent')
  })

  it('keeps blocked sensitive steps blocked instead of embedding their value', () => {
    const script = buildReplayScript({
      schema: 'agentmux.browser-replay.v1',
      operationId: 'op-2',
      url: 'https://example.test/',
      steps: [{ method: 'fillInput', url: 'https://example.test/', args: ['@e1', 'secret-value'], blockedReason: 'Sensitive input is requested again at replay time.' }]
    })
    expect(script).toContain('Sensitive input is requested again')
    expect(script).not.toContain('secret-value')
  })
})

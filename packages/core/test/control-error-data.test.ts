import { describe, expect, it } from 'vitest'
import { parseAgentMuxControlReceipt } from '../src/control-host.js'

const cause = { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', message: 'Original input outcome.', detail: '{"ready":true,"retry":true}',
  controlFailure: { disposition: 'unknown' as const, confirmedInputBytes: null }, logId: 'delivery-11111111-1111-4111-8111-111111111111' }
const receipt = (error: unknown) => ({ schemaVersion: 5, requestId: 'original-operation', operation: 'send', ok: false, error })

describe('Original Control failure data', () => {
  it('preserves unknown, a confirmed prefix and opaque diagnostics in the finite outer error union', () => {
    for (const confirmedInputBytes of [null, 0, 3]) {
      const original = { ...cause, controlFailure: { disposition: 'unknown', confirmedInputBytes } }
      const value = receipt({ code: 'CONTROL_FAILED', message: 'Original Control error.', cause: original, controlFailure: original.controlFailure })
      expect(parseAgentMuxControlReceipt(value)).toEqual(value)
    }
  })

  it('refuses accessors without executing them, including nested confirmation facts', () => {
    let reads = 0
    const accessorCause = { ...cause }
    Object.defineProperty(accessorCause, 'code', { enumerable: true, get: () => { reads++; return cause.code } })
    const accessorFailure = { ...cause.controlFailure }
    Object.defineProperty(accessorFailure, 'confirmedInputBytes', { enumerable: true, get: () => { reads++; return 0 } })
    for (const original of [accessorCause, { ...cause, controlFailure: accessorFailure }]) {
      expect(() => parseAgentMuxControlReceipt(receipt({ code: 'CONTROL_FAILED', message: 'Control error.', cause: original })))
        .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
    expect(reads).toBe(0)
  })

  it('does not turn candidate facts or an arbitrary graph into an original Core input error', () => {
    const candidates = [{ agentSessionId: 'original-recipient', regionIds: ['original-region'] }]
    for (const error of [
      { code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Candidates.', candidates, cause },
      { code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Candidates.', candidates, controlFailure: cause.controlFailure },
      { code: 'CONTROL_FAILED', message: 'Input.', candidates, cause },
      { code: 'CONTROL_FAILED', message: 'Input.', cause: { ...cause, code: 'MESSAGE_TARGET_NOT_UNIQUE' } },
      { code: 'CONTROL_FAILED', message: 'Input.', cause: { ...cause, stack: 'Unbounded graph.' } },
      { code: 'CONTROL_FAILED', message: 'Input.', cause: Object.assign(Object.create({ ready: true }), cause) },
      { code: 'CONTROL_FAILED', message: 'Input.', cause, controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }
    ]) expect(() => parseAgentMuxControlReceipt(receipt(error))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const value = receipt({ code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Candidates.', candidates })
    expect(parseAgentMuxControlReceipt(value)).toEqual(value)
  })
})

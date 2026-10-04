import { describe, expect, it } from 'vitest'
import { codexFailure } from '../src/providers/codex-errors.js'

const turn = 'native-turn-7'
const message = 'Selected model is at capacity. Please try a different model.'
const genericRecovery = 'Inspect the native Provider error before explicitly retrying.'

describe('Codex native error classification', () => {
  it.each([
    { codex_error_info: 'server_overloaded' },
    { codexErrorInfo: 'serverOverloaded' },
    { codex_error_info: { serverOverloaded: {} } }
  ])('keeps capacity diagnostics and native identity without inventing an HTTP status: %j', fields => {
    const result = codexFailure({ ...fields, message }, turn)
    expect(result).toEqual({ code: 'AGENT_MODEL_OVERLOADED', message,
      recovery: 'Wait before retrying, or choose another model.', nativeTurnId: turn,
      nativeCode: 'codex_error_info' in fields && typeof fields.codex_error_info === 'string'
        ? 'server_overloaded' : 'serverOverloaded' })
    expect(result).not.toHaveProperty('httpStatusCode')
  })

  it.each([
    ['rate_limit_exceeded', 'AGENT_RATE_LIMITED', 'Wait for the reported reset or retry delay before retrying.'],
    ['credit_balance_exhausted', 'AGENT_CREDIT_LIMIT', 'Restore the account credit balance before retrying.'],
    ['project_spend_limit_exceeded', 'AGENT_SPEND_LIMIT', 'Review the project spending limit before retrying.'],
    ['insufficient_quota', 'AGENT_USAGE_LIMIT', 'Review the reported account credits and usage limits before retrying.'],
    ['context_window_exceeded', 'AGENT_CONTEXT_LIMIT', 'Reduce or compact the conversation context before retrying.'],
    ['session_budget_exceeded', 'AGENT_SESSION_BUDGET', 'Review the Session budget before continuing.'],
    ['unauthorized', 'AGENT_AUTHENTICATION_FAILED', 'Check the Provider login or credentials before retrying.'],
    ['sandbox_error', 'AGENT_SANDBOX_FAILED', 'Review the sandbox error and configuration before retrying.'],
    ['cyber_policy', 'AGENT_POLICY_REJECTED', 'Review the Provider policy explanation and request.'],
    ['response_stream_disconnected', 'AGENT_STREAM_INTERRUPTED', 'Check the existing response before explicitly retrying.'],
    ['response_too_many_failed_attempts', 'AGENT_RETRIES_EXHAUSTED', 'Check the connection and Provider error before explicitly retrying.'],
    ['active_turn_not_steerable', 'AGENT_TURN_NOT_STEERABLE', 'Wait for the current turn or explicitly interrupt it before submitting.']
  ])('classifies the structured native %s cause with its specific recovery action', (nativeCode, code, recovery) => {
    expect(codexFailure({ message: 'Original native diagnostic', codex_error_info: { [nativeCode]: {} } }, turn))
      .toEqual({ code, recovery, nativeCode, message: 'Original native diagnostic', nativeTurnId: turn })
  })

  it.each(['new_provider_error', 'constructor', '__proto__'])('keeps unknown native code %s diagnostic without treating a prototype key as a classification', nativeCode => {
    for (const codex_error_info of [nativeCode, JSON.parse(`{"${nativeCode}":{"http_status_code":503}}`) as unknown]) {
      const result = codexFailure({ message: 'Original unknown error', codex_error_info }, turn)
      expect(result).toMatchObject({ code: 'AGENT_PROVIDER_ERROR', recovery: genericRecovery,
        message: 'Original unknown error', nativeTurnId: turn, nativeCode })
      // A real forwarded status remains diagnostic evidence. It cannot turn an unknown native cause into overload.
      if (typeof codex_error_info === 'string') expect(result).not.toHaveProperty('httpStatusCode')
      else expect(result.httpStatusCode).toBe(503)
    }
  })

  it.each([
    [401, 'AGENT_AUTHENTICATION_FAILED', 'Check the Provider login or credentials before retrying.'],
    [429, 'AGENT_REQUEST_LIMIT', 'Check the native error for rate, credit or usage limits before retrying.'],
    [503, 'AGENT_PROVIDER_UNAVAILABLE', 'Wait for the reported retry delay before retrying.']
  ])('refines a forwarded connection HTTP %i without inventing a native service cause', (httpStatusCode, code, recovery) => {
    expect(codexFailure({ message: 'Original upstream response', codex_error_info: {
      http_connection_failed: { http_status_code: httpStatusCode }
    } }, turn)).toEqual({ code, recovery, message: 'Original upstream response', nativeTurnId: turn,
      nativeCode: 'http_connection_failed', httpStatusCode })
    expect(codexFailure({ message: 'Original upstream response', codexErrorInfo: {
      responseStreamConnectionFailed: { httpStatusCode }
    } }, turn)).toEqual({ code, recovery, message: 'Original upstream response', nativeTurnId: turn,
      nativeCode: 'responseStreamConnectionFailed', httpStatusCode })
  })

  it('keeps an HTTP-only 429 limit ambiguous and preserves explicit billing causes instead of calling them rate limiting', () => {
    expect(codexFailure({ message: 'An upstream limit was reached', http_status_code: 429 }, turn)).toEqual({
      code: 'AGENT_REQUEST_LIMIT', recovery: 'Check the native error for rate, credit or usage limits before retrying.',
      message: 'An upstream limit was reached', nativeTurnId: turn, httpStatusCode: 429
    })
    expect(codexFailure({ message: 'Credits exhausted', codex_error_info: 'credit_balance_exhausted', http_status_code: 429 }, turn))
      .toEqual({ code: 'AGENT_CREDIT_LIMIT', recovery: 'Restore the account credit balance before retrying.',
        message: 'Credits exhausted', nativeTurnId: turn, nativeCode: 'credit_balance_exhausted', httpStatusCode: 429 })
    expect(codexFailure({ message: 'Usage quota reached', codex_error_info: 'insufficient_quota', http_status_code: 429 }, turn))
      .toEqual({ code: 'AGENT_USAGE_LIMIT', recovery: 'Review the reported account credits and usage limits before retrying.',
        message: 'Usage quota reached', nativeTurnId: turn, nativeCode: 'insufficient_quota', httpStatusCode: 429 })
  })

  it.each(['503', 99, 600, 503.5, null])('does not accept malformed or out-of-range forwarded HTTP evidence %j', httpStatusCode => {
    const result = codexFailure({ message: 'Connection failed', codex_error_info: {
      http_connection_failed: { http_status_code: httpStatusCode }
    } }, turn)
    expect(result).toEqual({ code: 'AGENT_CONNECTION_FAILED', recovery: 'Check the connection and Provider service before retrying.',
      message: 'Connection failed', nativeTurnId: turn, nativeCode: 'http_connection_failed' })
    expect(result).not.toHaveProperty('httpStatusCode')
  })

  it('does not classify model capacity or an HTTP number found only in ordinary diagnostic text', () => {
    expect(codexFailure({ message: 'Selected model is at capacity. HTTP 503 may be involved.' }, turn)).toEqual({
      code: 'AGENT_PROVIDER_ERROR', recovery: genericRecovery,
      message: 'Selected model is at capacity. HTTP 503 may be involved.', nativeTurnId: turn
    })
    expect(codexFailure({ code: 'future_native_code', message }, turn)).toEqual({
      code: 'AGENT_PROVIDER_ERROR', recovery: genericRecovery, message, nativeTurnId: turn, nativeCode: 'future_native_code'
    })
  })

  it.each([undefined, null, '', ' \n ', 42])('uses an honest missing-diagnostic message while retaining a known cause: %j', missingMessage => {
    expect(codexFailure({ message: missingMessage, codex_error_info: 'server_overloaded' }, turn)).toEqual({
      code: 'AGENT_MODEL_OVERLOADED', recovery: 'Wait before retrying, or choose another model.',
      message: 'The native turn failed without a diagnostic message.', nativeTurnId: turn, nativeCode: 'server_overloaded'
    })
  })

  it.each([undefined, null, [], 'capacity', 429])('keeps unsupported error payloads diagnostic and preserves the original turn: %j', value => {
    expect(codexFailure(value, turn)).toEqual({ code: 'AGENT_PROVIDER_ERROR', recovery: genericRecovery,
      message: 'The native turn failed without a diagnostic message.', nativeTurnId: turn })
  })
})

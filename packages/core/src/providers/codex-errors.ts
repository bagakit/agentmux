import type { AgentFailure } from '../types.js'

const classifications: Record<string, [string, string]> = {
  server_overloaded: ['AGENT_MODEL_OVERLOADED', 'Wait before retrying, or choose another model.'],
  server_is_overloaded: ['AGENT_MODEL_OVERLOADED', 'Wait for the reported retry delay, or choose another model.'],
  slow_down: ['AGENT_RATE_LIMITED', 'Follow the reported retry delay and increase the request rate gradually.'],
  credit_balance_exhausted: ['AGENT_CREDIT_LIMIT', 'Restore the account credit balance before retrying.'],
  organization_spend_limit_exceeded: ['AGENT_SPEND_LIMIT', 'Review the organization spending limit before retrying.'],
  project_spend_limit_exceeded: ['AGENT_SPEND_LIMIT', 'Review the project spending limit before retrying.'],
  organization_usage_limit_exceeded: ['AGENT_USAGE_LIMIT', 'Review the organization usage limit before retrying.'],
  insufficient_quota: ['AGENT_USAGE_LIMIT', 'Review the reported account credits and usage limits before retrying.'],
  flex_unavailable: ['AGENT_MODEL_UNAVAILABLE', 'Wait before retrying, or choose another available service tier.'],
  rate_limit_exceeded: ['AGENT_RATE_LIMITED', 'Wait for the reported reset or retry delay before retrying.'],
  usage_limit_exceeded: ['AGENT_USAGE_LIMIT', 'Check account usage and its reset time or available credits.'],
  session_budget_exceeded: ['AGENT_SESSION_BUDGET', 'Review the Session budget before continuing.'],
  context_window_exceeded: ['AGENT_CONTEXT_LIMIT', 'Reduce or compact the conversation context before retrying.'],
  unauthorized: ['AGENT_AUTHENTICATION_FAILED', 'Check the Provider login or credentials before retrying.'],
  bad_request: ['AGENT_INVALID_REQUEST', 'Review the request and Provider configuration before retrying.'],
  internal_server_error: ['AGENT_PROVIDER_INTERNAL_ERROR', 'Wait before retrying; check the Provider service if it persists.'],
  http_connection_failed: ['AGENT_CONNECTION_FAILED', 'Check the connection and Provider service before retrying.'],
  response_stream_connection_failed: ['AGENT_CONNECTION_FAILED', 'Check the connection and Provider service before retrying.'],
  response_stream_disconnected: ['AGENT_STREAM_INTERRUPTED', 'Check the existing response before explicitly retrying.'],
  response_too_many_failed_attempts: ['AGENT_RETRIES_EXHAUSTED', 'Check the connection and Provider error before explicitly retrying.'],
  cyber_policy: ['AGENT_POLICY_REJECTED', 'Review the Provider policy explanation and request.'],
  misalignment_policy_violation: ['AGENT_POLICY_REJECTED', 'Review the Provider policy explanation and request.'],
  too_many_denials: ['AGENT_PERMISSION_DENIED', 'Review the denied permissions before continuing.'],
  sandbox_error: ['AGENT_SANDBOX_FAILED', 'Review the sandbox error and configuration before retrying.'],
  thread_rollback_failed: ['AGENT_CONVERSATION_OPERATION_FAILED', 'Inspect the original conversation before retrying this operation.'],
  active_turn_not_steerable: ['AGENT_TURN_NOT_STEERABLE', 'Wait for the current turn or explicitly interrupt it before submitting.']
}

/** Only native error fields are classified; neither messages nor HTTP codes are guessed. */
export function codexFailure(value: unknown, nativeTurnId: string): AgentFailure {
  const error = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const info = error.codex_error_info ?? error.codexErrorInfo
  const nativeCode = typeof info === 'string' ? info : info && typeof info === 'object' && !Array.isArray(info)
    ? Object.keys(info)[0] : typeof error.code === 'string' ? error.code : undefined
  const canonical = nativeCode?.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)
  const nested = nativeCode && info && typeof info === 'object' ? (info as Record<string, unknown>)[nativeCode] : undefined
  const details = nested && typeof nested === 'object' ? nested as Record<string, unknown> : error
  const httpStatus = details.http_status_code ?? details.httpStatusCode
  const httpStatusCode = Number.isInteger(httpStatus) && Number(httpStatus) >= 100 && Number(httpStatus) <= 599 ? Number(httpStatus) : undefined
  // A forwarded status can refine a generic connection error, but cannot invent a native code.
  const httpClassification: Record<number, [string, string]> = {
    400: classifications.bad_request!, 401: classifications.unauthorized!,
    403: ['AGENT_PERMISSION_DENIED', 'Check the Provider permissions, account and region restrictions.'],
    429: ['AGENT_REQUEST_LIMIT', 'Check the native error for rate, credit or usage limits before retrying.'],
    500: classifications.internal_server_error!,
    503: ['AGENT_PROVIDER_UNAVAILABLE', 'Wait for the reported retry delay before retrying.']
  }
  const nativeClassification = canonical && Object.hasOwn(classifications, canonical) ? classifications[canonical] : undefined
  const transport = canonical === 'http_connection_failed' || canonical === 'response_stream_connection_failed'
  const [code, recovery] = (transport && httpStatusCode ? httpClassification[httpStatusCode] : undefined) ??
    nativeClassification ?? (!nativeCode && httpStatusCode ? httpClassification[httpStatusCode] : undefined) ??
    ['AGENT_PROVIDER_ERROR', 'Inspect the native Provider error before explicitly retrying.']
  return { code, recovery, nativeTurnId,
    message: typeof error.message === 'string' && error.message.trim() ? error.message : 'The native turn failed without a diagnostic message.',
    ...(nativeCode ? { nativeCode } : {}), ...(httpStatusCode === undefined ? {} : { httpStatusCode }) }
}

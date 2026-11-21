import { isDeepStrictEqual } from 'node:util'
import type { AgentProvider } from '../agent-provider.js'
import type { AgentInformationIssue, AgentInformationLimit, AgentInformationSnapshot } from '../agent-information.js'
import { connectCodexSessionControl } from './codex-session-control.js'

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const issue = (field: AgentInformationIssue['field'], kind: AgentInformationIssue['kind'], code: string, message: string): AgentInformationIssue =>
  ({ field, kind, code, message })

/** Both native views are one response: the detailed map supersedes its single-bucket projection. */
function rateWindows(value: unknown): AgentInformationLimit[] {
  if (!record(value)) throw new Error('Malformed native limits')
  const mapped = value.rateLimitsByLimitId
  if (mapped !== null && mapped !== undefined && !record(mapped)) throw new Error('Malformed native limit buckets')
  const buckets = record(mapped) ? Object.entries(mapped) : record(value.rateLimits) ? [[value.rateLimits.limitId, value.rateLimits]] : []
  const rows: AgentInformationLimit[] = []
  for (const [key, bucket] of buckets) {
    if (!text(key) || !record(bucket) || bucket.limitId !== null && bucket.limitId !== undefined && bucket.limitId !== key ||
        bucket.limitName !== null && bucket.limitName !== undefined && !text(bucket.limitName)) throw new Error('Malformed native limit identity')
    for (const windowId of ['primary', 'secondary'] as const) {
      const window = bucket[windowId]
      if (window == null) continue
      if (!record(window) || !number(window.usedPercent) ||
          window.windowDurationMins != null && !number(window.windowDurationMins) ||
          window.resetsAt != null && (!number(window.resetsAt) || !Number.isSafeInteger(window.resetsAt * 1000))) throw new Error('Malformed native limit window')
      const duration = window.windowDurationMins
      rows.push({ id: key + ':' + windowId, name: String(bucket.limitName ?? key) + ' · ' + (number(duration) ? duration + ' min' : windowId),
        usedPercent: window.usedPercent, ...(number(duration) ? { windowMinutes: duration } : {}),
        ...(number(window.resetsAt) ? { resetsAt: window.resetsAt * 1000 } : {}) })
    }
  }
  return rows
}

export const readCodexInformation: NonNullable<AgentProvider['readInformation']> = async (context, nativeSessionId) => {
  const connection = await connectCodexSessionControl(context, nativeSessionId)
  try {
    const issues: AgentInformationIssue[] = []
    const [accountRead, limitsRead] = await Promise.allSettled([
      connection.request('account/read', { refreshToken: false }),
      connection.request('account/rateLimits/read', { excludeResetCreditDetails: true })
    ])
    let plan: AgentInformationSnapshot['plan'], limits: AgentInformationSnapshot['limits']
    if (accountRead.status === 'fulfilled' && record(accountRead.value)) {
      const account = accountRead.value.account
      if (record(account) && account.type === 'chatgpt' && text(account.planType) && account.planType !== 'unknown') {
        plan = { id: account.planType, name: account.planType }
      } else issues.push(issue('plan', record(account) && text(account.type) && account.type !== 'chatgpt' ? 'unsupported' : 'unconfirmed',
        'AGENT_NATIVE_PLAN_UNAVAILABLE', 'The original native account has no confirmed subscription plan.'))
    } else issues.push(issue('plan', 'unavailable', 'AGENT_NATIVE_ACCOUNT_READ_FAILED', 'Reading the original native account failed.'))
    if (limitsRead.status === 'fulfilled') {
      try {
        limits = rateWindows(limitsRead.value)
        if (!limits.length) issues.push(issue('limits', 'unconfirmed', 'AGENT_NATIVE_LIMITS_UNCONFIRMED', 'The original native account has no reported limit windows.'))
      } catch { issues.push(issue('limits', 'unavailable', 'AGENT_NATIVE_LIMITS_INVALID', 'The original native limit response is unconfirmed.')) }
    } else issues.push(issue('limits', 'unavailable', 'AGENT_NATIVE_LIMITS_READ_FAILED', 'Reading the original native limits failed.'))
    // An account switch during this read must not relabel the previous account's quota.
    // Compare the original native account object privately; identity/email never enter the public DTO.
    if (accountRead.status === 'fulfilled') {
      let sameAccount = false
      try { sameAccount = isDeepStrictEqual(await connection.request('account/read', { refreshToken: false }), accountRead.value) } catch { /* This diagnosis does not revoke the Session's model channel. */ }
      if (!sameAccount) {
        plan = undefined; limits = undefined
        issues.push(issue('plan', 'unconfirmed', 'AGENT_NATIVE_ACCOUNT_CHANGED', 'The original native account changed during this read.'),
          issue('limits', 'unconfirmed', 'AGENT_NATIVE_ACCOUNT_CHANGED', 'The original native account limits could not be attributed after the account changed.'))
      }
    }
    const thread = await connection.assertCurrent()
    const model = text(thread.model) ? { id: thread.model, scope: 'next-turn' as const } : undefined
    if (!model) issues.push(issue('model', 'unconfirmed', 'AGENT_NATIVE_MODEL_UNCONFIRMED', 'The loaded original native thread has no confirmed model selection.'))
    return { nativeSessionId, sourceId: connection.sourceId, observedAt: Date.now(),
      ...(model ? { model } : {}), ...(plan ? { plan } : {}), ...(limits ? { limits } : {}), issues }
  } finally { connection.dispose() }
}

import { parseMotePreferencesTarget, parseMoteQuickDefaults, parseMoteQuickBaseline, parseMotePreferencesSaveParams,
  parseMotePreferencesSaveResult, sameMotePreferencesTarget, type MotePreferencesTarget, type MoteQuickDefaults,
  type MoteQuickBaseline, type MotePreferencesSaveParams, type MotePreferencesSaveResult } from '@agentmux/core/mote-preferences'
import { isLocalNetworkHost } from '@agentmux/relay/offer'

export type MoteQuickScope = { origin: string; runtimeId: string; deviceHostId: string | null; target: MotePreferencesTarget }
export type MoteQuickAttempt = { input: MotePreferencesSaveParams; ownerInstanceId: string; phase: 'sending' | 'unknown' | 'saved' | 'failed'; result: MotePreferencesSaveResult | null; issue: string | null }
export type MoteQuickDraft = { scope: MoteQuickScope; values: MoteQuickDefaults; baseline: MoteQuickBaseline | null;
  attempts: MoteQuickAttempt[]; blockedAttemptId: string | null }
export type MoteQuickDraftCommit = { recordId: string | null; applied: boolean; draft: MoteQuickDraft | null; conflict: MoteQuickDraft | null }
export class MoteQuickDraftInvalidError extends Error {}
export class MoteQuickDraftCapacityError extends MoteQuickDraftInvalidError {}
function invalid(): never { throw new MoteQuickDraftInvalidError('原 Quick 配置、完整请求或归属无法核实；当前选择与原请求保留。') }
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function parseMoteQuickScope(value: unknown): MoteQuickScope {
  const v = object(value, ['origin', 'runtimeId', 'deviceHostId', 'target'])
  if (!identity(v.origin) || !identity(v.runtimeId) || !(v.deviceHostId === null || identity(v.deviceHostId))) invalid()
  try {
    const url = new URL(v.origin as string)
    if (url.origin !== v.origin || url.username || url.password || url.pathname !== '/' || url.hash || url.search ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname))) invalid()
    parseMotePreferencesTarget(v.target)
  } catch { invalid() }
  return structuredClone(value) as MoteQuickScope
}
export function moteQuickDraftKey(scope: MoteQuickScope): string {
  const t = scope.target, r = t.expectedResource
  return JSON.stringify([scope.origin, scope.runtimeId, scope.deviceHostId, t.spaceId, t.zoneId, r.hostId, r.workspaceId, r.workspacePath])
}
export function parseMoteQuickDraft(value: unknown): MoteQuickDraft {
  const v = object(value, ['scope', 'values', 'baseline', 'attempts', 'blockedAttemptId']), scope = parseMoteQuickScope(v.scope)
  try {
    parseMoteQuickDefaults(v.values)
    if (v.baseline !== null) parseMoteQuickBaseline(v.baseline, scope.target)
    if (!Array.isArray(v.attempts)) invalid()
    const ids = new Set<string>()
    for (const value of v.attempts as unknown[]) {
      const a = object(value, ['input', 'ownerInstanceId', 'phase', 'result', 'issue']), input = parseMotePreferencesSaveParams(a.input)
      if (!sameMotePreferencesTarget(input.target, scope.target) || !identity(a.ownerInstanceId) || ids.has(input.operationId) ||
        !['sending', 'unknown', 'saved', 'failed'].includes(String(a.phase)) || !(a.issue === null || typeof a.issue === 'string')) invalid()
      if (a.result !== null) parseMotePreferencesSaveResult(a.result, input)
      if (a.phase === 'saved' && (!a.result || !['saved', 'unchanged'].includes((a.result as MotePreferencesSaveResult).status))) invalid()
      if (a.phase === 'failed' && (!a.result || (a.result as MotePreferencesSaveResult).status !== 'refused-before-write')) invalid()
      ids.add(input.operationId)
    }
    if (!(v.blockedAttemptId === null || typeof v.blockedAttemptId === 'string' && (v.attempts as MoteQuickAttempt[]).some(a =>
      a.input.operationId === v.blockedAttemptId && (a.phase === 'sending' || a.phase === 'unknown')))) invalid()
  } catch { invalid() }
  return structuredClone(value) as MoteQuickDraft
}
export function parseMoteQuickDrafts(value: unknown, conflicts = false): MoteQuickDraft[] {
  if (!Array.isArray(value)) invalid()
  const drafts = (value as unknown[]).map(parseMoteQuickDraft)
  if (!conflicts && new Set(drafts.map(d => moteQuickDraftKey(d.scope))).size !== drafts.length) invalid()
  return drafts
}

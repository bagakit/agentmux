import type { AgentMuxRpcParams } from '@agentmux/core'
import { AGENTMUX_DEMAND_PRIORITIES, AGENTMUX_DEMAND_STATUSES } from '@agentmux/core/control'
import { isLocalNetworkHost } from '@agentmux/relay/offer'

/** Text and exact requests only. Goal facts remain with the original Host. */
export type MobileGoalDraftScope = { origin: string; runtimeId: string; deviceHostId: string | null }
export type MobileGoalPatch = Pick<AgentMuxRpcParams<'goal.update'>['patch'], 'title' | 'description' | 'status' | 'priority'>
export type MobileGoalUpdateRequest = {
  goalId: string; operationId: string; expectedUpdatedAt: number; patch: MobileGoalPatch
}
export type MobileGoalEditOperation = {
  request: MobileGoalUpdateRequest; ownerInstanceId: string; phase: 'sending' | 'unknown'; issue: string | null
}
export type MobileGoalDraft = {
  goalId: string; scope: MobileGoalDraftScope; title: string; description: string
  baseline: { title: string; description: string; updatedAt: number }; operations: MobileGoalEditOperation[]
}
export class MobileGoalDraftInvalidError extends Error {}
export type MobileGoalDraftCommit = { recordId: string | null; applied: boolean; draft: MobileGoalDraft | null; conflict: MobileGoalDraft | null }
const MAX_ENTRIES = 256
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
function invalid(): never { throw new MobileGoalDraftInvalidError('原目标草稿或请求无法完整核实；原字节与当前正文保留。') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
function text(value: unknown): value is string { return typeof value === 'string' && bytes(value) <= 65536 }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname))
      && url.origin === value && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { return false }
}
export function parseMobileGoalDraftScope(value: unknown): MobileGoalDraftScope {
  const v = object(value, ['origin', 'runtimeId', 'deviceHostId'])
  if (!origin(v.origin) || !id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId))) invalid()
  return structuredClone(value) as MobileGoalDraftScope
}
export function sameMobileGoalDraftScope(a: MobileGoalDraftScope, b: MobileGoalDraftScope): boolean {
  return a.origin === b.origin && a.runtimeId === b.runtimeId && a.deviceHostId === b.deviceHostId
}
export function mobileGoalDraftKey(goalId: string, scope: MobileGoalDraftScope): string {
  return JSON.stringify([scope.origin, scope.runtimeId, scope.deviceHostId, goalId])
}
export function parseMobileGoalUpdateRequest(value: unknown): MobileGoalUpdateRequest {
  const v = object(value, ['goalId', 'operationId', 'expectedUpdatedAt', 'patch'])
  if (!id(v.goalId) || !id(v.operationId) || !timestamp(v.expectedUpdatedAt)) invalid()
  if (!v.patch || typeof v.patch !== 'object' || Array.isArray(v.patch)) invalid()
  const patch = v.patch as Record<string, unknown>, keys = Object.keys(patch)
  if (!keys.length || keys.some(key => !['title', 'description', 'status', 'priority'].includes(key))) invalid()
  if (Object.hasOwn(patch, 'title') && (!text(patch.title) || !patch.title)
    || Object.hasOwn(patch, 'description') && !text(patch.description)
    || Object.hasOwn(patch, 'status') && !AGENTMUX_DEMAND_STATUSES.includes(patch.status as never)
    || Object.hasOwn(patch, 'priority') && !AGENTMUX_DEMAND_PRIORITIES.includes(patch.priority as never)) invalid()
  return structuredClone(value) as MobileGoalUpdateRequest
}
export function freezeMobileGoalUpdateRequest(value: unknown): MobileGoalUpdateRequest {
  const request = parseMobileGoalUpdateRequest(value)
  Object.freeze(request.patch)
  return Object.freeze(request)
}
export function parseMobileGoalDraft(value: unknown): MobileGoalDraft {
  const v = object(value, ['goalId', 'scope', 'title', 'description', 'baseline', 'operations'])
  if (!id(v.goalId) || !text(v.title) || !text(v.description)) invalid()
  parseMobileGoalDraftScope(v.scope)
  const base = object(v.baseline, ['title', 'description', 'updatedAt'])
  if (!text(base.title) || !text(base.description) || !timestamp(base.updatedAt)) invalid()
  if (!Array.isArray(v.operations) || v.operations.length > MAX_ENTRIES) invalid()
  const ids = new Set<string>()
  for (const value of v.operations) {
    const op = object(value, ['request', 'ownerInstanceId', 'phase', 'issue'])
    const request = parseMobileGoalUpdateRequest(op.request)
    if (request.goalId !== v.goalId || ids.has(request.operationId) || !id(op.ownerInstanceId)
      || !['sending', 'unknown'].includes(String(op.phase))
      || !(op.issue === null || text(op.issue))) invalid()
    ids.add(request.operationId)
  }
  return structuredClone(value) as MobileGoalDraft
}
export function parseMobileGoalDrafts(value: unknown): MobileGoalDraft[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid()
  const drafts = value.map(parseMobileGoalDraft), found = new Set<string>()
  for (const draft of drafts) {
    const key = mobileGoalDraftKey(draft.goalId, draft.scope)
    if (found.has(key)) invalid()
    found.add(key)
  }
  return drafts
}
/** Conflict copies retain the other page's complete text and original requests. */
export function parseMobileGoalDraftConflicts(value: unknown): MobileGoalDraft[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid()
  const drafts = value.map(parseMobileGoalDraft), found = new Set<string>()
  for (const draft of drafts) {
    const key = JSON.stringify(draft)
    if (found.has(key)) invalid()
    found.add(key)
  }
  return drafts
}

import { parseNodePublishingResult, type NodeSettings, type NodePublishingPolicy } from '@agentmux/core/node-publishing'

/** User input and its original CAS context, never a second Node policy owner. */
export type NodePublicationDraft = {
  baseline: Pick<NodeSettings, 'node' | 'policyRevision' | 'policy'>
  draft: NodePublishingPolicy
  pending?: { operationId: string; expectedRevision: string; submitted: NodePublishingPolicy; phase: 'in-flight' | 'unknown' }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const unreadable = (): never => { throw new Error('The saved Node publication edit is unreadable. Its original record is kept; current Node observation and healthy Agents remain available.') }

/** Unknown entries remain opaque in the existing user document until their own consumer reads them. */
export function nodePublicationDraftRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!record(value)) return unreadable()
  return value
}

function policyDraft(value: unknown): NodePublishingPolicy {
  if (!record(value) || typeof value.alias !== 'string' || typeof value.shareResources !== 'boolean' ||
      !Array.isArray(value.allowedPaths) || !value.allowedPaths.every(path => typeof path === 'string') ||
      !Array.isArray(value.deniedPaths) || !value.deniedPaths.every(path => typeof path === 'string') ||
      (value.defaultPath !== null && typeof value.defaultPath !== 'string')) return unreadable()
  // Drafts may be temporarily invalid and paths are literal, including trailing spaces.
  return { alias: value.alias, shareResources: value.shareResources, allowedPaths: value.allowedPaths,
    deniedPaths: value.deniedPaths, defaultPath: value.defaultPath }
}

export function nodePublicationDraftForRuntime(value: unknown, runtimeId: string): NodePublicationDraft | undefined {
  const entry = nodePublicationDraftRecord(value)[runtimeId]
  if (entry === undefined) return undefined
  if (!record(entry) || !record(entry.baseline)) return unreadable()
  let saved: NodeSettings
  try { saved = parseNodePublishingResult('settings.node.inspect', { ...entry.baseline, operation: null }, {}) }
  catch { return unreadable() }
  if (saved.node.runtimeId !== runtimeId) return unreadable()
  const baseline = { node: saved.node, policyRevision: saved.policyRevision, policy: saved.policy }, draft = policyDraft(entry.draft)
  if (entry.pending === undefined) return { baseline, draft }
  const pending = entry.pending
  if (!record(pending) || typeof pending.operationId !== 'string' || !pending.operationId ||
      typeof pending.expectedRevision !== 'string' || !pending.expectedRevision ||
      (pending.phase !== 'in-flight' && pending.phase !== 'unknown')) return unreadable()
  return { baseline, draft, pending: { operationId: pending.operationId, expectedRevision: pending.expectedRevision, submitted: policyDraft(pending.submitted), phase: pending.phase } }
}

/** A new Renderer cannot claim the former process still owns a live request. It only inspects it. */
export function restoredNodePublicationDrafts(value: unknown): unknown {
  if (!record(value)) return value
  let result: Record<string, unknown> | undefined
  for (const runtimeId of Object.keys(value)) {
    try {
      const entry = nodePublicationDraftForRuntime(value, runtimeId)
      if (entry?.pending?.phase === 'in-flight') {
        result ??= { ...value }
        result[runtimeId] = { ...entry, pending: { ...entry.pending, phase: 'unknown' } }
      }
    } catch { /* Preserve the exact opaque record; its own consumer explains the read gap. */ }
  }
  return result ?? value
}

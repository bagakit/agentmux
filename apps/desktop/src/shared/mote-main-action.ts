import { parseMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
/** Caller intent and its original creation pointer. Session, role and delivery facts stay with Core. */
export type MoteMainCreationReference = { target: MotePreferencesTarget; operationId: string;
  deferredInput?: { operationId: string; prompt: string } | undefined }
export function restoredMoteMainCreationReferences(value: unknown): Record<string, MoteMainCreationReference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    try {
      const reference = raw as MoteMainCreationReference, target = parseMotePreferencesTarget(reference.target)
      if (key !== JSON.stringify(target) || typeof reference.operationId !== 'string' || !reference.operationId || /[\0\r\n]/u.test(reference.operationId)) return []
      const query = reference.deferredInput
      // An unreadable optional body cannot revoke the already known creation
      // pointer. Its original Core operation remains independently inspectable.
      const readable = query && typeof query === 'object' && typeof query.operationId === 'string' && query.operationId.trim() &&
        !/[\0\r\n]/u.test(query.operationId) && typeof query.prompt === 'string' && query.prompt.trim()
      return [[key, { target, operationId: reference.operationId,
        ...(readable ? { deferredInput: { operationId: query.operationId, prompt: query.prompt } } : {}) }]]
    } catch { return [] }
  }))
}

import { parseMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
/** Durable pointer to the original creation admission, not a Session/role/outcome journal. */
export type MoteMainCreationReference = { target: MotePreferencesTarget; operationId: string }
export function restoredMoteMainCreationReferences(value: unknown): Record<string, MoteMainCreationReference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    try {
      const reference = raw as MoteMainCreationReference, target = parseMotePreferencesTarget(reference.target)
      if (key !== JSON.stringify(target) || typeof reference.operationId !== 'string' || !reference.operationId || /[\0\r\n]/u.test(reference.operationId)) return []
      return [[key, { target, operationId: reference.operationId }]]
    } catch { return [] }
  }))
}

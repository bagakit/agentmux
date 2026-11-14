import type { FocusTopicPresentation } from './focus-preferences'

/** Personal display choices address original containers, never a disposable scan lane. */
export type FocusZonePresentation = { key: string; presentation: FocusTopicPresentation }
export function focusZoneContainerKey(kind: 'project' | 'collection', hostId: string, id: string): string {
  return JSON.stringify([kind, hostId, id])
}
export function parseFocusZonePresentations(value: unknown): FocusZonePresentation[] {
  if (!Array.isArray(value)) throw Error('Focus Zone presentations must be a JSON array.')
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'key,presentation'
      || typeof item.key !== 'string' || !['cards', 'sections'].includes(item.presentation)) {
      throw Error('Each Focus Zone presentation needs an exact container key and cards or sections.')
    }
    let identity: unknown
    try { identity = JSON.parse(item.key) } catch { /* Invalid authored identity is reported below. */ }
    if (!Array.isArray(identity) || identity.length !== 3 || !['project', 'collection'].includes(identity[0])
      || !identity.slice(1).every(part => typeof part === 'string' && part.length > 0)
      || JSON.stringify(identity) !== item.key || seen.has(item.key)) {
      throw Error('Focus Zone presentation keys must be unique original [project or collection, Host, ID] identities.')
    }
    seen.add(item.key)
    return { key: item.key, presentation: item.presentation }
  })
}

export function focusZonePresentation(key: string | null, kind: 'project' | 'collection',
  preferences: readonly FocusZonePresentation[] | undefined, authoredTopicPresentation?: FocusTopicPresentation): FocusTopicPresentation {
  return (key ? preferences?.find(item => item.key === key)?.presentation : undefined)
    ?? (kind === 'project' ? 'sections' : authoredTopicPresentation ?? 'cards')
}

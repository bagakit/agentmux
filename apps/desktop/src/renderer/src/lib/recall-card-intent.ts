import { recallCardHref, readRecallCard, type RecallCard } from '@agentmux/core/notebook-observation'
import type { NoteResource } from '@agentmux/core/notebook-catalog'

export type RecallCardIntent = {
  card: RecallCard
  operationId: string
  location: { resource: NoteResource; noteId: string | null; zoneId: string; dailyTitle?: string }
  phase: 'ready' | 'checking'
  writeAttempt?: string
}
export type RecallCardIntents = Record<string, RecallCardIntent>

export const recallIntentKey = (card: RecallCard): string => JSON.stringify([card.routeHostId, card.reference.agentSessionId, card.id])

export function restoreRecallCardIntents(value: unknown): RecallCardIntents {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const validId = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate.length > 0 && !candidate.includes('\0')
  const result: RecallCardIntents = {}
  for (const [key, input] of Object.entries(value)) {
    const intent = input as RecallCardIntent | null
    if (!intent || !intent.location || !intent.location.resource || !validId(intent.operationId) || !validId(intent.location.zoneId) ||
      intent.location.noteId !== null && !validId(intent.location.noteId) ||
      intent.location.dailyTitle !== undefined && !validId(intent.location.dailyTitle) ||
      intent.writeAttempt !== undefined && !validId(intent.writeAttempt) || !['ready', 'checking'].includes(intent.phase)) continue
    const { resource } = intent.location
    if (![resource.hostId, resource.workspaceId, resource.workspacePath, resource.path].every(validId) ||
      resource.path.startsWith('/') || resource.path.split(/[\\/]/u).includes('..')) continue
    try {
      const card = readRecallCard(recallCardHref(intent.card), intent.card.title)
      if (card && recallIntentKey(card) === key) result[key] = { ...intent, card }
    } catch { continue }
  }
  return result
}

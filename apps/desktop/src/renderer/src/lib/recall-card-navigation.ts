import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import type { ConversationRef } from '@agentmux/core/conversation'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { useAppStore } from '../store'
import { presentKnowledgeSurface } from './knowledge-surface-navigation'
import { openNotebookPage, resolveNotebookPageWorkface } from './recall-notebooks'
import { sessionPresentationById } from './session-presentation'

export type RecallDestination = { page: NotebookPage; blockId: string; title?: string }
export type RecallBacklinks = {
  complete: boolean
  byCard: ReadonlyMap<string, readonly RecallDestination[]>
}

/** Project each graph observation once for the visible conversation. */
export function recallBacklinks(snapshot: NotebookGraphSnapshot, conversation: ConversationRef): RecallBacklinks {
  const byCard = new Map<string, RecallDestination[]>()
  for (const entry of snapshot.graph.recallCards ?? []) {
    if (entry.card.routeHostId !== conversation.hostId || entry.card.reference.agentSessionId !== conversation.agentSessionId) continue
    const page = snapshot.catalog.pages[entry.source.noteId]
    if (!page) continue
    const key = recallCardHref(entry.card), links = byCard.get(key) ?? []
    links.push({ page, blockId: entry.source.blockId, title: entry.card.title })
    byCard.set(key, links)
  }
  return { complete: snapshot.graph.completeness === 'complete', byCard }
}

export async function openRecallCardNote(page: NotebookPage, blockId: string | undefined, sourceDocument: Document): Promise<void> {
  const state = useAppStore.getState()
  const original = resolveNotebookPageWorkface(page)
  state.setRecallNotebook(page.notebookId, page.noteId)
  if (!await presentKnowledgeSurface('recall', state.setMainSurface, { inputPolicy: 'target', sourceDocument }) ||
    !await openNotebookPage(original, undefined, undefined, blockId === undefined ? undefined : { noteId: page.noteId, blockId })) {
    throw new Error('The original Note is kept. Its card position is not currently visible.')
  }
}

export async function openRecallCardRecord(card: RecallCard): Promise<boolean> {
  const state = useAppStore.getState(), session = sessionPresentationById(state.sessions).get(card.reference.agentSessionId)
  if (session?.kind !== 'agent' || session.control.hostId !== card.routeHostId || !state.focusExecutionSession(card.reference.agentSessionId)) {
    return false
  }
  state.setMainSurface('agents')
  const result = await useAppStore.getState().revealConversationItem(card.reference, card.routeHostId)
  if (result.kind === 'unavailable') state.reportError(new Error(result.message), { kind: 'indeterminate' })
  return true
}

import { NativeSelect } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { notebookPageArchiveRoot } from '@agentmux/core/notebook-catalog'
import { recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import { useAppStore } from '../store'
import { checkRecallCard, saveRecallCard } from '../lib/recall-card-capture'
import { openRecallCardNote, type RecallBacklinks, type RecallDestination } from '../lib/recall-card-navigation'
import { recallIntentKey } from '../lib/recall-card-intent'
import { refreshNotebookLibrary, useNotebookLibrary } from '../lib/notebook-library'
import { RecallCardLink, RecallKnowledgeCard } from './RecallKnowledgeCard'

const Chevron = semanticIconComponent('navigation.down')

export function ConversationRecallCard({ card, backlinks, inNamedRow = false }: { card: RecallCard; inNamedRow?: boolean; backlinks?: RecallBacklinks | null }) {
  const pending = useAppStore(state => {
    const intent = state.recallCardIntents[recallIntentKey(card)]
    return intent?.phase === 'checking' ? intent : undefined
  })
  const library = useNotebookLibrary(state => state.state)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ destination: RecallDestination; observation: RecallBacklinks | null | undefined } | null>(null)
  const pages = Object.values(library?.pages ?? {}).filter(page => !notebookPageArchiveRoot(library!.pages, page.noteId))
  const links = [...(backlinks?.byCard.get(recallCardHref(card)) ?? [])]
  if (saved && (backlinks === saved.observation || !backlinks?.complete) &&
    !links.some(link => link.page.noteId === saved.destination.page.noteId && link.blockId === saved.destination.blockId)) {
    links.push(saved.destination)
  }
  async function capture() {
    setIssue(null)
    setSaving(true)
    try {
      const chosen = selected ? library?.pages[selected] : null
      if (selected && !chosen && !pending) throw new Error('Choose the original Note again. Its selection is unavailable.')
      const destination = pending ? await checkRecallCard(card, pending.operationId) : await saveRecallCard(card, chosen ?? null)
      setSaved({ destination, observation: backlinks })
      if (destination.text === 'link-only') setIssue('Saved the source link. Message text wasn’t available to copy.')
      else if (destination.text === 'partial') setIssue('Saved the available text. Open the original message for its other content.')
    } catch (error) { setIssue(presentError(error)) }
    finally { setSaving(false) }
  }
  return <div className="recall-card-capture">
    {links.length ? <RecallKnowledgeCard kind="Recall" title={card.title} showTitle={!inNamedRow} actions={links.map(({ page, blockId }) =>
      <RecallCardLink key={JSON.stringify([page.noteId, blockId])} onOpen={document => { void openRecallCardNote(page, blockId, document).catch(error => setIssue(presentError(error))) }}>Open {page.title}</RecallCardLink>
    )} /> : null}
    <details onToggle={event => {
      if (event.currentTarget.open) void refreshNotebookLibrary().catch(error => setIssue(presentError(error)))
    }}>
      <summary><Chevron size={12} aria-hidden="true" />{pending ? 'Continue Recall save' : links.length ? 'Save to another Note' : 'Save to Recall'}</summary>
      <form onSubmit={event => { event.preventDefault(); if (!saving) void capture() }}>
        {pending ? <span>{pending.location.resource.path}</span> : <label>Destination
          <NativeSelect value={selected} onChange={event => setSelected(event.target.value)} disabled={saving}>
            <option value="">Today’s Daily · default Notebook</option>
            {pages.map(page => <option key={page.noteId} value={page.noteId}>{page.title} · {library?.notebooks[page.notebookId]?.name} · {page.resource.path}</option>)}
          </NativeSelect>
        </label>}
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : pending ? 'Check original save' : 'Save to Recall'}</Button>
      </form>
    </details>
    {issue ? <p role="status">{issue}</p> : null}
  </div>
}

import { NativeSelect } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { notebookPageArchiveRoot, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import { useAppStore } from '../store'
import { openRecallCardNote, saveRecallCard } from '../lib/recall-card-capture'
import { recallIntentKey } from '../lib/recall-card-intent'
import { refreshNotebookLibrary, useNotebookLibrary } from '../lib/notebook-library'
import { RecallCardLink, RecallKnowledgeCard } from './RecallKnowledgeCard'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'

const Chevron = semanticIconComponent('navigation.down')

export function ConversationRecallCard({ card, observed, onSaved, inNamedRow = false }: { card: RecallCard; inNamedRow?: boolean; observed: NotebookGraphSnapshot | null; onSaved?: () => void }) {
  const pending = useAppStore(state => state.recallCardIntents[recallIntentKey(card)])
  const library = useNotebookLibrary(state => state.state)
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ page: NotebookPage; blockId: string } | null>(null)
  const pages = Object.values(library?.pages ?? {}).filter(page => !notebookPageArchiveRoot(library!.pages, page.noteId))
  const links = (observed?.graph.recallCards ?? []).flatMap(entry => {
    const page = observed?.catalog.pages[entry.source.noteId]
    return page && recallCardHref(entry.card) === recallCardHref(card) ? [{ page, blockId: entry.source.blockId }] : []
  })
  if (saved && observed?.graph.completeness !== 'complete' && !links.some(link => link.page.noteId === saved.page.noteId && link.blockId === saved.blockId)) links.push(saved)
  async function capture() {
    setIssue(null)
    setSaving(true)
    try {
      const chosen = selected ? library?.pages[selected] : null
      if (selected && !chosen && !pending) throw new Error('Choose the original Note again. Its selection is unavailable.')
      setSaved(await saveRecallCard(card, chosen ?? null))
      onSaved?.()
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
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : pending?.phase === 'checking' ? 'Check original save' : 'Save to Recall'}</Button>
      </form>
    </details>
    {issue ? <p role="status">{issue}</p> : null}
  </div>
}

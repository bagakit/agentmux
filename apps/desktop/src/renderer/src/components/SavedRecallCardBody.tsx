import { useEffect, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import { recallCardHref } from '@agentmux/core/notebook-observation'
import { observeRecallNote, type RecallNoteObservation } from '../lib/recall-note-read'
import { openRecallCardNote, type RecallDestination } from '../lib/recall-card-navigation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { useNoteSourceTitle } from '../lib/note-source-name'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { NoteReferenceScope } from './NoteBlockEditor'
import { RecallCardContent } from './RecallCardBody'

/** Observe the exact Note occurrence while the card is visible in the conversation UI. */
export function SavedRecallCardBody({ destination, href }: { destination: RecallDestination; href: string }) {
  const { page, blockId } = destination
  const [attempt, retry] = useState(0)
  const [result, setResult] = useState<RecallNoteObservation | { issue: string }>()
  const ownedDocument = useWorkbenchDocument()
  const sourceName = useNoteSourceTitle()
  const links = useNoteLinkNavigation((target, block) => openRecallCardNote(target, block, ownedDocument))
  useEffect(() => {
    let current = true
    const read = observeRecallNote(page)
    setResult(undefined)
    void read.result.then(value => {
      if (current) setResult(value)
    }).catch(error => { if (current) setResult({ issue: presentError(error) }) })
    return () => { current = false; read.release() }
  }, [page, attempt])
  if (!result) return <p role="status">Reading saved content…</p>
  const retryButton = <button type="button" className="note-text-button" onClick={() => retry(attempt + 1)}>Retry saved content</button>
  if ('issue' in result) return <p role="status">{result.issue} {retryButton}</p>
  const occurrence = result.occurrences.get(blockId)
  if (!occurrence || recallCardHref(occurrence.card) !== href) return <p role="status">This card could not be confirmed in its original Note. Refresh the Reading Points list. {retryButton}</p>
  if (!occurrence.body?.length) return <p>Only the source link was saved.</p>
  return <NoteFileContext.Provider value={page.resource}>
    <NoteReferenceScope knowledge={result.knowledge} sourceName={sourceName} onOpenLink={links.openLink}
      onOpen={(source, block) => { void links.openLink({ text: sourceName(source) ?? source.location.path, target: { noteId: source.note.noteId, blockId: block } }) }}>
      <RecallCardContent blocks={occurrence.body} />
    </NoteReferenceScope>
    {links.dialog}
  </NoteFileContext.Provider>
}

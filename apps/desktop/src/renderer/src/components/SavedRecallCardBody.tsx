import { useEffect, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import { recallCardBlocks, recallCardHref } from '@agentmux/core/notebook-observation'
import { api } from '../lib/api'
import { noteKnowledge } from '../lib/note-knowledge'
import { sameNoteResource } from '../lib/notebook-library'
import { openRecallCardNote, type RecallDestination } from '../lib/recall-card-navigation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { useNoteSourceTitle } from '../lib/note-source-name'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { NoteReferenceScope } from './NoteBlockEditor'
import { RecallCardContent } from './RecallCardBody'

async function readSavedBody({ page, blockId }: RecallDestination, href: string, signal: AbortSignal) {
  const read = await api.notebooks.content(page.noteId, { signal })
  if (!sameNoteResource(read.resource, page.resource)) throw Error('The original Note moved. Refresh the Reading Points list to check its current location.')
  if (read.status !== 'read') throw Error(read.message)
  const { workspaceId, path } = read.resource
  const knowledge = noteKnowledge([{ location: { workspaceId, path }, document: { path, content: read.content, revision: read.revision } }])
  const note = knowledge.sources[0]?.note
  const card = note?.noteId === page.noteId
    ? recallCardBlocks(note.content).find(candidate => candidate.blockId === blockId && recallCardHref(candidate.card) === href)
    : undefined
  if (!card) throw Error('This card could not be confirmed in its original Note. Refresh the Reading Points list.')
  return { knowledge, body: card.body }
}

/** The exact Note occurrence is read only while its saved content is expanded. */
export function SavedRecallCardBody({ destination, href }: { destination: RecallDestination; href: string }) {
  const { page, blockId } = destination
  const [attempt, retry] = useState(0)
  const [result, setResult] = useState<Awaited<ReturnType<typeof readSavedBody>> | { issue: string }>()
  const ownedDocument = useWorkbenchDocument()
  const sourceName = useNoteSourceTitle()
  const links = useNoteLinkNavigation((target, block) => openRecallCardNote(target, block, ownedDocument))
  useEffect(() => {
    const operation = new AbortController()
    setResult(undefined)
    void readSavedBody({ page, blockId }, href, operation.signal).then(value => {
      if (!operation.signal.aborted) setResult(value)
    }).catch(error => { if (!operation.signal.aborted) setResult({ issue: presentError(error) }) })
    return () => operation.abort()
  }, [page, blockId, href, attempt])
  if (!result) return <p role="status">Reading saved content…</p>
  if ('issue' in result) return <p role="status">{result.issue} <button type="button" className="note-text-button" onClick={() => retry(attempt + 1)}>Retry saved content</button></p>
  if (!result.body?.length) return <p>Only the source link was saved.</p>
  return <NoteFileContext.Provider value={page.resource}>
    <NoteReferenceScope knowledge={result.knowledge} sourceName={sourceName} onOpenLink={links.openLink}
      onOpen={(source, block) => { void links.openLink({ text: sourceName(source) ?? source.location.path, target: { noteId: source.note.noteId, blockId: block } }) }}>
      <RecallCardContent blocks={result.body} />
    </NoteReferenceScope>
    {links.dialog}
  </NoteFileContext.Provider>
}

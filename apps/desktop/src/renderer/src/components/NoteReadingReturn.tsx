import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { clearNoteReadingReturn, noteReadingReferenceIsSelected, useNoteReadingReturn } from '../lib/note-reading-return'
import { useAppStore } from '../store'
import { parseNoteFile } from '../lib/note-knowledge'
import { documentKey } from '../lib/workbench-tabs'

/** Select the retained original occurrence without opening, saving or revealing it again. */
export function NoteReadingReturn() {
  const presentation = useWorkbenchBrowserPresentation(), mainSurface = useAppStore(state => state.mainSurface)
  const journey = useNoteReadingReturn(presentation.reference, mainSurface)
  const [issue, setIssue] = useState<string | null>(null)
  if (!journey) return null
  function back() {
    if (!journey) return
    const state = useAppStore.getState(), { from, original } = journey
    const workspace = state.config?.workspaces.find(value => value.id === original.workspaceId)
    const surface = state.tabs[from.tabId]?.regions[from.regionId], member = state.layouts[from.displayWorkspaceId]?.groups.find(group => group.id === from.groupId)?.tabOrder.includes(from.tabId)
    const document = state.documents[documentKey(original.workspaceId, original.path)], read = document && parseNoteFile(document)
    if (!member || workspace?.hostId !== original.hostId || workspace.path !== original.workspacePath || surface?.kind !== 'file' || surface.workspaceId !== original.workspaceId || surface.path !== original.path || read?.status !== 'valid' || read.note.noteId !== original.noteId) {
      setIssue('The original reading position is unavailable. Its identity and draft are kept; restore that Tab to return.'); return
    }
    if (presentation.projection) presentation.projection.onSelect(from)
    else state.selectMainRegion(from)
    const selected = useAppStore.getState()
    if (selected.mainSurface !== journey.surface || !noteReadingReferenceIsSelected(selected, from)) {
      setIssue('Returning to the original reading position was not confirmed. Its identity and draft are kept; retry from this reading surface.'); return
    }
    clearNoteReadingReturn(journey); setIssue(null)
  }
  return <div className="note-reading-return"><button type="button" className="note-text-button" onClick={back}><ArrowLeft size={13} />Return to {journey.title}</button>{issue && <span role="status">{issue}</span>}</div>
}

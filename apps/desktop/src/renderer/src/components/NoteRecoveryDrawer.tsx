import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { NoteVersionHistory } from './NoteVersionHistory'
import { NoteConflictReview } from './NoteConflictReview'
import { RetainedDocumentDrafts, type useNoteConversionObservation } from './RetainedDocumentDraftNotice'

const CloseIcon = semanticIconComponent('action.close')
export type NoteRecoverySection = 'versions' | 'drafts'
type Observation = ReturnType<typeof useNoteConversionObservation>

/** One compact service window; display state never decides whether the Note may be edited. */
export function NoteRecoverySummary({ surface, observation, onView }: {
  surface: FileWorkbenchSurface; observation: Observation; onView(element: HTMLElement): void
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const doc = useAppStore(state => state.documents[key])
  const issue = useAppStore(state => state.documentIssues[key])
  const drafts = useAppStore(state => state.retainedDocumentDrafts[key])
  const receipt = doc?.noteEditing?.receipt
  const facts: string[] = []
  if (issue?.kind === 'changed' || issue?.kind === 'deleted') facts.push('Changes need review')
  else if (issue?.kind === 'read-error') facts.push('File check unavailable')
  else if (issue?.kind === 'write-error') facts.push('Save failed; draft kept')
  else if (issue?.kind === 'binary') facts.push('File format needs review')
  const attempt = doc?.noteEditing?.attempt
  if (attempt) facts.push(attempt.phase === 'sending' ? 'Original save in progress' : attempt.phase === 'written' ? 'Saved result needs review' : 'Original save unconfirmed')
  else if (issue?.kind === 'write-unknown') facts.push('Save outcome unconfirmed')
  if (doc?.noteConversion?.unconfirmedWrite || drafts?.some(draft => draft.noteConversion?.unconfirmedWrite)) facts.push('Earlier save unconfirmed')
  if (drafts?.some(draft => draft.noteEditing?.attempt)) facts.push('Kept save request needs review')
  if (receipt?.noteHistory?.status === 'unconfirmed') facts.push('History unconfirmed')
  if (receipt?.noteTitleProjection?.status === 'unconfirmed') facts.push('Page-list title unconfirmed')
  if (doc?.noteProvenance?.status === 'unconfirmed' || doc?.noteWriteAttribution?.status === 'unconfirmed') facts.push('Authorship unconfirmed')
  if (observation.issues.length || observation.observationIssue) facts.push('Conversion check needs review')
  if (!facts.length) return null
  return <div className="note-recovery-summary" role="status"><span title={facts.join(' · ')}>{facts.slice(0, 2).join(' · ')}{facts.length > 2 ? ` · +${facts.length - 2} more to review` : ''}</span><button type="button" className="note-text-button" onClick={event => onView(event.currentTarget)}>View</button></div>
}

/** An auxiliary reader inside the original File Region; writes stay with its existing owner. */
export function NoteRecoveryDrawer({ tabId, surface, active, section, onSection, expanded, onExpand, onCloseAutoFocus, observation, children }: {
  tabId: string; surface: FileWorkbenchSurface; active: boolean; section: NoteRecoverySection
  onSection(section: NoteRecoverySection): void; expanded: boolean; onExpand(): void
  onCloseAutoFocus(event: Event): void; observation: Observation; children: ReactNode
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const doc = useAppStore(state => state.documents[key])
  const drafts = useAppStore(state => state.retainedDocumentDrafts[key])
  const issue = useAppStore(state => state.documentIssues[key])
  const hostDocument = useWorkbenchDocument()
  const saving = useAppStore(state => Boolean(state.savingDocuments[key]))
  const reportError = useAppStore(state => state.reportError)
  // The saved baseline remains authoritative when the current Source draft is incomplete.
  const saved = readNoteMarkdownHeader(doc?.noteEditing?.baseline?.content ?? '')
  const current = readNoteMarkdownHeader(doc?.content ?? '')
  const noteId = saved.status === 'valid' ? saved.noteId : current.status === 'valid' ? current.noteId : null
  const conflict = issue?.kind === 'changed' || issue?.kind === 'deleted'
  return <Dialog.Content className={`note-recovery-drawer${expanded ? ' note-recovery-drawer--expanded' : ''}`}
    onCloseAutoFocus={onCloseAutoFocus} onPointerDownOutside={event => event.preventDefault()} onFocusOutside={event => event.preventDefault()}>
    <header className="note-recovery-drawer__header">
      <Dialog.Title>Versions &amp; recovery</Dialog.Title>
      <div><button type="button" className="small-button" onClick={onExpand} aria-label={expanded ? 'Return to side panel' : 'Expand review'}>{expanded ? 'Return to side' : 'Expand'}</button>
      <Dialog.Close asChild><button type="button" className="small-button" aria-label="Close versions and recovery"><CloseIcon size={15} /></button></Dialog.Close></div>
    </header>
    <Dialog.Description hidden>Review saved versions and kept input. Your current draft stays in the editor.</Dialog.Description>
    <SurfaceModeSwitch value={section} onChange={onSection} active={active} ariaLabel="Versions and recovery section" options={[
      { value: 'versions', label: 'Versions' }, { value: 'drafts', label: `Drafts & recovery${drafts?.length ? ` (${drafts.length})` : ''}` }
    ]} />
    <div className="note-recovery-drawer__scroll">
      {section === 'versions' ? noteId ? <NoteVersionHistory tabId={tabId} regionId={surface.regionId} noteId={noteId} active={active} />
        : <p role="status">The original Note identity is unconfirmed. Inspect Source or your kept drafts; version history needs the original Note identity.</p>
        : <>
          <h3>Kept input</h3>
          {children}
          <NoteConflictReview tabId={tabId} regionId={surface.regionId} workspaceId={surface.workspaceId} path={surface.path} active={active} />
          {conflict ? <section className="note-recovery-replace"><h4>Replace saved content</h4>
            <p>{issue.kind === 'deleted' ? 'The file was deleted. Overwrite recreates it using this draft.' : 'Overwrite replaces the current saved file with this draft. Review the changes above first.'}</p>
            <button type="button" className="small-button small-button--warning" disabled={saving} onClick={() => {
              const message = issue.kind === 'deleted' ? 'Recreate this file with the current draft?' : 'Replace the saved file with this entire draft?'
              if (hostDocument.defaultView?.confirm(message)) void useAppStore.getState().overwriteDocument(tabId, surface.regionId).catch(reportError)
            }}>Overwrite with this draft</button>
            {issue.kind === 'deleted' || !issue.noteMerge ? <button type="button" className="small-button" disabled={saving} onClick={() => void useAppStore.getState().reloadDocument(tabId, surface.regionId)}>Use current file; keep draft</button> : null}
          </section> : null}
          <RetainedDocumentDrafts tabId={tabId} surface={surface} active={active} observation={observation} inPanel />
          {!drafts?.length && !doc?.noteConversion && !issue && !doc?.noteEditing?.attempt && doc?.noteEditing?.receipt?.noteHistory?.status !== 'unconfirmed' && doc?.noteEditing?.receipt?.noteTitleProjection?.status !== 'unconfirmed' && doc?.noteProvenance?.status !== 'unconfirmed' && doc?.noteWriteAttribution?.status !== 'unconfirmed' && !observation.issues.length && !observation.observationIssue ? <p className="note-recovery-empty">No kept drafts or recovery issues.</p> : null}
        </>}
    </div>
  </Dialog.Content>
}

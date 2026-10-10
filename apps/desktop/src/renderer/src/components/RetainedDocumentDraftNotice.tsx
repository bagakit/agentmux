import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { SelectionField } from './SelectionField'
import type { FileDocument } from '../../../shared/contracts'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'

/** Alternate buffers are user input, independent of any observed disk revision. */
export function RetainedDocumentDraftNotice({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const key = documentKey(surface.workspaceId, surface.path)
  const retainedDrafts = useAppStore(state => state.retainedDocumentDrafts[key])
  const count = retainedDrafts?.length ?? 0
  const retainedUnknown = retainedDrafts?.some(draft => draft.noteConversion?.unconfirmedWrite) ?? false
  const conversion = useAppStore(state => state.documents[key]?.noteConversion)
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId))
  const { active } = useWorkbenchBrowserPresentation()
  const [storage, setStorage] = useState<NotesStorageSnapshot | null>(null), [observationIssue, setObservationIssue] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false), [draftsOpen, setDraftsOpen] = useState(false), [selected, setSelected] = useState(0)
  const selectedDraft = retainedDrafts?.[Math.min(selected, Math.max(0, count - 1))]
  useEffect(() => {
    if (!active || !/\.note\.(?:json|md)$/u.test(surface.path)) return
    let disposed = false
    const observe = (value: NotesStorageSnapshot) => { if (!disposed) { setStorage(value); setObservationIssue(null) } }
    void api.notesStorage.inspect().then(observe).catch(error => { if (!disposed) setObservationIssue('The original Note conversion observation is unavailable. This file remains available; inspect the Notes directory in Settings. ' + String(error)) })
    const release = api.notesStorage.onChange(observe)
    return () => { disposed = true; release() }
  }, [active, surface.workspaceId, surface.path])
  const issues = storage?.conversionIssues?.filter(issue => issue.resource && issue.resource.hostId === workspace?.hostId && issue.resource.workspaceId === surface.workspaceId && issue.resource.workspacePath === workspace.path && issue.resource.path === surface.path) ?? []
  async function retry() {
    if (!storage) return
    setRetrying(true)
    try { setStorage(await api.notesStorage.change(storage.operation ?? { operationId: crypto.randomUUID(), expectedDirectory: storage.directory, directory: storage.directory })); await useAppStore.getState().refreshNotesStorage(); setObservationIssue(null) }
    catch (error) { setObservationIssue('Original Note conversion remains unconfirmed; the file and draft are retained. ' + String(error)) }
    finally { setRetrying(false) }
  }
  const useDraft = useAppStore(state => state.useRetainedDocumentDraft)
  if (!count && !conversion && !issues.length && !observationIssue) return null
  return <>{issues.map((issue, index) => <div key={index} className="editor-file-notice" role="status"><span>{issue.message}</span><button type="button" className="small-button" disabled={retrying} onClick={() => void retry()}>Retry original Note conversion</button></div>)}
  {observationIssue ? <p className="editor-file-notice" role="status">{observationIssue}</p> : null}{count ? <div className="editor-file-notice" role="status">
    <span>{count === 1 ? 'Another draft is kept.' : `${count} other drafts are kept.`} Choosing a draft also keeps your current one. Save is a separate action.</span>
  </div> : null}
  {count ? <details className="note-version-history" open={draftsOpen} onToggle={event => setDraftsOpen(event.currentTarget.open)}>
    <summary>Review kept drafts ({count})</summary>
    {draftsOpen && active && selectedDraft ? <div className="note-version-history__body">
      <SelectionField label="Kept draft" value={String(Math.min(selected, count - 1))} options={retainedDrafts!.map((draft, index) => ({ value: String(index), label: `Draft ${index + 1} · ${draft.content.length.toLocaleString()} characters${draft.noteEditing?.attempt ? ' · original save retained' : ''}` }))} onValueChange={value => setSelected(Number(value))} />
      <KeptDraftContent draft={selectedDraft} />
      <button type="button" className="note-text-button" onClick={() => useDraft(tabId, surface.regionId, selectedDraft)}>Use selected draft; keep current</button>
    </div> : null}
  </details> : null}
  {conversion?.unconfirmedWrite || retainedUnknown ? <p className="editor-file-notice note-conversion-unknown" role="status">
    The original save outcome remains unknown. Reading this file or saving later edits does not confirm or replay it. {conversion?.unconfirmedWrite ? 'Its original input is kept below.' : 'A kept draft contains its original input; open Review kept drafts to inspect it.'}
  </p> : null}{conversion ? <>
    <details className={`note-conversion-backup${conversion.wasDirty === true ? ' note-conversion-backup--unsaved' : ''}`}>
      <summary>{conversion.wasDirty === true ? 'Unsaved draft kept before Markdown conversion' : conversion.wasDirty === false ? 'Backup before Markdown conversion' : 'Content kept before Markdown conversion'}</summary>
      <div className="note-conversion-backup__content">
        <p>{conversion.wasDirty === true ? 'This buffer had unsaved changes when it was converted. Its original content is kept here.' : conversion.wasDirty === false ? 'This is the original content kept during conversion. It does not indicate a failed conversion or unsaved changes.' : 'The original content is kept here. Whether it had unsaved changes at conversion time was not recorded.'}</p>
        <code>{conversion.source.workspaceId} / {conversion.source.path} · {conversion.originalRevision}</code><pre>{conversion.originalContent}</pre>
        {conversion.unconfirmedWrite ? <><p>Input from the unconfirmed original save</p><code>{conversion.unconfirmedWrite.expectedRevision}</code><pre>{conversion.unconfirmedWrite.content}</pre></> : null}
      </div>
    </details>
  </> : null}</>
}


function KeptDraftContent({ draft }: { draft: FileDocument }) {
  const attempt = draft.noteEditing?.attempt, input = draft.noteEditing?.input
  return <div className="note-conversion-backup__content">
    <p>Kept document</p><pre>{draft.content}</pre>
    {attempt ? <details><summary>Original save · {attempt.phase}</summary>
      <p>This is the retained original request. Selecting this draft does not replay or confirm that request.</p>
      <code>{attempt.operationId} · {attempt.resource.workspaceId} / {attempt.resource.path}</code>
      <p>Expected saved revision</p><code>{attempt.expectedRevision ?? 'File did not exist'}</code>
      <p>Submitted content</p><pre>{attempt.content}</pre>
      {attempt.canonical !== undefined ? <><p>Confirmed written content</p><pre>{attempt.canonical}</pre></> : null}
    </details> : null}
    {input ? <details><summary>Unresolved editor inputs · {input.phase}</summary>
      <p>Exact original editor baseline</p><pre>{input.baseContent}</pre>
      <p>Newer draft observed by the original input</p><pre>{input.observedContent}</pre>
      <p>Original editor input</p><pre>{input.proposedContent}</pre>
      {input.queued?.map((delta, index) => <details key={index}><summary>Later editor input {index + 1}</summary>
        <p>Editor baseline</p><pre>{delta.baseContent}</pre><p>Editor input</p><pre>{delta.proposedContent}</pre>
      </details>)}
    </details> : null}
  </div>
}

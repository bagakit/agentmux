import { mintObjectId } from '@agentmux/core/object-id'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { SelectionField } from './SelectionField'
import type { FileDocument } from '../../../shared/contracts'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'

/** Observe the original conversion owner even when the auxiliary reader is closed. */
export function useNoteConversionObservation(surface: FileWorkbenchSurface, active: boolean) {
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId))
  const scope = JSON.stringify([surface.workspaceId, surface.path, workspace?.hostId, workspace?.path])
  const [snapshot, setSnapshot] = useState<{ scope: string; value: NotesStorageSnapshot } | null>(null)
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const epoch = useRef(0)
  const storage = snapshot?.scope === scope ? snapshot.value : null
  const observationIssue = failure?.scope === scope ? failure.message : null
  useEffect(() => {
    const request = ++epoch.current
    setRetrying(false)
    if (!active || !/\.note\.(?:json|md)$/u.test(surface.path)) return
    const observe = (value: NotesStorageSnapshot) => { if (epoch.current === request) { setSnapshot({ scope, value }); setFailure(null) } }
    void api.notesStorage.inspect().then(observe).catch(error => { if (epoch.current === request) setFailure({ scope, message: 'The original Note conversion observation is unavailable. This file remains available; inspect the Notes directory in Settings. ' + String(error) }) })
    const release = api.notesStorage.onChange(observe)
    return () => { ++epoch.current; release() }
  }, [active, scope])
  const issues = storage?.conversionIssues?.filter(issue => issue.resource && issue.resource.hostId === workspace?.hostId && issue.resource.workspaceId === surface.workspaceId && issue.resource.workspacePath === workspace.path && issue.resource.path === surface.path) ?? []
  async function retry() {
    if (!storage || retrying) return
    const request = epoch.current
    setRetrying(true)
    try {
      const value = await api.notesStorage.change(storage.operation ?? { operationId: mintObjectId(), expectedDirectory: storage.directory, directory: storage.directory })
      await useAppStore.getState().refreshNotesStorage()
      if (epoch.current === request) { setSnapshot({ scope, value }); setFailure(null) }
    } catch (error) {
      if (epoch.current === request) setFailure({ scope, message: 'Original Note conversion remains unconfirmed; the file and draft are retained. ' + String(error) })
    } finally { if (epoch.current === request) setRetrying(false) }
  }
  return { issues, observationIssue, retrying, retry }
}

/** Alternate buffers are user input, independent of any observed disk revision. */
export function RetainedDocumentDraftNotice({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const { active } = useWorkbenchBrowserPresentation()
  const observation = useNoteConversionObservation(surface, active)
  return <RetainedDocumentDrafts tabId={tabId} surface={surface} active={active} observation={observation} />
}

export function RetainedDocumentDrafts({ tabId, surface, active, observation, inPanel = false }: {
  tabId: string; surface: FileWorkbenchSurface; active: boolean
  observation: ReturnType<typeof useNoteConversionObservation>; inPanel?: boolean
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const retainedDrafts = useAppStore(state => state.retainedDocumentDrafts[key])
  const conversion = useAppStore(state => state.documents[key]?.noteConversion)
  const count = retainedDrafts?.length ?? 0
  const retainedUnknown = retainedDrafts?.some(draft => draft.noteConversion?.unconfirmedWrite) ?? false
  const { issues, observationIssue, retrying, retry } = observation
  const [draftsOpen, setDraftsOpen] = useState(inPanel), [selected, setSelected] = useState(0)
  const selectedDraft = retainedDrafts?.[Math.min(selected, Math.max(0, count - 1))]
  const useDraft = useAppStore(state => state.useRetainedDocumentDraft)
  if (!count && !conversion && !issues.length && !observationIssue) return null
  return <>{issues.map((issue, index) => <div key={index} className="editor-file-notice" role="status"><span>{issue.message}</span><button type="button" className="small-button" disabled={retrying} onClick={() => void retry()}>Retry original Note conversion</button></div>)}
  {observationIssue ? <p className="editor-file-notice" role="status">{observationIssue}</p> : null}{count && !inPanel ? <div className="editor-file-notice" role="status">
    <span>{count === 1 ? 'Another draft is kept.' : `${count} other drafts are kept.`} Choosing a draft also keeps your current one. Save is a separate action.</span>
  </div> : null}
  {count ? <details className="note-version-history" open={draftsOpen} onToggle={event => setDraftsOpen(event.currentTarget.open)}>
    <summary>Review kept drafts ({count})</summary>
    {draftsOpen && active && selectedDraft ? <div className="note-version-history__body">
      {inPanel ? <p>Choosing a draft also keeps your current one. Save is a separate action.</p> : null}
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

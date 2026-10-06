import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'

/** Alternate buffers are user input, independent of any observed disk revision. */
export function RetainedDocumentDraftNotice({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const key = documentKey(surface.workspaceId, surface.path)
  const count = useAppStore(state => state.retainedDocumentDrafts[key]?.length ?? 0)
  const conversion = useAppStore(state => state.documents[key]?.noteConversion)
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId))
  const { active } = useWorkbenchBrowserPresentation()
  const [storage, setStorage] = useState<NotesStorageSnapshot | null>(null), [observationIssue, setObservationIssue] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
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
    <span>{count === 1 ? 'Another draft was kept after the directory changed.' : `${count} other drafts were kept after the directory changed.`} Choosing it keeps your current draft too. Save to write the selected draft.</span>
    <button type="button" className="small-button" onClick={() => useDraft(tabId, surface.regionId)}>Use kept draft</button>
  </div> : null}{conversion ? <details className="editor-file-notice"><summary>Original draft before Markdown conversion</summary>
    <div><code>{conversion.source.workspaceId} / {conversion.source.path} · {conversion.originalRevision}</code><pre>{conversion.originalContent}</pre>
      {conversion.unconfirmedWrite ? <><p>This original save outcome remains unknown. Conversion and later saves do not confirm or replay it.</p><code>{conversion.unconfirmedWrite.expectedRevision}</code><pre>{conversion.unconfirmedWrite.content}</pre></> : null}
    </div></details> : null}</>
}

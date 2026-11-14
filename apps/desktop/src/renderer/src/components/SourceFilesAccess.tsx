import { useEffect, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { FileReadResource } from '@agentmux/core/files'
import { fileExplorerContains } from '../lib/file-explorer-scope'
import type { SourceFilesResolution } from '../../../shared/source-files'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { SurfaceState } from './SurfaceState'

const Info = semanticIconComponent('status.info')

/** Selection and retained requests live in UserState; Source facts remain with their original owner. */
export function SourceFilesAccess({ workspace, visible, objectDirectory, objectZone }: { workspace: WorkspaceRecord; visible: boolean; objectDirectory?: string | null; objectZone?: string | undefined }) {
  const displayPath = usePathDisplay()
  const input = useAppStore(state => objectDirectory ? undefined : state.sourceFilesInputs.selections[workspace.id])
  const workLocation = useAppStore(state => {
    if (objectDirectory) return null
    const choice = state.workbenchSpaceSelection
    return choice?.workspaceId === workspace.id ? JSON.stringify([choice.spaceId, choice.zoneId, choice.sourceRuntimeId ?? null]) : null
  })
  const pending = useAppStore(state => state.sourceFilesInputs.pending)
  const creations = useAppStore(state => state.sourceFilesInputs.creations)
  const folderRequests = useAppStore(state => state.sourceFilesInputs.folderRequests)
  const [result, setResult] = useState<SourceFilesResolution | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    try { setResult(await useAppStore.getState().resolveFilesSource(workspace.id)); setIssue(null) }
    catch (cause) { setIssue(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (!visible || objectDirectory) return
    let active = true
    setResult(null); setIssue(null)
    void useAppStore.getState().resolveFilesSource(workspace.id).then(value => { if (active) setResult(value) }, cause => { if (active) setIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [visible, workspace.id, workspace.hostId, workspace.path, workLocation, objectDirectory])
  useEffect(() => {
    if (!visible || !input?.locator) return
    let active = true, release: (() => void) | undefined
    void useAppStore.getState().observeFilesSource(workspace.id).then(dispose => { if (active) release = dispose; else dispose() }, cause => { if (active) setIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false; release?.() }
  }, [visible, workspace.id, input?.locator])
  if (!visible) return null
  const owns = (request: { workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>; request: { expectedResource: FileReadResource } }) =>
    request.workspace.id === workspace.id && (!objectDirectory ||
      request.workspace.hostId === workspace.hostId && request.workspace.path === workspace.path &&
      request.request.expectedResource.zoneId === objectZone && fileExplorerContains(objectDirectory, request.request.expectedResource.path))
  const retained = Object.entries(pending).filter(([, request]) => owns(request))
  const retainedCreations = Object.entries(creations).filter(([, request]) => owns(request))
  const retainedFolders = objectDirectory ? [] : Object.entries(folderRequests).filter(([, request]) => request.workspace.id === workspace.id)
  const message = issue ?? (result?.status === 'selection-required' ? result.issue?.message : input?.issue ?? (result?.status === 'unconfirmed' ? result.issue.message : null))
  const registrationUnknown = input?.registration && input.registrationStatus !== 'confirmed'
  const registration = result?.status === 'registration-required' && !registrationUnknown ? result.registration : null
  if ((objectDirectory || input?.locator) && !message && !retained.length && !retainedCreations.length && !retainedFolders.length && !registrationUnknown) return null
  return <div className="file-operation-service" role="status">
    {!objectDirectory && (registration || registrationUnknown || message) ? <SurfaceState layout="inline" className="file-operation-service__source" aria-busy={busy}
      identity={<Info size={14} aria-hidden="true" />}
      title={registration ? 'Connect this folder to Files' : result?.status === 'unconfirmed' && result.issue.code === 'SPACE_DIRECTORY_CHANGED'
        ? 'Folder identity changed' : registrationUnknown ? 'Folder registration needs checking' : 'Folder access needs checking'}
      description={registration ? 'Connect to create, move or delete files. Open editors stay available.'
        : registrationUnknown ? 'The original registration is saved for checking.' : 'Open editors stay available.'}
      actions={registration ? <button type="button" className="small-button" disabled={busy} onClick={() => {
        setBusy(true)
        void useAppStore.getState().useFilesSourceFolder(workspace.id, registration).then(value => { setResult(value); setIssue(null) }, cause => { setIssue(cause instanceof Error ? cause.message : String(cause)) }).finally(() => setBusy(false))
      }}>{busy ? 'Connecting…' : 'Use this folder for Files'}</button> : <button type="button" className="small-button" disabled={busy} onClick={() => void check()}>
        {busy ? 'Checking…' : registrationUnknown ? 'Check original registration' : 'Check original folder'}
      </button>}
      details={message || registrationUnknown ? { summary: 'Details', content: <>
        {message ? <p>{message}</p> : null}
        {registrationUnknown ? <p>Finding the folder now does not confirm the earlier registration.</p> : null}
        {message && result?.status !== 'registration-required' ? <button type="button" className="small-button" disabled={busy} onClick={() => {
          setBusy(true)
          void useAppStore.getState().selectCurrentFilesSource(workspace.id).then(value => { setResult(value); setIssue(null) }, cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
        }}>Choose current folder</button> : null}
      </> } : undefined} /> : null}
    {result?.status === 'selection-required' ? <details className="file-location-choices">
      <summary>Choose working location <small>· {result.registrations.length} saved positions</small></summary>
      <p>This folder is used in several places. Open its original Space to continue at that position, or choose an exact location below.</p>
      <span>{displayPath(workspace.path, workspace.hostId)}</span>
      {result.registrations.map(registration => <div className="file-operation-service__request" key={JSON.stringify([registration.reference.runtimeId, registration.reference.spaceId, registration.zoneId, registration.workspaceId])}>
        <details><summary>Position details</summary>
          <dl><dt>Project</dt><dd>{displayPath(registration.resource.projectRootPath, workspace.hostId)}</dd>
            <dt>Space</dt><dd>{registration.reference.spaceId}</dd><dt>Zone</dt><dd>{registration.zoneId}</dd>
            <dt>Runtime</dt><dd>{registration.reference.runtimeId}</dd><dt>Workspace</dt><dd>{registration.workspaceId}</dd></dl>
        </details>
        <button className="small-button" disabled={busy} onClick={() => {
      setBusy(true)
      void useAppStore.getState().selectFilesRegistration(workspace.id, { hostId: workspace.hostId, reference: registration.reference, zoneId: registration.zoneId, workspaceId: registration.workspaceId }).then(value => { setResult(value); setIssue(null) }, cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
    }}>Use this location</button></div>)}</details> : null}
    {objectDirectory && issue ? <p>{issue}</p> : null}
    {retained.map(([operationId, request]) => <div key={operationId} className="file-operation-service__request">
      <span>{request.action} · {request.request.path}</span><small>{operationId}</small>
      {request.issue ? <p>{request.issue}</p> : null}
      <button className="small-button" disabled={busy} onClick={() => { setBusy(true); void useAppStore.getState().inspectFilesMutation(operationId).catch(cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }}>Check original operation</button>
    </div>)}
    {retainedCreations.map(([key, creation]) => <div key={key} className="file-operation-service__request">
      <span>Create file · {creation.request.path}</span>
      <p>{creation.issue ?? 'The original creation reply is unconfirmed. This API has no creation operation ID; checking the current file does not repeat it.'}</p>
      <button className="small-button" disabled={busy} onClick={() => { setBusy(true); void useAppStore.getState().inspectFileCreation(key).catch(cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }}>Check original file</button>
    </div>)}
    {retainedFolders.map(([key, folder]) => <div key={key} className="file-operation-service__request">
      <span>Folder registration · {folder.workspace.path}</span>
      <small>{folder.packet.runtimeId}</small>
      <p>{folder.issue ?? 'The original folder registration request is retained at its original Source.'}</p>
      <button className="small-button" disabled={busy} onClick={() => { setBusy(true); void useAppStore.getState().inspectFilesFolderRequest(key).catch(cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)) }}>Check original registration</button>
    </div>)}
  </div>
}

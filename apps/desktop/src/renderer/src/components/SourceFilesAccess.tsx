import { useEffect, useState } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { SourceFilesResolution } from '../../../shared/source-files'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'

/** Selection and retained requests live in UserState; Source facts remain with their original owner. */
export function SourceFilesAccess({ workspace, visible }: { workspace: WorkspaceRecord; visible: boolean }) {
  const displayPath = usePathDisplay()
  const input = useAppStore(state => state.sourceFilesInputs.selections[workspace.id])
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
    if (!visible) return
    let active = true
    void useAppStore.getState().resolveFilesSource(workspace.id).then(value => { if (active) setResult(value) }, cause => { if (active) setIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [visible, workspace.id, workspace.hostId, workspace.path])
  useEffect(() => {
    if (!visible || !input?.locator) return
    let active = true, release: (() => void) | undefined
    void useAppStore.getState().observeFilesSource(workspace.id).then(dispose => { if (active) release = dispose; else dispose() }, cause => { if (active) setIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false; release?.() }
  }, [visible, workspace.id, input?.locator])
  const retained = Object.entries(pending).filter(([, request]) => request.workspace.id === workspace.id)
  const retainedCreations = Object.entries(creations).filter(([, request]) => request.workspace.id === workspace.id)
  const retainedFolders = Object.entries(folderRequests).filter(([, request]) => request.workspace.id === workspace.id)
  const message = issue ?? (result?.status === 'selection-required' ? result.issue?.message : input?.issue ?? (result?.status === 'unconfirmed' ? result.issue.message : null))
  const registrationUnknown = input?.registration && input.registrationStatus !== 'confirmed'
  if (input?.locator && !message && !retained.length && !retainedCreations.length && !retainedFolders.length && !registrationUnknown) return null
  return <div className="file-operation-service" role="status">
    {message ? <p>{message}</p> : null}
    {registrationUnknown ? <><p>The original folder registration request is retained. Current discovery does not confirm a missing registration reply.</p><button className="small-button" disabled={busy} onClick={() => void check()}>Check original registration</button></> : null}
    {result?.status === 'registration-required' ? <><p>Connect this folder to its original Files owner to create, move or delete paths. Existing editors remain available.</p>
      <button className="small-button" disabled={busy} onClick={() => {
        const packet = result.registration
        setBusy(true)
        void useAppStore.getState().useFilesSourceFolder(workspace.id, packet).then(value => { setResult(value); setIssue(null) }, cause => { setIssue(cause instanceof Error ? cause.message : String(cause)) }).finally(() => setBusy(false))
      }}>Use this folder for Files</button></> : message ? <button className="small-button" disabled={busy} onClick={() => void check()}>Check original folder</button> : null}
    {message && result?.status !== 'registration-required' ? <button className="small-button" disabled={busy} onClick={() => {
      setBusy(true)
      void useAppStore.getState().selectCurrentFilesSource(workspace.id).then(value => { setResult(value); setIssue(null) }, cause => setIssue(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
    }}>Choose current Source</button> : null}
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

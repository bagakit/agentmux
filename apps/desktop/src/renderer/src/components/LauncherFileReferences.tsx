import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, File, Folder, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WorkspaceDirectoryEntry, WorkspaceRecord } from '../../../shared/contracts'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Reads this selected Workspace's existing file owner; no local picker or attachment transfer. */
export function LauncherFileReferences({ workspace, hostLabel, onSelect, onClose }: {
  workspace: WorkspaceRecord
  hostLabel?: string | undefined
  onSelect(path: string): void
  onClose(): void
}) {
  const [directory, setDirectory] = useState('')
  const resourceKey = JSON.stringify([workspace.id, workspace.hostId, workspace.path, directory])
  const [observation, setObservation] = useState<{
    resourceKey: string; entries: WorkspaceDirectoryEntry[] | null; issue: string | null; loading: boolean
  } | null>(null)
  const currentObservation = observation?.resourceKey === resourceKey ? observation : null
  const entries = currentObservation?.entries ?? null
  const issue = currentObservation?.issue ?? null
  const loading = currentObservation?.loading ?? true
  const [revision, setRevision] = useState(0)
  const fullPath = (relativePath: string) => relativePath ? `${workspace.path.replace(/\/+$/, '')}/${relativePath}` : workspace.path
  useEffect(() => {
    let current = true
    setObservation(previous => ({ resourceKey,
      entries: previous?.resourceKey === resourceKey ? previous.entries : null, issue: null, loading: true }))
    void api.files.readDirectory(workspace.id, directory).then(value => {
      if (current) setObservation({ resourceKey, entries: value, issue: null, loading: false })
    }, error => {
      if (current) setObservation(previous => ({ resourceKey,
        entries: previous?.resourceKey === resourceKey ? previous.entries : null,
        issue: presentError(error), loading: false }))
    })
    return () => { current = false }
  }, [workspace.id, directory, resourceKey, revision])
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface launcher-file-references">
        <header className="confirmation-dialog__heading"><Dialog.Title className="confirmation-dialog__title">Reference a project file</Dialog.Title>
          <Dialog.Close className="icon-button" aria-label="Close project file picker"><X size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">{workspace.name} · {hostLabel ?? workspace.hostId}</Dialog.Description>
        <div className="launcher-file-references__directory"><button type="button" className="icon-button" disabled={!directory}
          aria-label="Parent directory" onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}><ArrowLeft size={14} /></button>
          <span title={fullPath(directory)}>{directory || workspace.path}</span>
          <button type="button" className="icon-button" aria-label="Refresh project files" onClick={() => setRevision(value => value + 1)}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button></div>
        <div className="launcher-target__projects" aria-busy={loading}>
          {entries?.map(entry => <button type="button" key={entry.path} className="launcher-target__project" data-reference-path={entry.path}
            title={`${entry.name}\n${fullPath(entry.path)}`}
            onClick={() => { if (entry.isDirectory) setDirectory(entry.path); else { onSelect(entry.path); onClose() } }}>
            {entry.isDirectory ? <Folder size={14} /> : <File size={14} />}<span><strong>{entry.name}</strong></span>
          </button>)}
          {entries?.length === 0 ? <p>No files in this directory.</p> : null}
          {loading ? <p role="status">{entries ? 'Refreshing this directory…' : 'Reading this project…'}</p> : null}
          {issue ? <div className="composer-feedback" role="alert"><span>{issue}</span><button type="button" onClick={() => setRevision(value => value + 1)}>Retry</button></div> : null}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

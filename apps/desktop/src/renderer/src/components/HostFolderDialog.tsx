import { TextInput } from '@agentmux/client-ui/input'
import * as Dialog from '@radix-ui/react-dialog'
import { FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Registration uses the selected original Host; it never starts an Agent. */
export function HostFolderDialog({ hostId, label, onClose }: { hostId: string; label: string; onClose(): void }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  async function open() {
    setBusy(true); setIssue(null)
    try {
      const workspace = await api.workspaces.add({ hostId, path: path.trim() })
      useAppStore.setState(current => current.config && !current.config.workspaces.some(item => item.id === workspace.id)
        ? { config: { ...current.config, workspaces: [...current.config.workspaces, workspace] } } : current)
      await useAppStore.getState().selectWorkspace(workspace.id)
      onClose()
    } catch (error) { setIssue(presentError(error)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface project-group-dialog" aria-busy={busy}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><FolderOpen size={15} /><Dialog.Title className="confirmation-dialog__title">Open Folder · {label}</Dialog.Title>
          <Dialog.Close className="icon-button" disabled={busy} aria-label="Close folder editor"><X size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">Open a directory on {label}.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void open() }}>
          <label className="project-group-dialog__name">Folder path<TextInput autoFocus value={path} disabled={busy} onChange={event => setPath(event.target.value)} placeholder="Project directory" /></label>
          {issue ? <p role="alert" className="project-group-dialog__issue">{issue}</p> : null}
          <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="small-button confirmation-dialog__confirm--neutral" disabled={busy || !path.trim()}>{busy ? 'Opening…' : 'Open Folder'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

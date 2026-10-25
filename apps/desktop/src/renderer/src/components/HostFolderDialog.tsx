import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


/** Registration uses the selected original Host; it never starts an Agent. */
export function HostFolderDialog({ hostId, label, onClose }: { hostId: string; label: string; onClose(): void }) {
  const ownerDocument = useWorkbenchDocument()
  const opener = useRef(ownerDocument.activeElement as HTMLElement | null), content = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
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
  return <Dialog.Root recoveryCloseDisabled={busy} open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface host-folder-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
        onCloseAutoFocus={event => { event.preventDefault(); const original = opener.current, active = ownerDocument.activeElement
          if (original?.isConnected && (active === ownerDocument.body || active === original || !active?.isConnected || content.current?.contains(active))) original.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><ThemeObjectFolderOpenIcon size={15} /><Dialog.Title className="confirmation-dialog__title">Open Folder · {label}</Dialog.Title>
          <Dialog.Close className="icon-button" disabled={busy} aria-label="Close folder editor" title="Close folder editor"><ThemeActionCloseIcon size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">Open a directory on {label}.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void open() }} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
          <label className="confirmation-dialog__field host-folder-dialog__path">Folder path<TextInput ref={input} value={path} disabled={busy} onChange={event => setPath(event.target.value)} placeholder="Project directory" /></label>
          {issue ? <p role="alert" className="surface-inline-error">{issue}</p> : null}
          <footer><Button className="confirmation-dialog__cancel" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !path.trim()}>{busy ? 'Opening…' : 'Open Folder'}</Button></footer>
        </form>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}

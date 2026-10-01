import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_TOPIC_TITLE_MAX_LENGTH } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { presentError } from '../lib/error-presentation'
import { isImeOwnedKeyboardEvent } from '../lib/ime-composition-keyboard-event'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** A name edits the original Topic title, never a Session or directory identity. */
export function MoteRenameDialog({ target, onClose, returnFocus }: {
  target: { topic: ScratchTopicSnapshot; workspace: WorkspaceRecord } | null
  onClose(): void; returnFocus?(): HTMLElement | null
}) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), content = useRef<HTMLDivElement>(null)
  const current = useRef(target); current.current = target
  const epoch = useRef({})
  useLayoutEffect(() => { epoch.current = {}; setName(target?.topic.title ?? ''); setError(null); setBusy(false) }, [target?.topic.id, target?.workspace.id])
  async function save() {
    const captured = target, operation = epoch.current, title = name.trim()
    if (!captured || busy) return
    if (!title) { setError('Enter a name for this Mote.'); input.current?.focus(); return }
    if (title.length > SCRATCH_TOPIC_TITLE_MAX_LENGTH) { setError(`Use ${SCRATCH_TOPIC_TITLE_MAX_LENGTH} characters or fewer.`); input.current?.focus(); return }
    if (title === captured.topic.title) { onClose(); return }
    const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === captured.workspace.id)
    if (workspace?.hostId !== captured.workspace.hostId || workspace.path !== captured.workspace.path) { setError('The original Mote directory is still restoring.'); return }
    setBusy(true); setError(null)
    const isCurrent = () => epoch.current === operation && current.current?.topic.id === captured.topic.id
    try {
      await useAppStore.getState().renameScratchTopic(captured.topic.id, title, captured.workspace.id)
      if (isCurrent()) onClose()
    } catch (cause) { if (isCurrent()) setError(presentError(cause)) }
    finally { if (isCurrent()) setBusy(false) }
  }
  return <Dialog.Root open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface mote-rename" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select() }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus?.(); const active = document.activeElement
          if (node?.isConnected && (active === document.body || active === node || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (busy || isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">Rename Mote</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">Choose the name shown in Space and the Mote list. Its discussions and files stay together.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          <label className="mote-rename__field">Name<input ref={input} value={name} disabled={busy} autoComplete="off" maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}
            onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault() }} /></label>
          {error ? <p role="alert" className="new-tab-error">{error}</p> : null}
          <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

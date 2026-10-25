import { useWorkbenchDocument } from '../lib/workbench-document'
import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import type { TopicCategory } from '@agentmux/core/control'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { refreshTopicSpatial } from '../lib/topic-knowledge-actions'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'

const ThemeActionCloseIcon = semanticIconComponent('action.close')

export function TopicCategoryDialog({ target, onClose, returnFocus }: { target: TopicCategory | 'create' | null; onClose(): void; returnFocus?: () => HTMLElement | null }) {
  const ownerDocument = useWorkbenchDocument()
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), id = useRef('')
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => { setName(target && target !== 'create' ? target.title : ''); id.current = mintObjectId(); setError(null) }, [target])
  async function save() {
    if (!target || busy || !name.trim()) return
    setBusy(true); setError(null)
    try {
      if (target === 'create') await api.topics.call('topic.category.create', { categoryId: id.current, title: name.trim() })
      else {
        if (!target.revision) throw new Error('Read the original Category before renaming it. Your name is kept here.')
        await api.topics.call('topic.category.rename', { categoryId: target.categoryId, title: name.trim(), expectedRevision: target.revision })
      }
      await refreshTopicSpatial(); onClose()
    } catch (cause) { setError(presentError(cause)) } finally { setBusy(false) }
  }
  return <Dialog.Root recoveryCloseDisabled={busy} open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface topic-dialog" aria-busy={busy} onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
        onCloseAutoFocus={event => {
          if (!returnFocus) return
          event.preventDefault()
          const original = returnFocus(), active = ownerDocument.activeElement
          if (original?.isConnected && (active === ownerDocument.body || active === original || !active?.isConnected || content.current?.contains(active))) original.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <header className="confirmation-dialog__heading"><Dialog.Title className="confirmation-dialog__title">{target === 'create' ? 'New Topic category' : 'Rename Topic category'}</Dialog.Title>
          <Dialog.Close className="icon-button" disabled={busy} aria-label="Close category editor" title="Close category editor"><ThemeActionCloseIcon size={14} /></Dialog.Close></header>
        <Dialog.Description className="confirmation-dialog__description">Group related Topics under a shared theme.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void save() }} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault() }}><label className="confirmation-dialog__field">Name<TextInput ref={input} value={name} maxLength={120} disabled={busy} autoComplete="off" onChange={event => setName(event.target.value)} /></label>
          {error ? <p role="alert" className="surface-inline-error">{error}</p> : null}
          <footer><Button className="confirmation-dialog__cancel" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save category'}</Button></footer>
        </form>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}

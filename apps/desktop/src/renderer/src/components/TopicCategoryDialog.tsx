import * as Dialog from '@radix-ui/react-dialog'
import type { TopicCategory } from '@agentmux/core/control'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { refreshTopicSpatial } from '../lib/topic-knowledge-actions'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'

export function TopicCategoryDialog({ target, onClose }: { target: TopicCategory | 'create' | null; onClose(): void }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), id = useRef('')
  useEffect(() => { setName(target && target !== 'create' ? target.title : ''); id.current = crypto.randomUUID(); setError(null) }, [target])
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
  return <Dialog.Root open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface topic-dialog" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
        onEscapeKeyDown={event => { if (busy || isImeOwnedKeyboardEvent(event)) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">{target === 'create' ? 'New Topic category' : 'Rename Topic category'}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">Group related Topics under a shared theme.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void save() }}><label>Name<input ref={input} value={name} maxLength={120} disabled={busy} autoComplete="off" onChange={event => setName(event.target.value)} /></label>
          {error ? <p role="alert" className="surface-inline-error">{error}</p> : null}
          <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save category'}</button></footer>
        </form>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}

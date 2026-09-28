import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { SPACE_ICON_CATALOG, type SpaceIconId, type SpaceIconTarget } from '../lib/space-object-appearance'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Shared chooser; drafts stay local until Save, authored metadata has the existing store owner. */
export function SpaceIconPicker({ target, onClose, returnFocus }: {
  target: SpaceIconTarget | null; onClose(): void; returnFocus?: () => HTMLElement | null
}) {
  const [draft, setDraft] = useState<SpaceIconId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const returnKey = useRef<string | null>(null)
  useEffect(() => {
    if (target) returnKey.current = target.key
    setDraft(target ? useAppStore.getState().spaceObjectIcons[target.key] ?? null : null)
    setError(null)
  }, [target?.key])

  async function save(): Promise<void> {
    if (!target || busy) return
    setBusy(true); setError(null)
    try {
      await useAppStore.getState().setSpaceObjectIcon(target.key, draft)
      onClose()
    } catch (cause) {
      setError(presentError(cause))
    } finally { setBusy(false) }
  }
  return <Dialog.Root open={target !== null} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="space-icon-picker__overlay dialog-scrim" />
      <Dialog.Content className="space-icon-picker dialog-surface" onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const row = returnFocus?.() ?? [...document.querySelectorAll<HTMLElement>('[data-space-icon-target]')]
            .find(node => node.dataset.spaceIconTarget === returnKey.current)
          row?.focus()
        }}>
        <Dialog.Title className="space-icon-picker__title">Icon for {target?.name}</Dialog.Title>
        <Dialog.Description className="space-icon-picker__description">Choose an icon. Restore automatic to use the default.</Dialog.Description>
        <div className="space-icon-picker__choices" role="group" aria-label="Icon choices">
          {(Object.entries(SPACE_ICON_CATALOG) as Array<[SpaceIconId, typeof SPACE_ICON_CATALOG[SpaceIconId]]>).map(([id, { Icon, label }]) =>
            <button key={id} type="button" className="space-icon-picker__choice" aria-label={`${label} icon`}
              title={label} aria-pressed={draft === id} data-space-icon-choice={id} disabled={busy}
              onClick={() => { setDraft(id); setError(null) }}><Icon size={18} /></button>)}
        </div>
        <button type="button" className="small-button space-icon-picker__automatic" aria-pressed={draft === null}
          disabled={busy} onClick={() => { setDraft(null); setError(null) }}><RotateCcw size={13} />Restore automatic</button>
        {error ? <p className="space-icon-picker__error" role="alert">Saving is unconfirmed. Your choice is kept; retry saving. {error}</p> : null}
        <footer>
          <button type="button" className="small-button" disabled={busy} onClick={onClose}>{error ? 'Close' : 'Cancel'}</button>
          <button type="button" className="small-button space-icon-picker__save" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : error ? 'Retry saving' : 'Save icon'}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

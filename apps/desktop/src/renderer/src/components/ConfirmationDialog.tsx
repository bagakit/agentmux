import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'
import { useRef } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'

export function ConfirmationDialog({
  open,
  title,
  description,
  subject,
  confirmLabel,
  intent = 'danger',
  secondaryLabel,
  busy = false,
  onCancel,
  onSecondary,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  subject?: string
  confirmLabel: string
  intent?: 'danger' | 'neutral'
  secondaryLabel?: string
  busy?: boolean
  onCancel: () => void
  onSecondary?: () => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <Dialog.Portal container={resolveOverlayContainer()}>
        <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
        <Dialog.Content className="confirmation-dialog dialog-surface" aria-busy={busy}
          onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus() }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
          onInteractOutside={(event) => { if (busy) event.preventDefault() }}>
          <header className="confirmation-dialog__heading">
            {intent === 'danger' ? <AlertTriangle size={14} aria-hidden="true" /> : null}
            <Dialog.Title className="confirmation-dialog__title">{title}</Dialog.Title>
          </header>
          {subject ? <p className="confirmation-dialog__subject">{subject}</p> : null}
          <Dialog.Description className="confirmation-dialog__description">{description}</Dialog.Description>
          <footer>
            <button ref={cancelRef} type="button" className="small-button confirmation-dialog__cancel" disabled={busy} onClick={onCancel}>Cancel</button>
            {secondaryLabel && onSecondary ? (
              <button type="button" className="small-button" disabled={busy} onClick={onSecondary}>
                {secondaryLabel}
              </button>
            ) : null}
            <button
              type="button"
              className={intent === 'danger' ? 'danger-button' : 'small-button confirmation-dialog__confirm--neutral'}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

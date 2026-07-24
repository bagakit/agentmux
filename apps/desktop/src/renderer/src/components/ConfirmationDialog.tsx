import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle } from 'lucide-react'

export function ConfirmationDialog({
  open,
  title,
  description,
  subject,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  subject?: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="confirmation-dialog__overlay" />
        <Dialog.Content className="confirmation-dialog" onEscapeKeyDown={onCancel}>
          <div className="confirmation-dialog__icon"><AlertTriangle size={17} /></div>
          <Dialog.Title className="confirmation-dialog__title">{title}</Dialog.Title>
          <Dialog.Description className="confirmation-dialog__description">{description}</Dialog.Description>
          {subject ? <p title={subject}>{subject}</p> : null}
          <footer>
            <button type="button" className="small-button" disabled={busy} onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              autoFocus
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

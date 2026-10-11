import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef, type ReactNode } from 'react'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useWorkbenchDocument } from '../lib/workbench-document'

const ThemeStatusWarningIcon = semanticIconComponent('status.warning')


export function ConfirmationDialog({
  open,
  title,
  description,
  subject,
  confirmLabel,
  feedback,
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
  feedback?: ReactNode
  intent?: 'danger' | 'neutral'
  secondaryLabel?: string
  busy?: boolean
  onCancel: () => void
  onSecondary?: () => void
  onConfirm: () => void
}) {
  const document = useWorkbenchDocument()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const openedContent = useRef<Element | null>(null)
  return (
    <Dialog.Root recoveryCloseDisabled={busy} open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
        <Dialog.Content className="confirmation-dialog dialog-surface" aria-busy={busy}
          onOpenAutoFocus={(event) => { event.preventDefault(); const active = document.activeElement
            previousFocus.current = active?.nodeType === 1 ? active as HTMLElement : null
            openedContent.current = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null; cancelRef.current?.focus() }}
          onCloseAutoFocus={(event) => { event.preventDefault(); const original = previousFocus.current, active = document.activeElement
            if (original?.isConnected && (active === document.body || active === original || !active?.isConnected || openedContent.current?.contains(active))) original.focus({ preventScroll: true }) }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
          onInteractOutside={(event) => { if (busy) event.preventDefault() }}>
          <header className="confirmation-dialog__heading">
            {intent === 'danger' ? <ThemeStatusWarningIcon size={14} aria-hidden="true" /> : null}
            <Dialog.Title className="confirmation-dialog__title">{title}</Dialog.Title>
          </header>
          {subject ? <p className="confirmation-dialog__subject">{subject}</p> : null}
          <Dialog.Description className="confirmation-dialog__description">{description}</Dialog.Description>
          {feedback}
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
              data-confirm-label={confirmLabel}
              disabled={busy}
              onClick={onConfirm}
            >
              <span>{busy ? 'Working…' : confirmLabel}</span>
            </button>
          </footer>
        </Dialog.Content>
      </DocumentOverlayPortal>
    </Dialog.Root>
  )
}

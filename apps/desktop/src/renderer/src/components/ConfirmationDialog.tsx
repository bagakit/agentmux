import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
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
  // Presentation retry keeps the return target of the same requested opening.
  const capturedOpeningFocus = useRef(false)
  useLayoutEffect(() => { if (!open) capturedOpeningFocus.current = false }, [open])
  return (
    <Dialog.Root recoveryCloseDisabled={busy} open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
        <Dialog.Content className="confirmation-dialog dialog-surface" aria-busy={busy}
          onOpenAutoFocus={(event) => {
            if (!capturedOpeningFocus.current) {
              const active = document.activeElement
              previousFocus.current = active?.nodeType === 1 ? active as HTMLElement : null
              capturedOpeningFocus.current = true
            }
            openedContent.current = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null
            if (cancelRef.current && !cancelRef.current.disabled) { event.preventDefault(); cancelRef.current.focus() } }}
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
            <Button ref={cancelRef} type="button" className="confirmation-dialog__cancel" disabled={busy} onClick={onCancel}>Cancel</Button>
            {secondaryLabel && onSecondary ? (
              <Button type="button" disabled={busy} onClick={onSecondary}>
                {secondaryLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={intent === 'danger' ? 'danger' : 'secondary'}
              className={intent === 'neutral' ? 'confirmation-dialog__confirm--neutral' : undefined}
              data-confirm-label={confirmLabel}
              disabled={busy}
              onClick={onConfirm}
            >
              <span>{busy ? 'Working…' : confirmLabel}</span>
            </Button>
          </footer>
        </Dialog.Content>
      </DocumentOverlayPortal>
    </Dialog.Root>
  )
}

import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useClientUiPlatform } from '../platform.js'
import * as Dialog from './Modal.js'

/** Tool menus leave the toolbar's scroll strip while retaining its trigger and focus owner. */
export function ComposerToolMenu({ open, onOpenChange, label, trigger, className, children }: {
  open: boolean
  onOpenChange(open: boolean): void
  label: string
  trigger: ReactElement
  className?: string
  children: ReactNode
}) {
  const platform = useClientUiPlatform()
  const anchor = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const original = anchor.current
    if (!open || !original || !panel) return
    let current = true
    const update = async () => {
      const position = await computePosition(original, panel, { strategy: 'fixed', placement: 'top-start',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableHeight, availableWidth }) {
          Object.assign(panel.style, { maxHeight: `${Math.max(0, availableHeight)}px`, maxWidth: `${Math.max(0, availableWidth)}px` })
        } })] })
      if (current) Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(original, panel, () => { void update() })
    return () => { current = false; stop() }
  }, [open, panel])
  return <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild ref={anchor}>{trigger}</Dialog.Trigger>
    <Dialog.Portal container={platform.overlayContainer()}>
      <Dialog.Content ref={setPanel} role="menu" aria-label={label} aria-describedby={undefined} className={className}
        style={{ position: 'fixed', top: 0, left: 0, bottom: 'auto', margin: 0, visibility: 'hidden', overflowY: 'auto', zIndex: 'var(--layer-popover)' }}>
        <Dialog.Title hidden>{label}</Dialog.Title>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

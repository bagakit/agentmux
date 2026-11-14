import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement } from '@floating-ui/dom'
import * as Dialog from './Modal.js'

type Surface = Omit<ComponentProps<typeof Dialog.Content>, 'children' | 'ref' | 'style'> & Record<`data-${string}`, unknown>

export function AnchoredChoice({ open, onOpenChange, trigger, label, placement = 'top-start', container, boundary,
  surface, onPlaced, children }: {
  open: boolean
  onOpenChange(open: boolean): void
  trigger: ReactElement
  label: string
  placement?: Placement
  container?: Element | DocumentFragment | null | undefined
  boundary?: Element | ((trigger: HTMLButtonElement) => Element | null) | null | undefined
  surface?: Surface
  onPlaced?(): void
  children: ComponentProps<typeof Dialog.Content>['children']
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const placed = useRef(onPlaced); placed.current = onPlaced
  useLayoutEffect(() => {
    const original = anchor.current
    if (!open || !original || !panel) return
    const owner = typeof boundary === 'function' ? boundary(original) : boundary
    const collision = { padding: 8, boundary: owner ?? 'clippingAncestors' as const }
    panel.dir = original.ownerDocument.defaultView?.getComputedStyle(original).direction ?? 'ltr'
    let current = true
    let revision = 0
    let ready = false
    const update = async () => {
      const generation = ++revision
      const position = await computePosition(original, panel, { strategy: 'fixed', placement,
        middleware: [offset(4), flip(collision), shift(collision), size({ ...collision, apply({ availableHeight, availableWidth, rects }) {
          if (!current || generation !== revision) return
          panel.style.setProperty('--choice-anchor-width', rects.reference.width + 'px')
          panel.style.setProperty('--choice-available-height', Math.max(0, availableHeight) + 'px')
          panel.style.setProperty('--choice-available-width', Math.max(0, availableWidth) + 'px')
        } })] })
      if (current && generation === revision) {
        Object.assign(panel.style, { left: position.x + 'px', top: position.y + 'px', visibility: 'visible' })
        if (!ready) { ready = true; placed.current?.() }
      }
    }
    const stop = autoUpdate(original, panel, () => { void update() })
    return () => { current = false; stop() }
  }, [open, panel, placement, boundary])

  return <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild ref={anchor}>{trigger}</Dialog.Trigger>
    <Dialog.Portal container={container}>
      <Dialog.Content ref={setPanel} aria-describedby={undefined} {...surface}
        style={{ position: 'fixed', top: 0, left: 0, bottom: 'auto', margin: 0, visibility: 'hidden', zIndex: 'var(--layer-popover)' }}>
        <Dialog.Title hidden>{label}</Dialog.Title>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

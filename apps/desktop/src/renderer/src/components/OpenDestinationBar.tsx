import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { ModalAttachmentDismissal } from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { OPEN_DESTINATIONS, openDestinationNeedsRegion, type OpenDestination } from '../lib/open-destination'
import { useWindowOverlayHost } from './WindowOverlayHost'
import { WorkbenchActionRows } from './WorkbenchActionRows'
import { workbenchSplitDirectionIcon } from './workbench-split-menu-icons'

const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionCreateIcon = semanticIconComponent('action.create')
const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')

export type OpenDestinationRequest = Readonly<{ id: number; url: string; x: number; y: number }>

// Membership and order stay at OPEN_DESTINATIONS; only names and semantic glyphs belong here.
const DESTINATION_META = {
  system: { icon: ThemeActionOpenExternalIcon, label: 'Open in system browser' },
  tab: { icon: ThemeActionCreateIcon, label: 'Open in a new tab' },
  left: { icon: workbenchSplitDirectionIcon('left'), label: 'Open in a split on the left' },
  right: { icon: workbenchSplitDirectionIcon('right'), label: 'Open in a split on the right' },
  up: { icon: workbenchSplitDirectionIcon('up'), label: 'Open in a split above' },
  down: { icon: workbenchSplitDirectionIcon('down'), label: 'Open in a split below' }
} satisfies Record<OpenDestination, { icon: typeof ThemeActionOpenExternalIcon; label: string }>

export const OPEN_DESTINATION_BAR_ITEMS = OPEN_DESTINATIONS.map(destination => ({ destination, ...DESTINATION_META[destination] }))
const NEEDS_PANE_REASON = 'A precise pane is required'
const NEEDS_PANE_HINT = 'Choose a precise pane to open beside it.'

/** Native toolbar navigation stays with the destination owner; menu consumers retain Radix. */
function moveToolbarFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (isImeOwnedKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const toolbar = event.currentTarget
  const enabled = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('button[data-destination]:not([disabled])')]
  const buttons = enabled(toolbar)
  if (buttons.length === 0) return
  const current = buttons.find(button => button === toolbar.ownerDocument.activeElement)
  let target: HTMLButtonElement | undefined
  if (event.key === 'Home') target = buttons[0]
  else if (event.key === 'End') target = buttons[buttons.length - 1]
  else if (!current) target = buttons[0]
  else {
    const row = current.closest('.workbench-menu-row')!
    const peers = enabled(row), index = peers.indexOf(current)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const rtl = toolbar.ownerDocument.defaultView?.getComputedStyle(toolbar).direction === 'rtl'
      const backwards = (event.key === 'ArrowLeft') !== rtl
      target = peers[index + (backwards ? -1 : 1)]
    } else {
      const rows = [...toolbar.querySelectorAll('.workbench-menu-row')]
      const next = rows[rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)]
      if (next) { const candidates = enabled(next); target = candidates[Math.min(index, candidates.length - 1)] }
    }
  }
  event.preventDefault()
  event.stopPropagation()
  if (!target) return
  for (const button of buttons) button.tabIndex = button === target ? 0 : -1
  target.focus()
}

/** Original destination semantics, rendered by the same compact rows as the Region menus. */
export function OpenDestinationBar({ canSplit, onSelect, allowedDestinations = OPEN_DESTINATIONS,
  accessibleContext = 'Choose where to open the link'
}: {
  canSplit: boolean; onSelect(destination: OpenDestination): void
  allowedDestinations?: readonly OpenDestination[]; accessibleContext?: string
}) {
  const items = OPEN_DESTINATION_BAR_ITEMS.filter(item => allowedDestinations.includes(item.destination))
    .map(item => ({ ...item, label: openDestinationNeedsRegion(item.destination) && !canSplit
      ? `${item.label} — ${NEEDS_PANE_REASON}` : item.label }))
  const firstEnabled = items.find(item => !openDestinationNeedsRegion(item.destination) || canSplit)
  return <div className="open-destination-bar__toolbar" role="toolbar" tabIndex={-1} aria-label={accessibleContext} onKeyDown={moveToolbarFocus}>
    <WorkbenchActionRows rows={[
      { id: 'open', label: 'Open in', clusters: [items.filter(item => !openDestinationNeedsRegion(item.destination))] },
      { id: 'split', label: 'New region', clusters: [items.filter(item => openDestinationNeedsRegion(item.destination))] }
    ]} itemKey={item => item.destination} renderItem={(item, props) => {
      const Icon = item.icon, disabled = openDestinationNeedsRegion(item.destination) && !canSplit
      return <button {...props} type="button" className="icon-button tab-context-menu__item workbench-menu-row__item"
        data-destination={item.destination} data-disabled={disabled ? '' : undefined}
        data-disabled-reason={disabled ? NEEDS_PANE_REASON : undefined} disabled={disabled}
        tabIndex={item === firstEnabled ? 0 : -1} aria-label={item.label}
        onClick={() => onSelect(item.destination)}><Icon size={16} aria-hidden="true" /></button>
    }} />
  </div>
}

/** The pending request owns both its URL and dismissal identity; placement is presentation only. */
export function OpenDestinationPopover({
  request,
  canSplit,
  onSelect,
  onDismiss
}: {
  request: OpenDestinationRequest | null
  canSplit: boolean
  onSelect(destination: OpenDestination): void
  onDismiss(requestId: number): void
}) {
  const document = useWorkbenchDocument()
  const containerRef = useRef<HTMLDivElement>(null)
  const targetId = useId()
  const requestId = request?.id ?? null
  const [expandedTarget, setExpandedTarget] = useState<number | null>(null)
  const expanded = expandedTarget === requestId
  const overlayHost = useWindowOverlayHost()

  useLayoutEffect(() => {
    const panel = containerRef.current
    if (!request || !panel) return
    let disposed = false
    let enterFocus = true
    const previous = document.activeElement as HTMLElement | null
    let focusOwned = false
    const observeFocus = (event: FocusEvent) => { focusOwned = panel.contains(event.target as Node) }
    document.addEventListener('focusin', observeFocus)
    const anchor = { contextElement: document.documentElement,
      getBoundingClientRect: () => new DOMRect(request.x, request.y, 0, 0) }
    const update = async () => {
      const position = await computePosition(anchor, panel, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8, crossAxis: true })] })
      if (!disposed) {
        Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
        // Hidden controls cannot receive focus. Enter once after placement, without overriding a later choice.
        if (enterFocus) {
          enterFocus = false
          if (document.activeElement === previous) panel.querySelector<HTMLElement>('[role="toolbar"]')?.focus({ preventScroll: true })
        }
      }
    }
    const stop = autoUpdate(anchor, panel, () => { void update() })
    return () => {
      disposed = true; stop()
      document.removeEventListener('focusin', observeFocus)
      // React may remove the focused panel before this cleanup, leaving body active without a focus event.
      const active = document.activeElement
      if ((panel.contains(active) || focusOwned && active === document.body) && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [request, document])

  useEffect(() => {
    if (requestId === null || !overlayHost) return
    const dismiss = (): void => onDismiss(requestId)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !isImeOwnedKeyboardEvent(event)) {
        event.preventDefault()
        dismiss()
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) dismiss()
    }
    document.addEventListener('keydown', onKeyDown)
    // Capture phase so a press that starts inside another overlay still closes this one.
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [requestId, onDismiss, document, overlayHost])

  if (!request || !overlayHost) return null

  return createPortal(
    <><div
      ref={containerRef}
      className="open-destination-bar"
      data-state="open"
      role="dialog"
      aria-label="Choose where to open the link"
      style={{ position: 'fixed', left: request.x, top: request.y, visibility: 'hidden' }}
    >
      <button type="button" className="open-destination-bar__url" aria-expanded={expanded}
        aria-describedby={targetId}
        aria-label={expanded ? 'Collapse link target' : 'Show full link target'}
        onClick={() => setExpandedTarget(expanded ? null : requestId)}>
        <ThemeObjectLinkIcon size={13} aria-hidden="true" />
        <span id={targetId}>{request.url}</span>
        <ThemeNavigationDownIcon size={11} aria-hidden="true" />
      </button>
      <OpenDestinationBar canSplit={canSplit} onSelect={onSelect} />
      {!canSplit ? (
        <p className="open-destination-bar__hint" data-split-destination-explanation="">
          {NEEDS_PANE_HINT}
        </p>
      ) : null}
    </div><ModalAttachmentDismissal active={overlayHost.hasAttribute('data-overlay-modal-slot')} targetRef={containerRef}
      onOwnerRemoved={() => onDismiss(request.id)}
      onEscapeKeyDown={event => { if (event.defaultPrevented) return; event.preventDefault(); onDismiss(request.id) }} /></>,
    overlayHost
  )
}

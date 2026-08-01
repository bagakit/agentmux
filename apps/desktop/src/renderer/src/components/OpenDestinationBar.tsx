import { useEffect, useRef } from 'react'
import {
  ExternalLink,
  PanelBottomClose,
  PanelLeftClose,
  PanelRightClose,
  PanelTopClose,
  SquarePlus
} from 'lucide-react'
import {
  OPEN_DESTINATIONS,
  openDestinationNeedsRegion,
  type OpenDestination
} from '../lib/open-destination'

export type OpenDestinationRequest = Readonly<{
  id: number
  url: string
  x: number
  y: number
}>

// Icon + accessible label per destination. This is *presentation*, keyed exhaustively by the
// destination enum — it is NOT a second answer to "which destinations exist". That truth stays in
// OPEN_DESTINATIONS (lib/open-destination.ts); the row below derives its order and membership from it,
// so adding a destination there surfaces a type error here until it is given an icon and a label.
//
// Why the `Panel*Close` family and not `Panel*Open`, whose names read like what this row does: lucide's
// `Open`/`Close` suffix describes **which way a panel is about to swing**, not which side the pane lands
// on. `PanelLeftOpen` draws the divider on the left (correct) with the chevron pointing **right** — the
// gesture of pushing a collapsed left sidebar open. Borrow it to mean "the new pane appears on the left"
// and the arrow says the opposite; all four were wrong the same way, which is exactly why this read as
// "the directions are reversed" rather than as one odd icon. `Panel*Close` keeps the same divider and
// flips the chevron to point at the side the split lands on. The chevron geometry is asserted in
// open-destination-bar.test.tsx, so a future icon swap has to keep pointing the right way.
const DESTINATION_META = {
  system: { icon: ExternalLink, label: 'Open in system browser' },
  tab: { icon: SquarePlus, label: 'Open in a new tab' },
  left: { icon: PanelLeftClose, label: 'Open in a split on the left' },
  right: { icon: PanelRightClose, label: 'Open in a split on the right' },
  up: { icon: PanelTopClose, label: 'Open in a split above' },
  down: { icon: PanelBottomClose, label: 'Open in a split below' }
} satisfies Record<OpenDestination, { icon: typeof ExternalLink; label: string }>

// Icons stand in for words in the one-row form, so every button still needs a spoken name (aria-label)
// and a pointer name (title). The order is the enum's order — system, tab, then the four directions —
// which already reads left-to-right the way the row is drawn.
export const OPEN_DESTINATION_BAR_ITEMS = OPEN_DESTINATIONS.map((destination) => ({
  destination,
  ...DESTINATION_META[destination]
})) as ReadonlyArray<{
  destination: OpenDestination
  icon: typeof ExternalLink
  label: string
}>

// Why a precise pane is required, said once so both the disabled buttons' tooltips and the always-on
// hint below the row read the same sentence.
const NEEDS_PANE_REASON = 'A precise pane is required'
const NEEDS_PANE_HINT = 'Choose a precise pane to open beside it.'

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

// Roving focus for a horizontal toolbar: Left/Right walk the enabled buttons, Home/End jump to the
// ends. Done off event.currentTarget instead of React state so the row stays a pure function — a
// DOM-free test can call it and read the element tree directly. Native <button> already gives
// Enter/Space; Escape is the popover's job.
function moveRowFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (!NAV_KEYS.has(event.key)) return
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  )
  if (buttons.length === 0) return
  event.preventDefault()
  const active = document.activeElement
  const current = buttons.findIndex((button) => button === active)
  let next = current
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  else if (event.key === 'ArrowLeft') next = current <= 0 ? buttons.length - 1 : current - 1
  else if (event.key === 'ArrowRight') next = current === buttons.length - 1 ? 0 : current + 1
  const target = buttons[next]
  if (!target) return
  for (const button of buttons) button.tabIndex = button === target ? 0 : -1
  target.focus()
}

/**
 * The universal one-row destination picker: six icon buttons that mean where a link opens (system
 * browser, new tab, and the four split directions). No text labels, so accessibility is not optional —
 * every button carries an aria-label and a title. Directional buttons disable when there is no precise
 * pane to split from; the reason travels on each disabled button and, for everyone including keyboard
 * users who cannot focus a disabled control, in the visible hint the popover renders beneath the row.
 *
 * Hookless on purpose: rendered as a plain element tree it can be walked in a DOM-free test, which is
 * how the button-to-destination wiring is pinned.
 */
export function OpenDestinationBar({
  canSplit,
  onSelect
}: {
  canSplit: boolean
  onSelect(destination: OpenDestination): void
}) {
  const firstEnabled = OPEN_DESTINATION_BAR_ITEMS.findIndex(
    (item) => !(openDestinationNeedsRegion(item.destination) && !canSplit)
  )

  return (
    <div
      className="open-destination-bar__row"
      role="toolbar"
      aria-label="Choose where to open the link"
      onKeyDown={moveRowFocus}
    >
      {OPEN_DESTINATION_BAR_ITEMS.map((item, index) => {
        const Icon = item.icon
        const needsRegion = openDestinationNeedsRegion(item.destination)
        const disabled = needsRegion && !canSplit
        return (
          <button
            key={item.destination}
            type="button"
            className="icon-button open-destination-bar__button"
            data-destination={item.destination}
            data-disabled-reason={disabled ? NEEDS_PANE_REASON : undefined}
            disabled={disabled}
            tabIndex={index === firstEnabled ? 0 : -1}
            aria-label={disabled ? `${item.label} — ${NEEDS_PANE_REASON}` : item.label}
            title={disabled ? NEEDS_PANE_REASON : item.label}
            onClick={() => onSelect(item.destination)}
          >
            <Icon size={15} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

/**
 * The floating shell that hosts the one-row picker at the pointer: it keeps the URL in view (that is
 * what the choice is *about*), spells out why the directional choices are unavailable when they are,
 * and dismisses on Escape or an outside press. Props mirror the surface's needs one-for-one —
 * `request` carries the identity a stale close is fenced against, `onSelect` forwards the choice, and
 * `onDismiss` returns the request id so the owner can ignore a late close of a superseded popover.
 */
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
  const containerRef = useRef<HTMLDivElement>(null)
  const requestId = request?.id ?? null

  useEffect(() => {
    if (requestId === null) return
    const dismiss = (): void => onDismiss(requestId)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
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
  }, [requestId, onDismiss])

  if (!request) return null

  return (
    <div
      ref={containerRef}
      className="open-destination-bar"
      data-state="open"
      role="dialog"
      aria-label="Choose where to open the link"
      style={{ position: 'fixed', left: request.x, top: request.y }}
    >
      <div className="open-destination-bar__url">
        <ExternalLink size={13} aria-hidden="true" />
        <span title={request.url}>{request.url}</span>
      </div>
      <OpenDestinationBar canSplit={canSplit} onSelect={onSelect} />
      {!canSplit ? (
        <p className="open-destination-bar__hint" data-split-destination-explanation="">
          {NEEDS_PANE_HINT}
        </p>
      ) : null}
    </div>
  )
}

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
// `column`/`row` place the button on a 3×3 grid, and that placement is the whole point of the redesign:
// four of these six choices are *directions*, and a flat left-to-right strip made the reader decode an
// icon to learn something position could have said outright. Laid out as a cross, `left` IS on the left.
//
// The four directions form the arms; `tab` takes the centre, because "a new tab in this group" is the
// non-directional choice that still lands inside the workbench — the middle of the cross is exactly
// "here". `system` sits in the top-left corner, off the cross, because it is the one choice that leaves
// AgentMux entirely; grouping it with the arms would imply it is another place inside the window.
//
// These coordinates are ONE table, not two, because the grid and the arrow keys must agree: if layout
// said `left` is on the left while the keyboard thought it came after `right`, ArrowLeft would walk the
// wrong way with nothing going red. `nextFocusedDestination` below navigates off this same table, so
// moving a button moves both its pixels and its keyboard neighbours.
const DESTINATION_META = {
  system: { icon: ExternalLink, label: 'Open in system browser', column: 1, row: 1 },
  tab: { icon: SquarePlus, label: 'Open in a new tab', column: 2, row: 2 },
  left: { icon: PanelLeftClose, label: 'Open in a split on the left', column: 1, row: 2 },
  right: { icon: PanelRightClose, label: 'Open in a split on the right', column: 3, row: 2 },
  up: { icon: PanelTopClose, label: 'Open in a split above', column: 2, row: 1 },
  down: { icon: PanelBottomClose, label: 'Open in a split below', column: 2, row: 3 }
} satisfies Record<
  OpenDestination,
  { icon: typeof ExternalLink; label: string; column: number; row: number }
>

// Icons stand in for words in the wordless form, so every button still needs a spoken name (aria-label)
// and a pointer name (title). The order is the enum's order: it is the DOM order, which is what a screen
// reader announces and what Tab would traverse, and it stays derived from the SSOT rather than restated.
// Where each button is *drawn* is a separate question, answered by the grid coordinates above.
export const OPEN_DESTINATION_BAR_ITEMS = OPEN_DESTINATIONS.map((destination) => ({
  destination,
  ...DESTINATION_META[destination]
})) as ReadonlyArray<{
  destination: OpenDestination
  icon: typeof ExternalLink
  label: string
  column: number
  row: number
}>

// Why a precise pane is required, said once so both the disabled buttons' tooltips and the always-on
// hint below the row read the same sentence.
const NEEDS_PANE_REASON = 'A precise pane is required'
const NEEDS_PANE_HINT = 'Choose a precise pane to open beside it.'

// Arrow keys move by GEOMETRY, one step at a time, because the buttons are now arranged in space: from
// `left`, ArrowRight should reach `tab` (the centre) — its neighbour on screen — not `right`, which is
// merely the next entry in the enum. A flat next/previous walk over DOM order would have the cursor
// jumping across the cross, which is the same class of mismatch as an arrow icon pointing the wrong way.
const STEP: Record<'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 }
}

/**
 * The destination one step `key` away from `from`, or null when that step leaves the cluster.
 *
 * Exported and pure so the geometry can be asserted directly: this is the half of the redesign a DOM-free
 * test can interrogate, and it reads the same `DESTINATION_META` the grid does, so a coordinate change
 * cannot move a button's pixels without also moving its keyboard neighbours.
 *
 * Steps scan outward rather than requiring an occupied adjacent cell: the 3×3 grid has empty corners, so
 * ArrowRight from `system` (1,1) must find `up` (2,1) instead of stopping dead at an unoccupied cell.
 * `enabled` is a parameter, not a lookup, because a disabled button must be skipped over — landing focus
 * on one is how a keyboard user gets stranded.
 */
export function nextFocusedDestination(
  from: OpenDestination,
  key: keyof typeof STEP,
  enabled: (destination: OpenDestination) => boolean
): OpenDestination | null {
  const origin = DESTINATION_META[from]
  const { dx, dy } = STEP[key]
  // 3 steps is the grid's width, so this exhausts the row/column without ever wrapping around.
  for (let distance = 1; distance <= 3; distance += 1) {
    const column = origin.column + dx * distance
    const row = origin.row + dy * distance
    const found = OPEN_DESTINATIONS.find((destination) => {
      const meta = DESTINATION_META[destination]
      return meta.column === column && meta.row === row && enabled(destination)
    })
    if (found) return found
  }
  return null
}

const NAV_KEYS = new Set([...Object.keys(STEP), 'Home', 'End'])

// Roving focus for a 2-D cluster: the four arrows walk it by geometry (see nextFocusedDestination), Home
// and End jump to the first and last enabled buttons in DOM order. Done off event.currentTarget instead
// of React state so the cluster stays a pure function — a DOM-free test can call it and read the element
// tree directly. Native <button> already gives Enter/Space; Escape is the popover's job.
function moveClusterFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (!NAV_KEYS.has(event.key)) return
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  )
  if (buttons.length === 0) return
  event.preventDefault()

  const destinationOf = (button: HTMLButtonElement): OpenDestination | null => {
    const value = button.dataset.destination
    return OPEN_DESTINATIONS.find((destination) => destination === value) ?? null
  }

  let target: HTMLButtonElement | undefined
  if (event.key === 'Home') target = buttons[0]
  else if (event.key === 'End') target = buttons[buttons.length - 1]
  else {
    const current = buttons.find((button) => button === document.activeElement)
    const from = current ? destinationOf(current) : null
    // Nothing focused yet (or focus sits on something outside the cluster): an arrow key should still
    // give the keyboard an entry point rather than doing nothing.
    if (!from) target = buttons[0]
    else {
      const enabled = new Set(buttons.map(destinationOf).filter((value) => value !== null))
      const next = nextFocusedDestination(from, event.key as keyof typeof STEP, (destination) =>
        enabled.has(destination)
      )
      // Off the edge of the cluster: hold position rather than wrapping to the far side, which in a
      // spatial arrangement would read as the cursor teleporting.
      target = next
        ? buttons.find((button) => button.dataset.destination === next)
        : (current ?? undefined)
    }
  }
  if (!target) return
  for (const button of buttons) button.tabIndex = button === target ? 0 : -1
  target.focus()
}

/**
 * The universal destination picker: six icon buttons that mean where a link opens (system browser, new
 * tab, and the four split directions), arranged as a cross so the four directional choices are read by
 * position rather than decoded from an icon. No text labels, so accessibility is not optional — every
 * button carries an aria-label and a title. Directional buttons disable when there is no precise pane to
 * split from; the reason travels on each disabled button and, for everyone including keyboard users who
 * cannot focus a disabled control, in the visible hint the popover renders beneath the cluster.
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
      className="open-destination-bar__cluster"
      role="toolbar"
      aria-label="Choose where to open the link"
      onKeyDown={moveClusterFocus}
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
            // Placement rides on the element because it is per-button data, not a style variant: six
            // hand-written CSS rules keyed by data-destination would be a second copy of the coordinate
            // table above, free to drift from the one the arrow keys navigate. The stylesheet declares
            // both properties with a centre-cell default, so its rule is complete without these.
            style={
              { '--destination-column': item.column, '--destination-row': item.row } as React.CSSProperties
            }
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

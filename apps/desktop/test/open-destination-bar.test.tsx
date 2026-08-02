import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  OPEN_DESTINATION_BAR_ITEMS,
  OpenDestinationBar,
  OpenDestinationPopover,
  nextFocusedDestination
} from '../src/renderer/src/components/OpenDestinationBar.js'
import {
  OPEN_DESTINATIONS,
  openDestinationNeedsRegion,
  parseHttpLinkUrl,
  type OpenDestination
} from '../src/renderer/src/lib/open-destination.js'

// The desktop test project has no DOM (no jsdom / testing-library), so behaviour is pinned two ways:
// static markup for what renders, and a walk of the hookless element tree for what a click emits.
// OpenDestinationBar takes no hooks precisely so it can be called as a plain function here.
type ButtonProps = {
  'data-destination'?: OpenDestination
  disabled?: boolean
  'data-disabled-reason'?: string
  onClick?: () => void
}

function collectButtons(node: ReactNode, out: ButtonProps[] = []): ButtonProps[] {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const element = node as ReactElement<{ children?: ReactNode } & ButtonProps>
  if (element.type === 'button') out.push(element.props)
  if (element.props?.children) collectButtons(element.props.children, out)
  return out
}

function renderBarButtons(canSplit: boolean): ButtonProps[] {
  const element = OpenDestinationBar({ canSplit, onSelect: () => {} }) as ReactElement
  return collectButtons(element)
}

describe('OpenDestinationBar', () => {
  it('lays out one icon button per destination in the enum order — no second list of destinations', () => {
    // Order and membership are derived from the SSOT, not restated here.
    expect(OPEN_DESTINATION_BAR_ITEMS.map((item) => item.destination)).toEqual([...OPEN_DESTINATIONS])

    const buttons = renderBarButtons(true)
    expect(buttons).toHaveLength(OPEN_DESTINATIONS.length)
    expect(buttons.map((button) => button['data-destination'])).toEqual([...OPEN_DESTINATIONS])
  })

  it('routes each icon to the destination it draws — the left button opens left, not right', () => {
    // Mutation guard (b): the destination a button emits must equal the one it visibly represents.
    // Wiring 'left' to emit 'right' breaks emitted === data-destination === OPEN_DESTINATIONS[i].
    OPEN_DESTINATIONS.forEach((destination, index) => {
      let emitted: OpenDestination | null = null
      const element = OpenDestinationBar({
        canSplit: true,
        onSelect: (chosen) => {
          emitted = chosen
        }
      }) as ReactElement
      const buttons = collectButtons(element)
      const button = buttons[index]!
      // Anchor: prove we are exercising the button we think we are before trusting its click.
      expect(button['data-destination']).toBe(destination)
      button.onClick?.()
      expect(emitted).toBe(destination)
      expect(emitted).toBe(button['data-destination'])
    })
  })

  it('points every directional chevron at the side its split lands on', () => {
    // The defect this pins was shipped and reported as "the directions are exactly reversed".
    //
    // Behaviour was never wrong: the button emits the destination it draws (pinned above), and the
    // engine puts the new pane on the named side (workbench-view-layout.ts). Only the ICONS lied.
    // lucide's Panel*Open family draws the divider on the right side but aims its chevron the other
    // way, because its subject is "which way a collapsed panel swings open", not "which side the new
    // pane appears on". All four were borrowed for the latter, so all four arrows pointed backwards —
    // which is why it read as a systematic reversal instead of one odd glyph.
    //
    // Asserting the icon NAMES would only pin today's pick: the next swap to a differently-named
    // family could point backwards again and stay green. So this walks the rendered <path> geometry
    // and asserts the chevron's tip sits on the side the destination names. Every lucide chevron is
    // `m<x> <y> …` with three points — the middle one is the tip; the outer two are the tails.
    const AXIS = {
      left: { axis: 'x', tipBeyondTails: false },
      right: { axis: 'x', tipBeyondTails: true },
      up: { axis: 'y', tipBeyondTails: false },
      down: { axis: 'y', tipBeyondTails: true }
    } as const

    for (const [destination, expectation] of Object.entries(AXIS)) {
      const item = OPEN_DESTINATION_BAR_ITEMS.find((candidate) => candidate.destination === destination)
      expect(item, `${destination} vanished from the row`).toBeDefined()
      const Icon = item!.icon
      const markup = renderToStaticMarkup(<Icon />)
      const paths = [...markup.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]!)
      // Premise self-check: the chevron is the relative path (lowercase `m`); the divider is the
      // absolute one (`M`). Without this, a glyph that lost its chevron would make the loop below
      // vacuous instead of red.
      const chevron = paths.find((d) => d.startsWith('m'))
      expect(chevron, `${destination}'s icon has no relative-path chevron to read a direction from`)
        .toBeDefined()

      // Numbers, in order. lucide minifies its paths, so separators are inconsistent: `m16 15-3-3 3-3`
      // packs two negative deltas with no separator at all (the leading `-` does the separating).
      // Match numbers rather than pairs — pairing on a separator misses those and silently reads a
      // 3-point chevron as 2 points.
      const numbers = [...chevron!.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
      // A chevron is three points; anything else means the glyph shape changed and the reading below
      // would be guesswork.
      expect(numbers, `${destination}'s chevron is not the expected 3-point shape`).toHaveLength(6)
      const points = [0, 2, 4].map((index) => ({ x: numbers[index]!, y: numbers[index + 1]! }))
      // lucide relative paths give the first point absolutely, then deltas. Accumulate to absolutes.
      const absolute = points.reduce<{ x: number; y: number }[]>((acc, point, index) => {
        const previous = acc[index - 1]
        acc.push(previous ? { x: previous.x + point.x, y: previous.y + point.y } : point)
        return acc
      }, [])
      const read = (point: { x: number; y: number }): number =>
        expectation.axis === 'x' ? point.x : point.y
      const tip = read(absolute[1]!)
      const tails = [read(absolute[0]!), read(absolute[2]!)]
      // Tails sit on the same side of the tip (that is what makes it a chevron rather than a zigzag),
      // so comparing the tip against either one is enough — assert against both to be explicit.
      for (const tail of tails) {
        expect(
          expectation.tipBeyondTails ? tip > tail : tip < tail,
          `the "${destination}" icon's chevron points the wrong way: tip at ${expectation.axis}=${tip}, ` +
            `tail at ${expectation.axis}=${tail}. A user reads this as the split going the other way.`
        ).toBe(true)
      }
    }
  })

  it('disables only the directional choices when there is no precise pane, and says why', () => {
    // Mutation guard (a): drop the disabling and the directional buttons stop reporting disabled.
    const buttons = renderBarButtons(false)
    const disabled = buttons.filter((button) => button.disabled)
    const directional = OPEN_DESTINATIONS.filter((destination) => openDestinationNeedsRegion(destination))

    expect(disabled.map((button) => button['data-destination'])).toEqual([...directional])
    for (const button of disabled) {
      expect(button['data-disabled-reason']).toBe('A precise pane is required')
    }
    // Anchor: system and tab must stay live, or "only directional" would be vacuously true.
    const live = buttons.filter((button) => !button.disabled).map((button) => button['data-destination'])
    expect(live).toEqual(['system', 'tab'])
  })

  it('opens every direction once a precise pane exists', () => {
    const buttons = renderBarButtons(true)
    expect(buttons.some((button) => button.disabled)).toBe(false)
    expect(buttons.every((button) => button['data-disabled-reason'] === undefined)).toBe(true)
  })

  it('gives every wordless button a spoken name that carries the disabled reason', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationBar canSplit={false} onSelect={() => {}} />
    )
    // A row of icons with no aria-label would be unusable to a screen reader.
    expect(markup.match(/aria-label="/g) ?? []).toHaveLength(OPEN_DESTINATIONS.length + 1)
    expect(markup).toContain('aria-label="Open in a split on the left — A precise pane is required"')
    expect(markup).toContain('role="toolbar"')
  })

  it('seeds roving focus on the first enabled button so the keyboard has an entry point', () => {
    // With directions disabled, focus must start on the first live button, not a dead one.
    const disabledMarkup = renderToStaticMarkup(
      <OpenDestinationBar canSplit={false} onSelect={() => {}} />
    )
    const firstTabbable = /data-destination="([a-z]+)"[^>]*tabindex="0"/.exec(disabledMarkup)?.[1]
    expect(firstTabbable).toBe('system')
    // Exactly one button is in the tab order at a time (roving tabindex).
    expect(disabledMarkup.match(/tabindex="0"/g) ?? []).toHaveLength(1)
  })
})

describe('OpenDestinationBar cluster geometry', () => {
  // The redesign's claim is that position replaces decoding: `left` is drawn on the left. These pin that
  // claim as RELATIONS between coordinates rather than literal cells, so retuning the cluster stays free
  // while a swap — the failure this exists to catch — reddens. `tab` is the centre the arms are read
  // against, which is why it is the reference point rather than a fourth hardcoded number.
  const meta = (destination: OpenDestination) => {
    const item = OPEN_DESTINATION_BAR_ITEMS.find((entry) => entry.destination === destination)
    if (!item) throw new Error(`no bar item for ${destination}`)
    return item
  }

  it('places each direction on the side it names, around the centre', () => {
    const centre = meta('tab')
    // Anchor: the directions are read against the centre, so the centre must actually be interior —
    // otherwise "beyond the centre" could be satisfied by everything sitting in one line.
    expect(centre.column).toBeGreaterThan(meta('left').column)
    expect(centre.column).toBeLessThan(meta('right').column)
    expect(centre.row).toBeGreaterThan(meta('up').row)
    expect(centre.row).toBeLessThan(meta('down').row)
    // left/right must differ only across the horizontal axis, up/down only across the vertical one: a
    // cross, not a diagonal scatter. Without this, `left` could drift up a row and still pass above.
    expect(meta('left').row).toBe(centre.row)
    expect(meta('right').row).toBe(centre.row)
    expect(meta('up').column).toBe(centre.column)
    expect(meta('down').column).toBe(centre.column)
  })

  it('gives every destination its own cell, so no button hides behind another', () => {
    const cells = OPEN_DESTINATION_BAR_ITEMS.map((item) => `${item.column},${item.row}`)
    expect(new Set(cells).size).toBe(OPEN_DESTINATIONS.length)
  })

  it('hands each button its own cell as a custom property, or the grid places nothing', () => {
    // The wiring axis: the coordinate table can be perfect while the element receives none of it, which
    // renders as every button stacked in one cell. Assert the VALUES travel, matched per destination.
    const markup = renderToStaticMarkup(<OpenDestinationBar canSplit onSelect={() => {}} />)
    for (const item of OPEN_DESTINATION_BAR_ITEMS) {
      const button = new RegExp(`<button[^>]*data-destination="${item.destination}"[^>]*>`).exec(markup)?.[0]
      expect(button).toBeDefined()
      expect(button).toContain(`--destination-column:${item.column}`)
      expect(button).toContain(`--destination-row:${item.row}`)
    }
  })

  it('moves focus to the neighbour on screen, not the next entry in the enum', () => {
    const all = () => true
    // From the centre each arrow reaches the arm it points at.
    expect(nextFocusedDestination('tab', 'ArrowLeft', all)).toBe('left')
    expect(nextFocusedDestination('tab', 'ArrowRight', all)).toBe('right')
    expect(nextFocusedDestination('tab', 'ArrowUp', all)).toBe('up')
    expect(nextFocusedDestination('tab', 'ArrowDown', all)).toBe('down')
    // The load-bearing case: `right` follows `left` in the enum, but on screen `tab` sits between them.
    // A flat next/previous walk over DOM order would answer 'right' here.
    expect(nextFocusedDestination('left', 'ArrowRight', all)).toBe('tab')
    // And the scan reaches past an empty cell: nothing occupies (2,1)'s left neighbour column for
    // `system` at (1,1) going right except `up`, which a strict adjacency check would miss.
    expect(nextFocusedDestination('system', 'ArrowRight', all)).toBe('up')
  })

  it('stops at the edge instead of wrapping to the far side', () => {
    // In a spatial arrangement, wrapping reads as the cursor teleporting across the cluster.
    expect(nextFocusedDestination('left', 'ArrowLeft', () => true)).toBeNull()
    expect(nextFocusedDestination('up', 'ArrowUp', () => true)).toBeNull()
  })

  it('skips a disabled destination rather than stranding focus on it', () => {
    // With no precise pane, only system and tab are live: an arrow must never land on a dead button.
    const live = (destination: OpenDestination) => !openDestinationNeedsRegion(destination)
    expect(nextFocusedDestination('tab', 'ArrowLeft', live)).toBeNull()
    expect(nextFocusedDestination('tab', 'ArrowUp', live)).toBeNull()
    // Anchor: the same steps DO find those buttons when they are live, so the nulls above are the
    // disabling at work and not a broken step.
    expect(nextFocusedDestination('tab', 'ArrowLeft', () => true)).toBe('left')
    expect(nextFocusedDestination('tab', 'ArrowUp', () => true)).toBe('up')
  })
})

describe('OpenDestinationPopover', () => {
  it('keeps the URL in view so the choice never loses what it opens', () => {
    // Mutation guard (c): remove the URL display and this disappears while the shell still renders.
    const markup = renderToStaticMarkup(
      <OpenDestinationPopover
        request={{ id: 7, url: 'https://example.com/a/long/path', x: 24, y: 32 }}
        canSplit={false}
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )
    // Anchor: the popover mounted, so a missing URL is a real loss, not a null render.
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('data-state="open"')
    // Pin the URL as *visible* text, not merely present anywhere: it also rides in a title attribute,
    // so a bare toContain(url) would pass with the text gone. Assert it sits between the tags.
    expect(markup).toContain('>https://example.com/a/long/path</span>')
  })

  it('spells out the disabled directions for keyboard users who cannot land on a disabled button', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationPopover
        request={{ id: 8, url: 'https://example.com/', x: 1, y: 2 }}
        canSplit={false}
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(markup).toContain('data-split-destination-explanation')
    expect(markup).toContain('Choose a precise pane to open beside it.')
    // Four directional buttons carry the reason on the button too.
    expect(markup.match(/data-disabled-reason="A precise pane is required"/g) ?? []).toHaveLength(4)
  })

  it('drops the explanation once every direction is available', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationPopover
        request={{ id: 9, url: 'https://example.com/', x: 0, y: 0 }}
        canSplit
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(markup).not.toContain('data-split-destination-explanation')
    expect(markup).not.toContain('data-disabled-reason')
  })

  it('renders nothing without a request, so a dismissed popover leaves no stale row', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationPopover
        request={null}
        canSplit
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(markup).toBe('')
  })
})

describe('parseHttpLinkUrl', () => {
  // The one scheme gate both link surfaces share. It is what keeps the Terminal and the conversation
  // from drifting into treating a scheme differently, so its acceptance/refusal set is pinned here.
  it('normalises an http(s) URL and refuses every other scheme', () => {
    expect(parseHttpLinkUrl('https://example.com/docs')).toBe('https://example.com/docs')
    // A bare host+port normalises with the trailing slash the URL parser adds — the SAME normalisation
    // the openable surfaces then act on, so callers compare against a canonical form, not the raw text.
    expect(parseHttpLinkUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    // The refused set: opaque, file, and script schemes an agent can emit. Each returns null so no
    // surface can turn it into something a click opens.
    expect(parseHttpLinkUrl('mailto:alice@example.com')).toBeNull()
    expect(parseHttpLinkUrl('file:///etc/passwd')).toBeNull()
    expect(parseHttpLinkUrl('javascript:alert(1)')).toBeNull()
    expect(parseHttpLinkUrl('vscode://file/etc/hosts')).toBeNull()
    // Not a URL at all: never throws, just declines.
    expect(parseHttpLinkUrl('not a URL')).toBeNull()
  })
})

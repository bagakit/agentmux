import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  OPEN_DESTINATION_BAR_ITEMS,
  OpenDestinationBar,
  OpenDestinationPopover
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

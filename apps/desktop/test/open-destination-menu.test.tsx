import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  openChanges: [] as Array<(open: boolean) => void>,
  selections: new Map<string, () => void>()
}))

vi.mock('@radix-ui/react-dropdown-menu', async () => {
  const React = await import('react')
  const element = (tag: string) => ({ children, ...props }: Record<string, unknown>) =>
    React.createElement(tag, props, children as React.ReactNode)

  return {
    Root: ({ children, onOpenChange }: {
      children: React.ReactNode
      onOpenChange(open: boolean): void
    }) => {
      fixture.openChanges.push(onOpenChange)
      return children
    },
    Trigger: ({ children }: { children: React.ReactNode }) => children,
    Portal: ({ children }: { children: React.ReactNode }) => children,
    Content: ({
      children,
      sideOffset: _sideOffset,
      collisionPadding: _collisionPadding,
      onCloseAutoFocus: _onCloseAutoFocus,
      ...props
    }: Record<string, unknown>) => React.createElement('div', props, children as React.ReactNode),
    Label: element('div'),
    Separator: element('hr'),
    Item: ({ children, onSelect, ...props }: {
      children: React.ReactNode
      onSelect(): void
      'data-destination': string
    }) => {
      fixture.selections.set(props['data-destination'], onSelect)
      return React.createElement('button', props, children)
    }
  }
})

import {
  OPEN_DESTINATION_MENU_ITEMS,
  OpenDestinationMenu,
  OpenDestinationPreview
} from '../src/renderer/src/components/OpenDestinationMenu.js'
import { openDestinationNeedsRegion } from '../src/renderer/src/lib/open-destination.js'

beforeEach(() => {
  fixture.openChanges = []
  fixture.selections.clear()
})

describe('OpenDestinationMenu', () => {
  it('publishes all six destinations in stable order with owner-derived split requirements', () => {
    expect(OPEN_DESTINATION_MENU_ITEMS.map((item) => item.destination)).toEqual([
      'system',
      'tab',
      'left',
      'right',
      'up',
      'down'
    ])
    expect(OPEN_DESTINATION_MENU_ITEMS.map((item) => openDestinationNeedsRegion(item.destination))).toEqual([
      false,
      false,
      true,
      true,
      true,
      true
    ])
  })

  it('renders an explicit pane-layout preview for every directional destination', () => {
    for (const destination of ['left', 'right', 'up', 'down'] as const) {
      const markup = renderToStaticMarkup(<OpenDestinationPreview destination={destination} />)
      expect(markup).toContain(`data-open-destination-preview="${destination}"`)
      expect(markup).toContain(`data-active-pane="${destination}"`)
      expect(markup).toContain('aria-hidden="true"')
    }
  })

  it('keeps system and Tab available while explaining disabled directional choices', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationMenu
        request={{ id: 7, url: 'https://example.com/a/long/path', x: 24, y: 32 }}
        canSplit={false}
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )

    expect(markup).toContain('https://example.com/a/long/path')
    expect(markup).toContain('data-destination="system"')
    expect(markup).toContain('data-destination="tab"')
    expect(markup).not.toMatch(/data-destination="(?:system|tab)"[^>]*disabled/)
    expect(markup.match(/data-disabled-reason="A precise pane is required"/g)).toHaveLength(4)
    expect(markup).toContain('Choose a precise pane to open beside it.')
  })

  it('enables all directional choices when the request has an exact pane', () => {
    const markup = renderToStaticMarkup(
      <OpenDestinationMenu
        request={{ id: 8, url: 'https://example.com/', x: 10, y: 11 }}
        canSplit
        onSelect={() => {}}
        onDismiss={() => {}}
      />
    )

    expect(markup).not.toContain('data-disabled-reason')
    expect(markup).not.toContain('data-split-destination-explanation')
    expect(markup.match(/data-open-destination-preview=/g)).toHaveLength(4)
  })

  it('returns captured request identities so the controller can fence a stale close', () => {
    const dismissed: number[] = []
    const OpenDestinationMenuHarness = ({ requestId }: { requestId: number }) => (
      <OpenDestinationMenu
        request={{ id: requestId, url: `https://${requestId}.example/`, x: 1, y: 2 }}
        canSplit
        onSelect={() => {}}
        onDismiss={(id) => dismissed.push(id)}
      />
    )
    renderToStaticMarkup(<OpenDestinationMenuHarness requestId={41} />)
    renderToStaticMarkup(<OpenDestinationMenuHarness requestId={42} />)

    fixture.openChanges[0]?.(false)
    fixture.openChanges[1]?.(false)
    expect(dismissed).toEqual([41, 42])
  })

  it('projects every selection through the destination enum', () => {
    const selected: string[] = []
    renderToStaticMarkup(
      <OpenDestinationMenu
        request={{ id: 9, url: 'https://example.com/', x: 0, y: 0 }}
        canSplit
        onSelect={(destination) => selected.push(destination)}
        onDismiss={() => {}}
      />
    )

    for (const item of OPEN_DESTINATION_MENU_ITEMS) fixture.selections.get(item.destination)?.()
    expect(selected).toEqual(OPEN_DESTINATION_MENU_ITEMS.map((item) => item.destination))
  })
})

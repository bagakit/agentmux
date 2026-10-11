// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { OpenDestinationBar, OpenDestinationPopover } from '../src/renderer/src/components/OpenDestinationBar.js'
import { OPEN_DESTINATIONS, openDestinationNeedsRegion, type OpenDestination } from '../src/renderer/src/lib/open-destination.js'
import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'

let container: HTMLDivElement
let root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.unstubAllGlobals()
})
async function render(content: ReactNode) { await act(async () => root.render(content)) }
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button[data-destination]')]
const button = (destination: OpenDestination) => document.querySelector<HTMLButtonElement>(`button[data-destination="${destination}"]`)!
const row = (name: string) => document.querySelector<HTMLElement>(`.workbench-menu-row[role="group"][aria-label="${name}"]`)!
const rowLabel = (name: string) => row(name).querySelector('.workbench-menu-row__label-text')!
async function focus(target: HTMLElement) { await act(async () => target.focus()) }
async function key(target: Element, value: string, isComposing = false) {
  const event = new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true })
  await act(async () => { target.dispatchEvent(event) })
  return event
}
async function pointer(target: Element, type: string, relatedTarget: EventTarget | null = null) {
  await act(async () => { target.dispatchEvent(new PointerEvent(type, { pointerType: 'mouse', relatedTarget, bubbles: true })) })
}
async function click(target: HTMLElement) { await act(async () => target.click()) }

// The original destination adapter and shared row surface are mounted together. These
// assertions follow rendered command identity and behavior, not a second coordinate table.
describe('OpenDestinationBar', () => {
  it('renders all original destinations in two stable named rows with shared direction glyphs', async () => {
    await render(<OpenDestinationBar canSplit onSelect={vi.fn()} />)
    expect(document.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Choose where to open the link')
    expect(buttons().map(item => item.dataset.destination)).toEqual([...OPEN_DESTINATIONS])
    expect([...document.querySelectorAll('.workbench-menu-row')].map(group => group.getAttribute('aria-label'))).toEqual(['Open in', 'New region'])
    expect(rowLabel('Open in').textContent).toBe('Open in'); expect(rowLabel('New region').textContent).toBe('New region')
    expect([...row('Open in').querySelectorAll<HTMLButtonElement>('button')].map(item => item.dataset.destination)).toEqual(['system', 'tab'])
    expect([...row('New region').querySelectorAll<HTMLButtonElement>('button')].map(item => item.dataset.destination)).toEqual(OPEN_DESTINATIONS.filter(openDestinationNeedsRegion))
    for (const destination of OPEN_DESTINATIONS) {
      const glyph = button(destination).querySelector('svg')!
      expect(glyph.getAttribute('width')).toBe('16'); expect(glyph.getAttribute('height')).toBe('16')
      expect(button(destination).getAttribute('aria-label')).toBeTruthy()
      if (openDestinationNeedsRegion(destination)) expect(glyph.dataset.semanticIcon).toBe(`layout.split-${destination}`)
    }
    expect(document.querySelector('.workbench-layout-menu__hint, .workbench-layout-menu footer')).toBeNull()
  })

  it('routes each original rendered button to its exact destination once', async () => {
    const select = vi.fn()
    await render(<OpenDestinationBar canSplit onSelect={select} />)
    expect(buttons()).toHaveLength(OPEN_DESTINATIONS.length)
    for (const destination of OPEN_DESTINATIONS) {
      await click(button(destination))
      expect(select).toHaveBeenLastCalledWith(destination)
    }
    expect(select.mock.calls.map(call => call[0])).toEqual([...OPEN_DESTINATIONS])
  })

  it('disables only directions without a precise pane, keeps both other exits and explains why', async () => {
    const select = vi.fn()
    await render(<OpenDestinationBar canSplit={false} onSelect={select} />)
    expect(buttons()).toHaveLength(OPEN_DESTINATIONS.length)
    expect(buttons().filter(item => item.disabled).map(item => item.dataset.destination)).toEqual(OPEN_DESTINATIONS.filter(openDestinationNeedsRegion))
    for (const destination of OPEN_DESTINATIONS.filter(openDestinationNeedsRegion)) {
      expect(button(destination).dataset.disabledReason).toBe('A precise pane is required')
      expect(button(destination).getAttribute('aria-label')).toContain('A precise pane is required')
      await click(button(destination))
    }
    expect(select).not.toHaveBeenCalled()
    expect(buttons().filter(item => !item.disabled).map(item => item.dataset.destination)).toEqual(['system', 'tab'])
    expect(buttons().filter(item => item.tabIndex === 0).map(item => item.dataset.destination)).toEqual(['system'])
  })

  it('retains the allowed destination subset and its original accessible context', async () => {
    const select = vi.fn()
    await render(<OpenDestinationBar canSplit allowedDestinations={['tab', 'left', 'right', 'up', 'down']}
      accessibleContext="Choose where to fork the current conversation" onSelect={select} />)
    expect(document.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Choose where to fork the current conversation')
    expect(buttons().map(item => item.dataset.destination)).toEqual(['tab', 'left', 'right', 'up', 'down'])
    expect(button('system')).toBeNull()
    expect(buttons().filter(item => item.tabIndex === 0).map(item => item.dataset.destination)).toEqual(['tab'])
    await click(button('right')); expect(select).toHaveBeenCalledExactlyOnceWith('right')
  })

  it('navigates the actual row peers and corresponding enabled cross-row position', async () => {
    const select = vi.fn()
    await render(<OpenDestinationBar canSplit onSelect={select} />)
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')!
    await focus(toolbar); await key(toolbar, 'End'); expect(document.activeElement).toBe(button('down'))
    await key(button('down'), 'Home'); expect(document.activeElement).toBe(button('system'))
    for (const [value, expected] of [['ArrowRight', 'tab'], ['ArrowDown', 'right'], ['ArrowRight', 'up'], ['ArrowUp', 'tab'], ['ArrowDown', 'right'], ['ArrowLeft', 'left'], ['ArrowUp', 'system']] as const) {
      await key(document.activeElement!, value)
      expect(document.activeElement).toBe(button(expected))
      expect(buttons().filter(item => item.tabIndex === 0)).toEqual([button(expected)])
    }
    await key(button('system'), 'ArrowLeft'); expect(document.activeElement).toBe(button('system'))
    await key(button('system'), 'End'); expect(document.activeElement).toBe(button('down'))
    await key(button('down'), 'Home'); expect(document.activeElement).toBe(button('system'))
    expect(select).not.toHaveBeenCalled()
  })

  it('skips an unavailable direction row and leaves IME-owned navigation untouched', async () => {
    const select = vi.fn()
    await render(<OpenDestinationBar canSplit={false} onSelect={select} />)
    await focus(button('tab'))
    await key(button('tab'), 'ArrowDown'); expect(document.activeElement).toBe(button('tab'))
    const event = await key(button('tab'), 'ArrowLeft', true)
    expect(event.defaultPrevented).toBe(false); expect(document.activeElement).toBe(button('tab'))
    await key(button('tab'), 'ArrowLeft'); expect(document.activeElement).toBe(button('system'))
    expect(select).not.toHaveBeenCalled()
  })

  it('shows full names in the shared row slot without moving editor focus and keeps keyboard focus above hover', async () => {
    await render(<><input aria-label="Original editor" /><OpenDestinationBar canSplit onSelect={vi.fn()} /></>)
    const editor = container.querySelector('input')!
    await focus(editor); await pointer(button('down'), 'pointermove')
    expect(rowLabel('New region').textContent).toBe('Open in a split below')
    expect(document.activeElement).toBe(editor)
    await focus(button('left')); await pointer(button('down'), 'pointermove')
    expect(rowLabel('New region').textContent).toBe('Open in a split on the left')
    expect(row('New region').getAttribute('aria-label')).toBe('New region')
    expect(button('left').getAttribute('aria-label')).toBe('Open in a split on the left')
    await pointer(row('New region'), 'pointerout', editor); await focus(editor)
    expect(rowLabel('New region').textContent).toBe('New region')
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})

describe('OpenDestinationPopover', () => {
  const request = { id: 7, url: 'https://example.test/a/long/path?q=source#part', x: 24, y: 32 }
  it('keeps the real URL readable and expands it through a keyboard-reachable non-destination control', async () => {
    const select = vi.fn(), dismiss = vi.fn()
    await render(<OpenDestinationPopover request={request} canSplit onSelect={select} onDismiss={dismiss} />)
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Choose where to open the link')
    const target = document.querySelector<HTMLButtonElement>('[aria-label="Show full link target"]')!
    expect(target.textContent).toBe(request.url); expect(target.getAttribute('aria-expanded')).toBe('false')
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(document.activeElement).toBe(toolbar)
    await key(toolbar, 'ArrowRight'); expect(document.activeElement).toBe(button('system'))
    await focus(target); await click(target)
    expect(target.getAttribute('aria-expanded')).toBe('true'); expect(target.getAttribute('aria-label')).toBe('Collapse link target')
    expect(target.textContent).toBe(request.url); expect(select).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled()
    await click(target); expect(target.getAttribute('aria-expanded')).toBe('false')
  })

  it('explains unavailable directions outside their disabled controls and removes the explanation when addressable', async () => {
    const props = { request, onSelect: vi.fn(), onDismiss: vi.fn() }
    await render(<OpenDestinationPopover {...props} canSplit={false} />)
    expect(document.querySelector('[data-split-destination-explanation]')?.textContent).toBe('Choose a precise pane to open beside it.')
    expect(buttons().filter(item => item.disabled)).toHaveLength(4)
    await render(<OpenDestinationPopover {...props} canSplit />)
    expect(document.querySelector('[data-split-destination-explanation]')).toBeNull()
    expect(buttons().some(item => item.disabled)).toBe(false)
  })

  it('dismisses the exact current request with Escape or outside press and leaves no stale surface', async () => {
    const dismiss = vi.fn(), select = vi.fn()
    await render(<OpenDestinationPopover request={request} canSplit onSelect={select} onDismiss={dismiss} />)
    await key(button('system'), 'Escape'); expect(dismiss).toHaveBeenCalledExactlyOnceWith(request.id)
    dismiss.mockClear()
    const newer = { ...request, id: request.id + 1, url: 'https://example.test/new-target' }
    await render(<OpenDestinationPopover request={newer} canSplit onSelect={select} onDismiss={dismiss} />)
    await pointer(container, 'pointerdown'); expect(dismiss).toHaveBeenCalledExactlyOnceWith(newer.id)
    expect(select).not.toHaveBeenCalled()
    await render(<OpenDestinationPopover request={null} canSplit onSelect={select} onDismiss={dismiss} />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('restores the original invoker after React removes the chooser without taking later outside focus', async () => {
    function Scene() {
      const [pending, setPending] = useState<typeof request | null>(null)
      return <><button onClick={() => setPending(request)}>Original link</button><input aria-label="Later editor" />
        <OpenDestinationPopover request={pending} canSplit onSelect={vi.fn()} onDismiss={() => setPending(null)} /></>
    }
    await render(<Scene />)
    const invoker = container.querySelector<HTMLButtonElement>('button')!
    const editor = container.querySelector<HTMLInputElement>('input')!
    await focus(invoker); await click(invoker)
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(document.activeElement).toBe(toolbar)
    await key(toolbar, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(invoker)
    await click(invoker); await focus(editor)
    await key(editor, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(editor)
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

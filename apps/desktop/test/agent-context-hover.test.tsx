// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { useAppStore } from '../src/renderer/src/store'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const usage = { inputTokens: 230, outputTokens: 20, totalTokens: 250, observedAt: fixtureEpoch(1), context: { usedTokens: 250, capacityTokens: 1000 } }
const chip = () => host.querySelector<HTMLButtonElement>('.composer__context')!
const card = () => host.querySelector<HTMLDivElement>('.composer__context-card')!
const isOpen = () => card().hasAttribute('data-test-native-open')
function native() {
  const node = card(), matches = node.matches.bind(node)
  const toggle = (state: 'open' | 'closed') => { if (state === 'open') node.setAttribute('data-test-native-open', ''); else node.removeAttribute('data-test-native-open'); const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: state }); node.dispatchEvent(event) }
  const show = vi.fn(function (this: HTMLElement, options: { source: HTMLElement }) { expect(this).toBe(node); expect(options.source).toBe(chip()); toggle('open') })
  const hide = vi.fn(() => toggle('closed'))
  Object.defineProperties(node, { showPopover: { configurable: true, value: show }, hidePopover: { configurable: true, value: hide }, matches: { configurable: true, value: (selector: string) => selector === ':popover-open' ? isOpen() : matches(selector) } })
  return { show, hide, toggle }
}
async function render(content: ReactNode = <AgentContextUsage source="session/A/run" usage={usage} />) { await act(async () => root.render(content)) }
async function pointer(node: HTMLElement, type: string, pointerType = 'mouse', buttons = 0) {
  await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, buttons })))
}
function props(node: HTMLElement) { const key = Object.keys(node).find(key => key.startsWith('__reactProps$'))!; return (node as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]! }
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); useAppStore.setState({ nativeSurfaceOverlayCount: 0 }) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); window.getSelection()?.removeAllRanges() })

it('opens a passive native hover reader from the exact chip without changing input focus', async () => {
  await render(); const { show } = native(), input = document.createElement('textarea'); host.append(input); input.value = 'Keep this draft'; input.focus()
  await pointer(chip(), 'pointerover')
  expect(show).toHaveBeenCalledOnce(); expect(isOpen()).toBe(true); expect(document.activeElement).toBe(input); expect(input.value).toBe('Keep this draft')
  expect(chip().getAttribute('aria-expanded')).toBe('true'); expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)
  expect(card().textContent).toContain('25% used'); expect(card().textContent).toContain('75% remaining'); expect(card().textContent).toContain('750 remaining')
  expect([...card().querySelectorAll('dd')].map(node => node.textContent)).toEqual(['230', '20', '250'])
  expect(card().textContent).toContain('not a breakdown of the context window')
})

it('allows crossing the gap into the reader and closes only a departed preview', async () => {
  await render(); const { hide } = native(); await pointer(chip(), 'pointerover'); await pointer(chip(), 'pointerout')
  await act(async () => vi.advanceTimersByTime(100)); await pointer(card(), 'pointerover'); await act(async () => vi.advanceTimersByTime(200))
  expect(isOpen()).toBe(true); expect(hide).not.toHaveBeenCalled()
  await pointer(card(), 'pointerout'); await act(async () => vi.advanceTimersByTime(180))
  expect(isOpen()).toBe(false); expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
})

it('promotes a hover click to explicit reading and leaves the next native toggle available', async () => {
  await render(); native(); await pointer(chip(), 'pointerover')
  const first = new MouseEvent('click', { bubbles: true, cancelable: true }); await act(async () => chip().dispatchEvent(first))
  expect(first.defaultPrevented).toBe(true); await pointer(chip(), 'pointerout'); await act(async () => vi.advanceTimersByTime(200)); expect(isOpen()).toBe(true)
  const next = new MouseEvent('click', { bubbles: true, cancelable: true }); await act(async () => chip().dispatchEvent(next)); expect(next.defaultPrevented).toBe(false)
})

it('allows the first explicit activation after a native preview close', async () => {
  await render(); const { hide } = native(); await pointer(chip(), 'pointerover')
  await act(async () => hide())
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => chip().dispatchEvent(click))
  expect(click.defaultPrevented).toBe(false)
})

it('rejects retained leave and card-enter handlers before they can alter the new source timer', async () => {
  await render(); native(); await pointer(chip(), 'pointerover')
  const leave = props(chip()).onPointerLeave!, enter = props(card()).onPointerEnter!
  await render(<AgentContextUsage source="B/run" usage={usage} />)
  await pointer(chip(), 'pointerover'); await pointer(chip(), 'pointerout')
  await act(async () => { leave({ pointerType: 'mouse' }); enter({ pointerType: 'mouse' }); vi.advanceTimersByTime(180) })
  expect(isOpen()).toBe(false)
})

it('keeps explicitly read or selected panel text open after pointer departure', async () => {
  await render(); native(); await pointer(chip(), 'pointerover'); await pointer(card(), 'pointerdown')
  await pointer(card(), 'pointerout'); await act(async () => vi.advanceTimersByTime(200)); expect(isOpen()).toBe(true)
})

it('does not use hover for touch, pen or pressed mouse and preserves explicit native activation', async () => {
  await render(); const { show } = native()
  for (const [type, buttons] of [['touch', 0], ['pen', 0], ['mouse', 1]] as const) await pointer(chip(), 'pointerover', type, buttons)
  expect(show).not.toHaveBeenCalled(); expect(chip().getAttribute('popovertarget')).toBe(card().id)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true }); await act(async () => chip().dispatchEvent(click)); expect(click.defaultPrevented).toBe(false)
})

it('dismisses passive Escape while leaving the focused input and IME cancellation with their owner', async () => {
  await render(); const { hide } = native(); await pointer(chip(), 'pointerover')
  const composing = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }); await act(async () => document.dispatchEvent(composing)); expect(hide).not.toHaveBeenCalled()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); await act(async () => document.dispatchEvent(escape)); expect(isOpen()).toBe(false); expect(escape.defaultPrevented).toBe(false)
})

it('preserves native panel and reading nodes across same-source compaction and marks missing context honestly', async () => {
  await render(); native(); await pointer(chip(), 'pointerover'); const original = card(), heading = card().querySelector('h3')!
  const range = document.createRange(); range.selectNodeContents(heading); window.getSelection()!.addRange(range)
  await render(<AgentContextUsage source="session/A/run" usage={{ ...usage, context: { usedTokens: 100, capacityTokens: 1000 } }} />)
  expect(card()).toBe(original); expect(isOpen()).toBe(true); expect(card().textContent).toContain('10% used'); expect(window.getSelection()!.toString()).toBe('Context window')
  const { context: _context, ...unreported } = usage
  await render(<AgentContextUsage source="session/A/run" usage={unreported} />)
  expect(card()).toBe(original); expect(isOpen()).toBe(true); expect(chip().textContent).toContain('—'); expect(card().textContent).toContain('Unavailable'); expect(card().textContent).not.toContain('% remaining')
})

it('closes on the first frame of another Session or Run and rejects the old hover and timer', async () => {
  const frames: boolean[] = []
  function Observed({ source }: { source: string }) { useLayoutEffect(() => { frames.push(isOpen()) }, [source]); return <AgentContextUsage source={source} usage={usage} /> }
  await render(<Observed source="A/run1" />); const { show } = native(); await pointer(chip(), 'pointerover'); const old = props(chip()).onPointerEnter!
  await pointer(chip(), 'pointerout'); await render(<Observed source="A/run2" />)
  expect(frames.at(-1)).toBe(false); expect(chip().getAttribute('aria-expanded')).toBe('false')
  await act(async () => old({ pointerType: 'mouse', buttons: 0 })); expect(show).toHaveBeenCalledTimes(1)
  await pointer(chip(), 'pointerover'); await act(async () => vi.advanceTimersByTime(200)); expect(isOpen()).toBe(true)
  await render(<Observed source="B/run2" />); expect(frames.at(-1)).toBe(false)
})

it('releases the overlay and cannot open from an unmounted retained handler', async () => {
  await render(); const { show } = native(); await pointer(chip(), 'pointerover'); const old = props(chip()).onPointerEnter!
  await render(null); await act(async () => old({ pointerType: 'mouse', buttons: 0 })); expect(show).toHaveBeenCalledTimes(1); expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
})

it('gives each chip and panel its own anchor in a multi-Agent workface', async () => {
  await render(<><AgentContextUsage source="A" usage={usage} /><AgentContextUsage source="B" usage={usage} /></>)
  const chips = [...host.querySelectorAll<HTMLButtonElement>('.composer__context')], cards = [...host.querySelectorAll<HTMLDivElement>('.composer__context-card')]
  expect(chips[0]!.style.anchorName).not.toBe(chips[1]!.style.anchorName)
  for (let i = 0; i < 2; i++) expect(cards[i]!.style.positionAnchor).toBe(chips[i]!.style.anchorName)
})

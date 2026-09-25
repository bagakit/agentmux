// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalReplayGapNotice } from '../src/renderer/src/components/TerminalReplayGapNotice'
import { useAppStore } from '../src/renderer/src/store'

let root: Root, container: HTMLDivElement
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true) })
const trigger = () => container.querySelector<HTMLButtonElement>('.service-disclosure__trigger')!
async function toggle(newState: 'open' | 'closed') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState })
  await act(async () => container.querySelector('[popover]')!.dispatchEvent(event))
}
async function collapse() {
  await act(async () => container.querySelector<HTMLButtonElement>('.service-disclosure__details .service-disclosure__close')!.click())
}
async function mount(canRedraw: boolean, onRedraw: () => Promise<boolean>, scope = 'terminal:gap:run') {
  await act(async () => root.render(createElement(TerminalReplayGapNotice, { scope, canRedraw, onRedraw })))
}

describe('TerminalReplayGapNotice', () => {
  it('keeps a historical Run read-only while allowing collapse and review of the unchanged gap', async () => {
    const redraw = vi.fn(async () => true)
    await mount(false, redraw)
    expect(container.textContent).toContain('Earlier scrollback is unavailable')
    expect(container.querySelector('[aria-label="Redraw current terminal screen"]')).toBeNull()
    await toggle('open'); expect(trigger().getAttribute('aria-expanded')).toBe('true')
    await collapse()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.service-disclosure__summary')).toBeNull()
    expect(container.textContent).toContain('cannot restore missing history')
    await toggle('open'); expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.service-window__restore')!.textContent).toContain('cannot restore missing history')
    expect(redraw).not.toHaveBeenCalled()
  })

  it.each(['failed', 'unavailable', 'requested'] as const)('has an independent exit after redraw is %s', async state => {
    const redraw = vi.fn(async () => { if (state === 'failed') throw new Error('Private redraw failure'); return state === 'requested' })
    await mount(true, redraw); await toggle('open')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Redraw current terminal screen"]')!.click())
    expect(redraw).toHaveBeenCalledOnce()
    expect(container.textContent).toContain(state === 'failed' ? 'Private redraw failure' : state === 'unavailable' ? 'Screen redraw unavailable' : 'Screen redraw requested')
    await collapse(); expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.service-disclosure__summary')).toBeNull()
    await toggle('open'); expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('cannot restore missing history')
    expect(redraw).toHaveBeenCalledOnce()
  })

  it('retains collapse through remounts but isolates a new Run', async () => {
    const redraw = vi.fn(async () => true)
    await mount(false, redraw); await collapse()
    await act(async () => root.render(null)); await mount(false, redraw)
    expect(container.querySelector('.service-disclosure__summary')).toBeNull()
    await mount(false, redraw, 'terminal:gap:new-run')
    expect(container.querySelector('.service-disclosure__summary')!.textContent).toBe('Earlier scrollback is unavailable')
    expect(redraw).not.toHaveBeenCalled()
  })
})

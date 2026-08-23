// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampDefaultSessionFloatingState,
  requestDefaultSessionFloatingClose,
  requestDefaultSessionFloatingOpen,
  useDefaultSessionFloatingState
} from '../src/renderer/src/lib/default-session-floating.js'

function Harness() {
  const [state] = useDefaultSessionFloatingState()
  return createElement('div', null,
    createElement('button', { id: 'trigger' }, 'trigger'),
    createElement('div', { id: 'floating-panel', 'data-default-session-floating': true, tabIndex: -1 }),
    createElement('output', { 'data-open': String(state.open), 'data-maximized': String(state.maximized) })
  )
}

describe('Default Session floating workspace state', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    window.localStorage.clear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('clamps the persisted Orca-style window inside the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
    const next = clampDefaultSessionFloatingState({ open: true, maximized: false, position: { left: 880, top: 680 }, size: { width: 900, height: 700 } })
    expect(next.size).toEqual({ width: 868, height: 652 })
    expect(next.position).toEqual({ left: 16, top: 32 })
  })

  it('persists one open state and returns focus to the launcher after close', async () => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('#trigger') as HTMLButtonElement
    trigger.focus()
    await act(async () => requestDefaultSessionFloatingOpen())
    expect(container.querySelector('output')?.dataset.open).toBe('true')
    expect(window.localStorage.getItem('agentmux.default-session-floating.v2')).toContain('"open":true')
    trigger.focus()
    await act(async () => requestDefaultSessionFloatingOpen())
    expect(document.activeElement).toBe(container.querySelector('#floating-panel'))
    await act(async () => requestDefaultSessionFloatingClose())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.querySelector('output')?.dataset.open).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(window.localStorage.getItem('agentmux.default-session-floating.v2')).toContain('"open":false')
  })
})

// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampPmoTeamsTopicFloatingState,
  requestPmoTeamsTopicFloatingClose,
  requestPmoTeamsTopicFloatingOpen,
  usePmoTeamsTopicFloatingState
} from '../src/renderer/src/lib/pmo-teams-topic-floating.js'

function Harness() {
  const [state] = usePmoTeamsTopicFloatingState()
  return createElement('div', null,
    createElement('button', { id: 'trigger' }, 'trigger'),
    createElement('div', { id: 'floating-panel', 'data-pmo-teams-topic-floating': true, tabIndex: -1 }),
    createElement('output', { 'data-open': String(state.open), 'data-placement': state.launcherPlacement, 'data-anchor': state.openAnchor ?? '' })
  )
}

describe('PMO teams topic floating workspace state', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    window.localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('clamps both the persisted window and draggable launcher inside the viewport', () => {
    const next = clampPmoTeamsTopicFloatingState({
      open: true,
      maximized: false,
      position: { left: 880, top: 680 },
      size: { width: 900, height: 700 },
      launcherPlacement: 'floating',
      launcherPosition: { left: 880, top: 680 }
    })
    expect(next.size).toEqual({ width: 868, height: 652 })
    expect(next.position).toEqual({ left: 16, top: 32 })
    expect(next.launcherPosition).toEqual({ left: 848, top: 648 })
  })

  it('persists placement and open state, and returns focus to the launcher after close', async () => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('#trigger') as HTMLButtonElement
    trigger.focus()
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    expect(container.querySelector('output')?.dataset.open).toBe('true')
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":true')
    await act(async () => window.dispatchEvent(new CustomEvent('agentmux:pmo-teams-topic-floating', { detail: { launcherPlacement: 'compact' } })))
    expect(container.querySelector('output')?.dataset.placement).toBe('compact')
    trigger.focus()
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    expect(document.activeElement).toBe(container.querySelector('#floating-panel'))
    await act(async () => requestPmoTeamsTopicFloatingClose())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.querySelector('output')?.dataset.open).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":false')
  })

  it('carries the compact launcher anchor with the open request', async () => {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ anchor: 'compact' }))
    expect(container.querySelector('output')?.dataset.anchor).toBe('compact')
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"openAnchor":"compact"')
  })
})

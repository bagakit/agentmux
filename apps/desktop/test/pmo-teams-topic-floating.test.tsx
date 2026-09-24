// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestPmoTeamsTopicFloatingClose,
  requestPmoTeamsTopicFloatingOpen,
  usePmoTeamsTopicFloatingState
} from '../src/renderer/src/lib/pmo-teams-topic-floating.js'

function Harness() {
  const [state] = usePmoTeamsTopicFloatingState()
  return createElement('div', null,
    createElement('button', { id: 'trigger' }, 'trigger'),
    createElement('div', { id: 'floating-panel', 'data-pmo-teams-topic-floating': true, tabIndex: -1 }),
    createElement('output', { 'data-open': String(state.open), 'data-preview': String(state.preview), 'data-keys': Object.keys(state).sort().join(','), 'data-target': state.targetTabId ?? '' })
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

  it('persists pinned open state, and returns focus to the launcher after close', async () => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('#trigger') as HTMLButtonElement
    trigger.focus()
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(container.querySelector('output')?.dataset.open).toBe('true')
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":true')
    trigger.focus()
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(document.activeElement).toBe(container.querySelector('#floating-panel'))
    await act(async () => requestPmoTeamsTopicFloatingClose())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(container.querySelector('output')?.dataset.open).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":false')
  })

  it('keeps its target across closing and untargeted opens while explicit context choices replace it', async () => {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: 'pmo-demand-one' }))
    expect(container.querySelector('output')?.dataset.target).toBe('pmo-demand-one')
    await act(async () => requestPmoTeamsTopicFloatingOpen())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(container.querySelector('output')?.dataset.target).toBe('pmo-demand-one')
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: 'pmo-demand-two' }))
    expect(container.querySelector('output')?.dataset.target).toBe('pmo-demand-two')
    await act(async () => requestPmoTeamsTopicFloatingClose())
    expect(container.querySelector('output')?.dataset.target).toBe('pmo-demand-two')
  })

  it('restores the selected target with only the current state fields', async () => {
    window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: true, targetTabId: 'pmo-demand-one',
      targetTopicId: 'launcher:analyst' }))
    await act(async () => root.render(createElement(Harness)))
    const output = container.querySelector('output')!
    expect(output.dataset.target).toBe('pmo-demand-one')
    expect(output.dataset.preview).toBe('false')
    expect(output.dataset.keys).toBe('open,preview,targetTabId,targetTopicId')
  })
})

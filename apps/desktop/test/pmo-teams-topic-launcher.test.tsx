// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../src/renderer/src/store.js'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry.js'
const baseline = useAppStore.getState()

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  useAppStore.setState({ tabs: {}, layouts: {}, sessions: [], timelines: {}, agentNames: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
  useAppStore.setState(baseline, true)
})

describe('PMO teams topic launcher', () => {
  it('renders one bottom entry and opens the fixed Topic', async () => {
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    const button = container.querySelector('button[aria-label="Open Mote"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(container.querySelector('.pmo-teams-topic-floating-launcher')).toBeNull()
    await act(async () => button.click())
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":true')
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('uses the same dragon identity and a persistent expanded state without decorative particles', async () => {
    window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: true, position: { left: 80, top: 72 }, size: { width: 720, height: 520 } }))
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    const avatar = container.querySelector('.pmo-teams-topic-compact-launcher__button img') as HTMLImageElement
    expect(avatar.getAttribute('src')).toContain('pmo-teams-topic-avatar')
    expect(container.querySelector('button[aria-expanded="true"]')).toBeTruthy()
    expect(container.querySelectorAll('.pmo-teams-topic-compact-launcher__firework')).toHaveLength(0)
    expect(container.querySelectorAll('[data-particle]')).toHaveLength(0)
  })

  it('uses the avatar as the close toggle when the panel is already open', async () => {
    window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: true }))
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    const button = container.querySelector('button[aria-label="Close Mote"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(window.localStorage.getItem('agentmux.leader-topic-floating.v1')).toContain('"open":false')
  })

  it('does not expose a floating mode switch or three-dot control', async () => {
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    expect(container.querySelector('[data-pmo-teams-topic-mode]')).toBeNull()
    expect(container.querySelector('button[aria-label*="floating"]')).toBeNull()
  })
})

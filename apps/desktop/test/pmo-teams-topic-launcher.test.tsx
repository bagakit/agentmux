// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  config: null,
  sessions: [],
}

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state })
}))

import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry.js'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
})

describe('PMO teams topic launcher', () => {
  it('stays visible, opens the fixed Topic, and can move to compact placement', async () => {
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'floating' })))
    const button = container.querySelector('button[aria-label="Open PMO teams topic"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    let requested = false
    window.addEventListener('agentmux:pmo-teams-topic-floating', () => { requested = true }, { once: true })
    await act(async () => button.click())
    expect(requested).toBe(true)

    const mode = container.querySelector('button[aria-label="More PMO teams topic actions: move to bottom switcher"]') as HTMLButtonElement
    await act(async () => mode.click())
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    expect(container.querySelector('.pmo-teams-topic-compact-launcher')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Open PMO teams topic"]')).toBeTruthy()
  })

  it('renders the project avatar and keeps the old hidden preference from removing the entry', async () => {
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'floating' })))
    const avatar = container.querySelector('.pmo-teams-topic-floating-launcher__button img') as HTMLImageElement
    expect(avatar).toBeTruthy()
    expect(avatar.getAttribute('src')).toContain('pmo-teams-topic-avatar')
  })

  it('uses the avatar as the close toggle when the floating state is already open', async () => {
    window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: true }))
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'floating' })))
    const button = container.querySelector('button[aria-label="Close PMO teams topic"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    let closed = false
    window.addEventListener('agentmux:pmo-teams-topic-floating', (event) => {
      closed = (event as CustomEvent).detail?.open === false
    }, { once: true })
    await act(async () => button.click())
    expect(closed).toBe(true)
  })
})

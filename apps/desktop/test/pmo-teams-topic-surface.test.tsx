// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = { config: null, sessions: [] }
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry.js'

describe('compact PMO teams topic surface', () => {
  let root: ReturnType<typeof createRoot>
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
  })
  it('keeps a separate compact control beside the surface switcher', async () => {
    window.localStorage.setItem('agentmux.pmo-teams-topic-floating.v1', JSON.stringify({ open: false, maximized: false, position: { left: 80, top: 72 }, size: { width: 720, height: 520 }, launcherPlacement: 'compact', launcherPosition: { left: 100, top: 100 } }))
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    expect(container.querySelector('.pmo-teams-topic-compact-launcher')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Open PMO teams topic"]')).toBeTruthy()
  })
})

// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../src/renderer/src/store.js'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry.js'
const baseline = useAppStore.getState()

describe('compact PMO teams topic surface', () => {
  let root: ReturnType<typeof createRoot>
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    window.localStorage.clear()
    useAppStore.setState({ tabs: {}, layouts: {}, sessions: [] })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
  })
  it('keeps a separate compact control beside the surface switcher', async () => {
    window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false }))
    await act(async () => root.render(createElement(PmoTeamsTopicEntry, { placement: 'compact' })))
    expect(container.querySelector('.pmo-teams-topic-compact-launcher')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Open Mote"]')).toBeTruthy()
  })
})

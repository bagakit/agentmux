// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

const state = {
  config: { workspaces: [{ id: '__scratch__', hostId: 'local', name: 'Scratch', path: '/scratch', kind: 'folder' }] },
  defaultSessionLauncherHidden: false,
  setWorkspaceTool: vi.fn(),
  setDefaultSessionLauncherHidden: vi.fn()
}

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state })
}))

import { DefaultSessionEntry } from '../src/renderer/src/components/DefaultSessionEntry.js'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  state.defaultSessionLauncherHidden = false
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('default Topic surface entry', () => {
  it('opens the canonical launcher Topic through the existing workspace flow', async () => {
    await act(async () => root.render(createElement(DefaultSessionEntry, { placement: 'topbar', respectHidden: false })))
    const button = container.querySelector('button[aria-label="Open Default Session"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    let requested = false
    window.addEventListener('agentmux:default-session-floating', () => { requested = true }, { once: true })
    await act(async () => button.click())
    expect(requested).toBe(true)
  })

  it('keeps a topbar entry available while the Board placement is hidden', async () => {
    state.defaultSessionLauncherHidden = true
    await act(async () => root.render(createElement(DefaultSessionEntry, { placement: 'topbar', respectHidden: false })))
    expect(container.querySelector('[aria-label="Open Default Session"]')).toBeTruthy()
    expect(container.querySelector('.default-session-entry__recover')).toBeNull()
  })
})

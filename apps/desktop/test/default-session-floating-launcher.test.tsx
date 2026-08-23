// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  defaultSessionLauncherHidden: false,
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

describe('Default Session floating launcher', () => {
  it('stays visible as a compact keyboard-focusable launcher and opens the canonical Topic', async () => {
    await act(async () => root.render(createElement(DefaultSessionEntry, { placement: 'floating' })))
    const launcher = container.querySelector('.default-session-floating-launcher') as HTMLElement
    const button = launcher?.querySelector('button[aria-label="Open Default Session"]') as HTMLButtonElement
    expect(launcher).toBeTruthy()
    expect(button).toBeTruthy()
    expect(button.querySelector('.default-session-floating-launcher__attention')).toBeNull()
    let requested = false
    window.addEventListener('agentmux:default-session-floating', () => { requested = true }, { once: true })
    await act(async () => button.click())
    expect(requested).toBe(true)
  })

  it('hands the visible entry back to Board when the launcher is explicitly hidden', async () => {
    state.defaultSessionLauncherHidden = true
    await act(async () => root.render(createElement(DefaultSessionEntry, { placement: 'floating' })))
    expect(container.querySelector('.default-session-floating-launcher')).toBeNull()
    expect(container.querySelector('.default-session-floating-launcher__recover')).toBeNull()
  })
})

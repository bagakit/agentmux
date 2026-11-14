// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserProfileList } from '../src/shared/contracts'

const port = vi.hoisted(() => {
  const list: BrowserProfileList = { revision: 1, sequence: 1, folders: [], views: [], profiles: [{
    id: 'work-profile', revision: 'r1', label: 'Work sign-ins', createdAt: 1, isDefault: true, source: null,
    network: { mode: 'proxy', server: { scheme: 'socks5', host: '127.0.0.1', port: 1080 } }
  }] }
  return {
    list, readProfiles: vi.fn(async () => list), onProfilesChanged: vi.fn(() => () => {}),
    listProfileSites: vi.fn(async () => []), readProfileProxySignIn: vi.fn(async () => null),
    updateProfile: vi.fn(), probeProfileNetwork: vi.fn(), checkProfileExit: vi.fn(),
    profileNetworkHistory: vi.fn(async () => ({ diagnostics: [] }))
  }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: port } }))
const state = vi.hoisted(() => ({ tabs: {}, config: { browser: { agentAutomation: true } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesSettingsPane } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'

let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  browserProfiles.reset(); vi.clearAllMocks()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<BrowserProfilesSettingsPane active />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('keeps sign-ins, pages and Agent access in the daily surface; optional settings do not change the saved route', async () => {
  const disclosure = container.querySelector<HTMLDetailsElement>('.browser-profile-editor__advanced')!
  expect(disclosure.open).toBe(false)
  for (const label of ['Agents', 'In use', 'Sites with sign-ins']) {
    const section = container.querySelector(`[aria-label="${label}"]`)
    expect(section, label).not.toBeNull()
    expect(disclosure.contains(section), label).toBe(false)
  }
  expect(container.querySelector('.browser-profile-editor__identity')?.textContent).toContain('Open Browser')
  expect(container.querySelector('.browser-profile-editor__note')?.textContent).toContain('environment')
  expect(disclosure.querySelector('[aria-label="Environment"]')).not.toBeNull()
  expect(disclosure.querySelector<HTMLInputElement>('[aria-label="Proxy server"]')?.value).toBe('socks5://127.0.0.1:1080')
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  expect(disclosure.querySelector('[aria-label="Proxy diagnostics"]')).not.toBeNull()
  expect(port.updateProfile).not.toHaveBeenCalled()
  expect(port.probeProfileNetwork).not.toHaveBeenCalled()
  expect(port.checkProfileExit).not.toHaveBeenCalled()
})

it('retains the same advanced editor and unsaved input while closing, hiding Settings and returning', async () => {
  const disclosure = container.querySelector<HTMLDetailsElement>('.browser-profile-editor__advanced')!
  await act(async () => { disclosure.open = true })
  const input = disclosure.querySelector<HTMLInputElement>('[aria-label="Proxy server"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'socks5://proxy.internal:1080')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { disclosure.open = false; root.render(<BrowserProfilesSettingsPane active={false} />) })
  await act(async () => root.render(<BrowserProfilesSettingsPane active />))
  expect(container.querySelector('[aria-label="Proxy server"]')).toBe(input)
  expect(input.value).toBe('socks5://proxy.internal:1080')
  expect(port.updateProfile).not.toHaveBeenCalled()
})

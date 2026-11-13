// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileSummary } from '../src/shared/contracts'

const port = vi.hoisted(() => ({ updateProfile: vi.fn(async () => ({})) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: port } }))

import { ProfileNetworkRoute } from '../src/renderer/src/components/settings/BrowserProfileNetwork'

/**
 * Network is one route choice with one Server field and Don't proxy under More. Apply sends exactly
 * what Main's parser accepts, names how many open Browsers reconnect, and a line Main would refuse
 * is said before Apply is possible.
 */
const work: BrowserProfileSummary = { id: 'p-work', label: 'Work', createdAt: 1, isDefault: false, source: null }
let root: Root, container: HTMLDivElement
const run = vi.fn(async (_key: string, action: () => Promise<unknown>) => { await action(); return true })
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector)
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.startsWith(text))
const type = async (element: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function mount(profile: BrowserProfileSummary, openBrowsers = 2) {
  await act(async () => root.render(<ProfileNetworkRoute profile={profile} revision={7} openBrowsers={openBrowsers} run={run} />))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  port.updateProfile.mockClear(); run.mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('Settings › Browser Profiles network route', () => {
  it('starts on the saved route and offers nothing to apply until it changes', async () => {
    await mount(work)
    expect([...container.querySelectorAll('[role="radio"]')].map(radio => `${radio.textContent}:${radio.getAttribute('aria-checked')}`)).toEqual(['System:true', 'Direct:false', 'Proxy:false'])
    expect(button('Apply network')).toBeUndefined()
  })

  it('applies a pasted proxy line as the parsed route and names the reconnecting Browsers', async () => {
    await mount(work)
    await act(async () => button('Proxy')!.click())
    await type($<HTMLInputElement>('input[aria-label="Proxy server"]')!, ' SOCKS5://10.0.0.2:1080 ')
    await act(async () => button('More')!.click())
    await type($<HTMLInputElement>('input[aria-label="Don’t proxy"]')!, '*.corp.test, localhost')
    expect(button('Apply network')!.textContent).toBe('Apply network · 2 open Browsers reconnect')
    await act(async () => button('Apply network')!.click())
    expect(port.updateProfile).toHaveBeenCalledExactlyOnceWith('p-work',
      { network: { mode: 'proxy', server: { scheme: 'socks5', host: '10.0.0.2', port: 1080 }, bypass: ['*.corp.test', 'localhost'] } }, 7)
  })

  it('says why a line is refused and does not let it be applied', async () => {
    await mount(work)
    await act(async () => button('Proxy')!.click())
    await type($<HTMLInputElement>('input[aria-label="Proxy server"]')!, 'http://me:pw@gw.corp.test:3128')
    expect($('[role="alert"]')?.textContent).toContain('Leave the user name and password out')
    expect(button('Apply network')!.disabled).toBe(true)
    await type($<HTMLInputElement>('input[aria-label="Proxy server"]')!, 'gw.corp.test:99999')
    expect($('[role="alert"]')?.textContent).toContain('out of range')
  })

  it('going back to System sends null, and Revert restores the saved route', async () => {
    await mount({ ...work, network: { mode: 'proxy', server: { scheme: 'http', host: 'gw.corp.test', port: 3128 } } }, 0)
    expect($<HTMLInputElement>('input[aria-label="Proxy server"]')!.value).toBe('http://gw.corp.test:3128')
    await act(async () => button('System')!.click())
    expect(button('Apply network')!.textContent).toBe('Apply network')
    await act(async () => button('Revert')!.click())
    expect(button('Apply network')).toBeUndefined()
    await act(async () => button('Direct')!.click())
    await act(async () => button('Apply network')!.click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-work', { network: { mode: 'direct' } }, 7)
    await act(async () => button('System')!.click())
    await act(async () => button('Apply network')!.click())
    expect(port.updateProfile).toHaveBeenLastCalledWith('p-work', { network: null }, 7)
  })
})

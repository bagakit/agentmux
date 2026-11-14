// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileList, BrowserProfileSummary } from '../src/shared/contracts'

const port = vi.hoisted(() => {
  const listeners = new Set<(list: BrowserProfileList) => void>()
  let list: BrowserProfileList = { revision: 1, sequence: 1, folders: [], views: [], profiles: [] }
  return {
    listeners, set(next: BrowserProfileList) { list = next },
    readProfiles: vi.fn(async () => list),
    onProfilesChanged: vi.fn((listener: (list: BrowserProfileList) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    switchProfile: vi.fn(async () => ({}))
  }
})
vi.mock('../src/renderer/src/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/api')>()
  return { ...actual, api: { ...actual.api, browser: { ...actual.api.browser, ...port } } }
})

import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfileChip } from '../src/renderer/src/components/BrowserProfileChip'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'

const personal: BrowserProfileSummary = { revision: 'personal-token', id: 'p-personal', label: 'Personal', createdAt: 1, isDefault: true, source: null }
const client: BrowserProfileSummary = { revision: 'client-token', id: 'p-client', label: 'Northwind client', createdAt: 2, isDefault: false, source: null }

const originalState = useAppStore.getState()
let root: Root, container: HTMLDivElement
const open = vi.fn()
function OriginalBrowserChrome({ props }: { props: Partial<Parameters<typeof BrowserProfileChip>[0]> }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const surface = useAppStore(state => state.tabs.t1?.regions.r1)
  return <SettingsNavigation.Provider value={{ open } as never}>
    <form className="browser-toolbar"><BrowserProfileChip browserId="b1" regionId="r1" profileId={surface?.kind === 'browser' ? surface.profileId : 'p-client'} control={undefined} noticeHost={host} {...props} /></form>
    <div className="browser-profile-service" ref={setHost} />
  </SettingsNavigation.Provider>
}
async function mount(props: Partial<Parameters<typeof BrowserProfileChip>[0]> = {}) {
  await act(async () => root.render(<OriginalBrowserChrome props={props} />))
}

async function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>('.browser-profile-chip')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}
const items = () => [...document.querySelectorAll<HTMLElement>('.browser-profile-switcher [role="menuitem"]')]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  browserProfiles.reset(); port.listeners.clear(); port.switchProfile.mockReset(); open.mockClear()
  const native = (profileId: string) => ({ id: 'b1', profileId, mode: 'normal' as const, url: 'https://generic.invalid/', title: 'Original page',
    navigationId: profileId + '-document', canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null })
  port.switchProfile.mockImplementation(async (_id: string, profileId: string) => native(profileId))
  useAppStore.setState(originalState, true)
  useAppStore.setState({ tabs: { t1: createWorkbenchTab('t1', { ...native('p-client'), regionId: 'r1', browserId: 'b1', kind: 'browser', workspaceId: 'resource' }) },
    surveyPageReferences: [], surveyPageReadRecovery: null })
  port.set({ revision: 1, sequence: 1, folders: [], views: [], profiles: [personal, client] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); useAppStore.setState(originalState, true) })

describe('Browser toolbar Profile chip', () => {
  it('names the exact Profile of this Browser with its mark', async () => {
    await mount()
    const chip = container.querySelector('.browser-profile-chip')!
    expect(chip.getAttribute('aria-label')).toBe('Profile: Northwind client')
    expect(chip.querySelector('.profile-mark')?.textContent).toBe('N')
  })

  it('stays out of the way with a single Profile, a private page or no list yet', async () => {
    port.set({ revision: 1, sequence: 1, folders: [], views: [], profiles: [personal] })
    await mount({ profileId: 'p-personal' })
    expect(container.querySelector('.browser-profile-chip')).toBeNull()
    browserProfiles.reset(); port.set({ revision: 2, sequence: 2, folders: [], views: [], profiles: [personal, client] })
    await mount({ profileId: null })
    expect(container.querySelector('.browser-profile-chip')).toBeNull()
  })

  it('switches through the original Browser owner and opens Settings from the menu', async () => {
    await mount()
    await openMenu()
    expect(items().map(item => item.textContent)).toEqual(['PPersonalDefault', 'NNorthwind client', 'Manage Browser Profiles…'])
    await act(async () => items()[0]!.click())
    expect(port.switchProfile).toHaveBeenCalledExactlyOnceWith('b1', 'p-personal')
    await openMenu()
    await act(async () => items()[2]!.click())
    expect(open).toHaveBeenCalledWith('browser-profiles')
  })

  it('an Agent-held Browser lists Profiles but cannot switch', async () => {
    await mount({ control: { owner: 'agent', activeOperationId: null, revision: 1, inputIsolation: 'isolated' } as never })
    await openMenu()
    const other = items().find(item => item.textContent?.includes('Personal'))!
    expect(other.getAttribute('aria-disabled') ?? other.getAttribute('data-disabled')).not.toBeNull()
    expect(document.querySelector('.browser-profile-switcher')?.textContent).toContain('Take control to switch Profile')
    await act(async () => other.click())
    expect(port.switchProfile).not.toHaveBeenCalled()
  })

  it('a refused switch returns to the original Profile, and Retry asks again for the same target', async () => {
    port.switchProfile.mockRejectedValueOnce(new Error('Take control first'))
    await mount()
    await openMenu()
    await act(async () => items()[0]!.click())
    expect(container.querySelector('.browser-profile-chip')?.getAttribute('aria-label')).toBe('Profile: Northwind client')
    expect(container.querySelector('.browser-profile-chip__failure')?.textContent).toContain('Couldn’t switch')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('.browser-profile-chip__failure button')].find(button => button.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(port.switchProfile).toHaveBeenNthCalledWith(2, 'b1', 'p-personal')
    expect(container.textContent).not.toContain('Couldn’t switch')
    expect(useAppStore.getState().tabs.t1!.regions.r1).toMatchObject({ profileId: 'p-personal' })
  })

  it('keeps a failed Survey save in the original service row and repairs only metadata without replaying Native', async () => {
    const reference = { regionId: 'r1', browserId: 'b1' }
    const register = vi.fn()
      .mockResolvedValueOnce({ reference, outcome: 'partial', save: null, issues: [{ step: 'save', code: 'SURVEY_PAGE_SAVE_UNCONFIRMED',
        message: 'The original reference save reply is unavailable. '.repeat(12), recovery: 'Retry only this exact Survey reference; the confirmed page stays available.' }] })
      .mockResolvedValue({ reference, outcome: 'registered', save: null, issues: [] })
    useAppStore.setState({ registerSurveyBrowserPage: register })
    await mount(); await openMenu()
    await act(async () => items()[0]!.click())
    const notice = container.querySelector('[data-survey-profile-registration="b1"]')!
    expect(notice).toBeTruthy()
    expect(notice.closest('.browser-toolbar')).toBeNull()
    expect(container.querySelector('.browser-profile-service')!.contains(notice)).toBe(true)
    expect(container.querySelector('.browser-toolbar')!.textContent).not.toContain('Survey save unconfirmed')
    expect(notice.textContent).toContain('Survey save unconfirmed')
    expect(notice.querySelector('details')?.textContent).toContain('The original reference save reply is unavailable.')
    const retry = [...notice.querySelectorAll('button')].find(button => button.textContent === 'Retry Survey registration')!
    await act(async () => retry.click())
    expect(register).toHaveBeenCalledTimes(2)
    expect(port.switchProfile).toHaveBeenCalledExactlyOnceWith('b1', 'p-personal')
    expect(container.querySelector('[data-survey-profile-registration]')).toBeNull()
    expect(useAppStore.getState().tabs.t1!.regions.r1).toMatchObject({ profileId: 'p-personal' })
  })

  it('says the Profile is unknown when the list cannot be read, instead of hiding it', async () => {
    port.readProfiles.mockRejectedValueOnce(new Error('EACCES'))
    await mount()
    expect(container.querySelector('.browser-profile-chip--unknown')?.textContent).toBe('Profile unknown')
    expect(container.querySelector('.browser-profile-chip--unknown')?.getAttribute('title')).toContain('EACCES')
  })
})

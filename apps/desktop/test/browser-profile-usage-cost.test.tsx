// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserProfileList } from '../src/shared/contracts'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const port = vi.hoisted(() => ({
  list: { revision: 1, sequence: 1, folders: [], views: [], profiles: [] } as BrowserProfileList,
  readProfiles: vi.fn(async () => port.list), onProfilesChanged: vi.fn(() => () => {}),
  listProfileSites: vi.fn(async () => []), readProfileProxySignIn: vi.fn(async () => null),
  profileNetworkHistory: vi.fn(async () => ({ diagnostics: [] })), updateProfile: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: port } }))
const state = vi.hoisted(() => ({ tabs: {} as Record<string, WorkbenchTab>, config: { browser: { agentAutomation: true } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign(
  (select: (value: typeof state) => unknown) => select(state), { getState: () => state }
) }))

import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesSettingsPane } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'

let root: Root, container: HTMLDivElement
let profileReads = 0, browserFilterVisits = 0
const filter = Array.prototype.filter

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  browserProfiles.reset(); vi.clearAllMocks()
  state.tabs = {}; profileReads = 0; browserFilterVisits = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  // Observe actual Array work on our Browser records, including copies made by the component.
  // Usage rows and Profile rows have different shapes and do not enter this measurement.
  vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], callback: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
    return filter.call(this, (item: unknown, index: number) => {
      if (item && typeof item === 'object' && 'browserId' in item && 'profileId' in item
        && typeof item.browserId === 'string' && item.browserId.startsWith('cost-browser-')) browserFilterVisits++
      return callback.call(thisArg, item, index, this)
    })
  } as typeof Array.prototype.filter)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function profiles(count: number): BrowserProfileList {
  return { revision: count, sequence: count, folders: [], views: [], profiles: Array.from({ length: count }, (_, index) => ({
    id: `profile-${index}`, revision: `r-${index}`, label: `Environment ${index}`, createdAt: 1,
    isDefault: index === 0, source: null
  })) }
}

function pages(profileCount: number, browserCount: number, agentCount = 0): Record<string, WorkbenchTab> {
  const regions: Record<string, unknown> = {}
  for (let index = 0; index < browserCount; index++) {
    const surface = {
      kind: 'browser', regionId: `region-${index}`, browserId: `cost-browser-${index}`, workspaceId: 'workspace',
      url: `https://page-${index}.example/`, title: `Page ${index}`,
      nativeOwnerDeferred: index === browserCount - 1,
      nativeOwnerReleased: index === browserCount - 2
    }
    Object.defineProperty(surface, 'profileId', { enumerable: true, get: () => { profileReads++; return `profile-${index % profileCount}` } })
    regions[`region-${index}`] = surface
  }
  for (let index = 0; index < agentCount; index++) {
    const agent = { kind: 'agent', regionId: `agent-${index}` }
    Object.defineProperty(agent, 'profileId', { enumerable: true, get: () => { throw new Error('An unrelated Agent is not a Browser usage fact') } })
    regions[`agent-${index}`] = agent
  }
  return { tab: { id: 'tab', workspaceId: 'workspace', regions } as unknown as WorkbenchTab }
}

async function show(profileCount: number, browserCount: number, agentCount = 0) {
  port.list = profiles(profileCount); state.tabs = pages(profileCount, browserCount, agentCount)
  profileReads = 0; browserFilterVisits = 0
  await act(async () => {
    root.render(<BrowserProfilesSettingsPane active />)
    await browserProfiles.refresh()
  })
  return { profileReads, browserFilterVisits, total: profileReads + browserFilterVisits }
}

it('does not multiply Browser usage work by the number of environments in the real settings component', async () => {
  const small = await show(8, 64)
  expect(small.profileReads).toBeGreaterThan(0)
  const manyProfiles = await show(128, 64)
  expect(manyProfiles.total).toBeLessThanOrEqual(small.total + 64)
  const manyPages = await show(128, 256)
  if (process.env.AGENTMUX_PROFILE_USAGE_COST_REPORT === '1') console.info('profile-usage-cost', { small, manyProfiles, manyPages })
  expect(manyPages.total).toBeGreaterThan(manyProfiles.total)
  expect(manyPages.total).toBeLessThanOrEqual(manyProfiles.total * 5)
  expect(port.updateProfile).not.toHaveBeenCalled()
})

it('keeps open and saved pages accurate when an environment binding changes', async () => {
  await show(8, 32)
  const inUse = () => container.querySelector('[aria-label="In use"]')!
  const pageNames = () => Array.from(inUse().querySelectorAll('.browser-profile-editor__use > span'), node => node.textContent)
  expect(container.querySelector('.browser-profile-editor__who')?.textContent).toContain('Open in 4 Browsers')
  expect(pageNames()).toContain('Page 0')
  expect(pageNames()).not.toContain('Page 1')
  const initial = state.tabs.tab!
  state.tabs = { tab: { ...initial, regions: { ...initial.regions,
    'region-8': { ...initial.regions['region-8']!, nativeOwnerDeferred: true },
    'region-16': { ...initial.regions['region-16']!, nativeOwnerReleased: true }
  } } as WorkbenchTab }
  await act(async () => root.render(<BrowserProfilesSettingsPane active />))
  expect(container.querySelector('.browser-profile-editor__who')?.textContent).toContain('Open in 2 Browsers')
  expect(inUse().querySelectorAll('[data-state="saved"]')).toHaveLength(2)
  expect(pageNames()).toEqual(['Page 0', 'Page 8', 'Page 16', 'Page 24'])
  const oldTab = state.tabs.tab!
  state.tabs = { tab: { ...oldTab, regions: { ...oldTab.regions,
    'region-0': { ...oldTab.regions['region-0']!, profileId: 'profile-1' }
  } } as WorkbenchTab }
  await act(async () => root.render(<BrowserProfilesSettingsPane active />))
  expect(container.querySelector('.browser-profile-editor__who')?.textContent).toContain('Open in 1 Browser')
  expect(pageNames()).not.toContain('Page 0')
  expect(inUse().querySelectorAll('[data-state="saved"]')).toHaveLength(2)
  expect(port.updateProfile).not.toHaveBeenCalled()
})

it('does not reread Browser associations for Profile refresh, hidden settings or unrelated Agents', async () => {
  const baseline = await show(8, 64)
  const withAgents = await show(8, 64, 512)
  expect(withAgents.total).toBe(baseline.total)
  profileReads = 0; browserFilterVisits = 0
  port.list = profiles(128)
  await act(async () => browserProfiles.refresh())
  expect(profileReads + browserFilterVisits).toBe(0)
  await act(async () => root.render(<BrowserProfilesSettingsPane active={false} />))
  expect(profileReads + browserFilterVisits).toBe(0)
  expect(container.querySelector('[aria-label="In use"]')?.textContent).toContain('Page 0')
})

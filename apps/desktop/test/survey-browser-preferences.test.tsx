// @vitest-environment happy-dom
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { api } from '../src/renderer/src/lib/api'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { surveyPageKey, updateSurveyPageTimes } from '../src/renderer/src/lib/survey-page-organization'
import { SURVEY_PIN_SCOPE, surveyPinKey } from '../src/renderer/src/lib/survey-pins'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
import { executeSettingsControl } from '../src/main/settings-control'
import { chooseField } from './helpers/selection-field'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
const dom = composerDOM()
const prefix = 'browser.surveyBrowsing'
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'survey-browsing-preferences' } as const
afterEach(() => browserProfiles.reset())

it('saves the real Survey Settings draft through the original configuration owner and exposes its effective values', async () => {
  const f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected!, next))
  const inspect = () => executeSettingsControl({ ...envelope, operation: 'settings.get', target: prefix }, f.owner)
  const setGap = (value: number) => executeSettingsControl({ ...envelope, operation: 'settings.set', key: prefix + '.groupGapMinutes', value }, f.owner)
  expect(await inspect()).toMatchObject({ entries: expect.arrayContaining([
    expect.objectContaining({ key: prefix + '.reuseOpenPages', value: true, default: true }),
    expect.objectContaining({ key: prefix + '.pageGrouping', value: 'none', enum: ['none', 'site', 'time'] }),
    expect.objectContaining({ key: prefix + '.groupGapMinutes', value: 30 })
  ]) })
  await expect(setGap(241)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await dom.render(<SettingsPanel initialSection="survey" onClose={() => {}} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Group saved webpages"]')!
  expect(trigger.dataset.value).toBe('none')
  await chooseField(trigger, 'time')
  await dom.click('[aria-label="Switch to an already open page"]')
  expect(dom.container.querySelector('output')?.textContent).toBe('30 min')
  expect(f.owner.current.browser.surveyBrowsing).toBeUndefined()
  await dom.click('[aria-label="Survey browsing"] [data-settings-save-bar] button')
  await act(async () => { await save.mock.results.at(-1)!.value })
  expect((await f.disk()).browser.surveyBrowsing).toMatchObject({ reuseOpenPages: false, pageGrouping: 'time' })
  await act(async () => { await setGap(45) })
  expect(dom.container.querySelector('output')?.textContent).toBe('45 min')
  expect((await f.disk()).browser.surveyBrowsing).toEqual({ reuseOpenPages: false, pageGrouping: 'time', groupGapMinutes: 45 })
})

function setupPages() {
  const make = (regionId: string, hostname: string, profileId = 'default-profile') => createWorkbenchTab(`tab-${regionId}`, {
    kind: 'browser', id: `browser-${regionId}`, browserId: `browser-${regionId}`, regionId, workspaceId: 'workspace',
    profileId, mode: 'normal', url: `https://${hostname}/${regionId}?q=source#section`, title: regionId,
    navigationId: `navigation-${regionId}`, canGoBack: false, canGoForward: false, loading: false,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null
  })
  const created = [make('first-doc', 'docs.example.test'), make('second-doc', 'docs.example.test'), make('article', 'journal.example.test'),
    make('other-profile', 'private.example.test', 'other-profile')]
  const refs = created.map(tab => {
    const regionId = tab.layout.activeRegionId!
    return { regionId, browserId: `browser-${regionId}` }
  })
  const state = useAppStore.getState()
  const config = state.config!
  const tabs = Object.fromEntries(created.map(tab => [tab.id, tab]))
  const catalog = { zones: [], tabs: [], regions: created.map(tab => ({ regionId: tab.layout.activeRegionId, tabId: tab.id, kind: 'browser' })),
    locations: [], bindings: [], spaces: [] } as unknown as AgentMuxSpaceCatalog
  const layouts = { workspace: createWorkspaceLayout('original-group', created.map(tab => tab.id)) }
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1,
    profiles: [{ id: 'default-profile', label: 'Default', isDefault: true, createdAt: 1, source: null }], folders: [], views: [] })
  const create = vi.fn()
  useAppStore.setState({ tabs, layouts, createSurveyBrowser: create, mainSurface: 'survey', surveyPageReferences: refs,
    surveyCollectedZones: {}, surveyProfileView: { kind: 'default' }, surveyProfileViewReadRecovery: null, surveyZoneSelection: null })
  return { refs, config, tabs, create, catalog }
}

const groups = () => [...dom.container.querySelectorAll('.survey-automatic-page-group')]
const title = (group: Element) => group.querySelector('h3')!.textContent
const savedNames = (group: Element) => [...group.querySelectorAll('.survey-item > strong')].map(node => node.textContent)

it('submits the actual Survey start address once and restores the saved Browser choice without reopening it', async () => {
  const f = setupPages()
  await dom.render(<GlobalSurveySurface catalog={null} selection={null} projection={null} />)
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://DOCS.example.test:443/first-doc?q=source#section')
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await dom.click('[aria-label="Search or open page"]')
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection).toEqual({ kind: 'page', ...f.refs[0] }))
  expect(f.create).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(f.tabs)
})

it('groups only the current environment’s saved webpages and restores actual admission times without assigning one to older pages', async () => {
  const { refs, config, tabs, catalog } = setupPages(), [first, second, article] = refs
  const minute = 60_000, start = fixtureEpoch(2)
  let times = updateSurveyPageTimes([first!], [first!, second!], {}, start)
  times = updateSurveyPageTimes([first!, second!], [first!, second!, article!], times, start + 30 * minute)
  const state = { surveyPageReferences: refs, surveyPageAddedAt: times }
  expect(restorePersistedUiState(config, state).surveyPageAddedAt).toEqual({
    [surveyPageKey(second!)]: start, [surveyPageKey(article!)]: start + 30 * minute
  })
  useAppStore.setState(state)
  await dom.render(<GlobalSurveySurface catalog={catalog} selection={null} projection={null} />)
  await vi.waitFor(() => expect(browserProfiles.get().profiles?.[0]?.id).toBe('default-profile'))
  expect(groups()).toEqual([])
  const grouping = async (pageGrouping: 'site' | 'time', groupGapMinutes = 30) => {
    await act(async () => useAppStore.setState({ config: { ...config, browser: { ...config.browser, surveyBrowsing: { pageGrouping, groupGapMinutes } } } }))
  }
  await grouping('site')
  expect(groups().map(title)).toEqual(['docs.example.test', 'journal.example.test'])
  expect(groups().map(savedNames)).toEqual([['first-doc', 'second-doc'], ['article']])
  await grouping('time')
  expect(groups().map(savedNames)).toEqual([['article'], ['second-doc'], ['first-doc']])
  expect(title(groups()[2]!)).toBe('Earlier webpages')
  await grouping('time', 31)
  expect(groups().map(savedNames)).toEqual([['second-doc', 'article'], ['first-doc']])
  await act(async () => useAppStore.setState({ pinnedItems: { [SURVEY_PIN_SCOPE]: [surveyPinKey({ kind: 'page', ...second! })] } }))
  expect(groups().map(savedNames)).toEqual([['article'], ['first-doc']])
  expect(dom.container.querySelector('.survey-pinned-heading')?.textContent).toBe('Pinned')
  expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().surveyPageReferences).toBe(refs)
})

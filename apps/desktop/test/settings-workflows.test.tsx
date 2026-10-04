// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel, visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { GoalsCommonActions } from '../src/renderer/src/components/GoalsCommonActions'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import type { AppConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ config: structuredClone(composerConfig), sessions: [composerSession()], tabs: {}, layouts: {}, loading: false,
  mainSurface: 'workbench', detectExecutors: async () => {}, checkHost: async () => {} }))
async function section(id: string) { await dom.click(`nav [data-settings-target="${id}"]`) }
const pane = (id: string) => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${id}"]`)!
const checkbox = () => pane('goals').querySelector<HTMLInputElement>('[aria-label="Collapse common actions"]')!
async function save(id: string) { await dom.click(`[data-settings-pane="${id}"] [data-settings-save-bar] button`) }
function transaction() {
  return vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected!, next)
    useAppStore.setState({ config: saved }); return saved
  })
}

it('real catalog and complete Shell expose Work once; object keywords reach their owning modules', async () => {
  expect(settingsNavGroups('').find(group => group.id === 'work')?.items.map(module => module.id)).toEqual(['space', 'focus', 'goals', 'survey', 'notes'])
  for (const word of ['work', 'topic', 'project']) expect(visibleSettingsSections(word).some(module => module.id === 'space')).toBe(true)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(dom.container.querySelectorAll('#settings-overview-work')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[data-settings-pane]')).toHaveLength(0)
  await section('space')
  expect(pane('space').querySelectorAll('[data-workflows-manage]')).toHaveLength(2)
  expect(pane('space').querySelectorAll('input[name=space-rail-density]')).toHaveLength(3)
  expect(pane('space').textContent).toContain('Saved: Comfortable')
  expect(dom.container.querySelector('[data-settings-pane="goals"]')).toBeNull()
})

it('real Shell route to Environments and back preserves visited Space draft without a second route', async () => {
  const close = vi.fn(), write = transaction()
  await dom.render(<SettingsPanel onClose={close} initialSection="space" />)
  await dom.click('input[name=space-rail-density][value=dense]')
  await dom.click('[data-workflows-manage=projects]')
  expect(dom.container.querySelector('[data-settings-page]')?.getAttribute('data-settings-page')).toBe('hosts')
  expect(close).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(pane('space').hidden).toBe(true)
  await section('space')
  expect(pane('space').querySelector<HTMLInputElement>('input[value=dense]')!.checked).toBe(true)
  expect(pane('space').textContent).toContain('Unsaved changes')
})

it('named management buttons consume original surface/floating owner without changing saved config or healthy Runs', async () => {
  const close = vi.fn(), write = transaction(), initial = useAppStore.getState()
  await dom.render(<SettingsPanel onClose={close} initialSection="space" />)
  await section('survey'); await dom.click('[data-settings-pane=survey] .small-button')
  expect(useAppStore.getState().mainSurface).toBe('survey')
  await section('space'); await dom.click('[data-workflows-manage=topics]')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  await section('mote'); await dom.click('[data-settings-pane=mote] .small-button')
  expect(readPmoTeamsTopicFloatingState().open).toBe(true)
  requestPmoTeamsTopicFloatingClose()
  expect(close).toHaveBeenCalledTimes(3)
  expect(write).not.toHaveBeenCalled()
  expect(useAppStore.getState().config).toBe(initial.config)
  expect(useAppStore.getState().sessions).toBe(initial.sessions)
  expect(useAppStore.getState().tabs).toBe(initial.tabs)
})

it('Space save reaches actual project rail and Goals save reaches actual collapsed common actions', async () => {
  transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="space" />)
  await dom.click('input[name=space-rail-density][value=dense]'); await save('space')
  expect(useAppStore.getState().config!.projectRailDensity).toBe('dense')
  await dom.render(<WorkspaceSidebar />)
  expect(dom.container.querySelector('[data-rail-density=dense]')).not.toBeNull()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await dom.click('[aria-label="Collapse common actions"]'); await save('goals')
  expect(useAppStore.getState().config!.goalsCommonActions?.collapsed).toBe(true)
  await dom.render(<GoalsCommonActions />)
  expect(dom.container.querySelector('.goals-common')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="展开常用操作"]')).not.toBeNull()
})

it('Goals saves only authored collapsed field and preserves concurrent empty or reordered items', async () => {
  const write = transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await dom.click('[aria-label="Collapse common actions"]')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, goalsCommonActions: { items: [], collapsed: false }, copyPathsAsAbsolute: true } }))
  expect(checkbox().checked).toBe(true)
  await save('goals')
  expect(useAppStore.getState().config!.goalsCommonActions).toEqual({ items: [], collapsed: true })
  expect(useAppStore.getState().config!.copyPathsAsAbsolute).toBe(true)
  expect(write).toHaveBeenCalledTimes(1)
  await section('focus'); await section('goals')
  expect(checkbox().checked).toBe(true)
})

it('same-field conflict and durable failure retain the edited choice and expose the actual error', async () => {
  let live: AppConfig = { ...composerConfig, projectRailDensity: 'compact' }
  useAppStore.setState({ config: live })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(live, expected!, next))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="space" />)
  await dom.click('input[name=space-rail-density][value=dense]')
  live = { ...live, projectRailDensity: 'default' }
  await act(async () => useAppStore.setState({ config: live }))
  await save('space')
  expect(pane('space').querySelector<HTMLInputElement>('input[value=dense]')!.checked).toBe(true)
  expect(pane('space').querySelector('[role=alert]')?.textContent).toContain('changed since')
  expect(live.projectRailDensity).toBe('default')
  vi.mocked(api.config.save).mockRejectedValue(new Error('Controlled durable save failed'))
  await section('goals'); await dom.click('[aria-label="Collapse common actions"]'); await save('goals')
  expect(checkbox().checked).toBe(true)
  expect(pane('goals').querySelector('[role=alert]')?.textContent).toContain('Controlled durable save failed')
  expect(useAppStore.getState().config!.goalsCommonActions).toBeUndefined()
})

it('pending Save keeps later input dirty and uses the original expected value', async () => {
  let finish!: (saved: AppConfig) => void
  const write = vi.spyOn(api.config, 'save').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await dom.click('[aria-label="Collapse common actions"]'); await save('goals')
  expect(pane('goals').textContent).toContain('Saving changes')
  await dom.click('[aria-label="Collapse common actions"]')
  const [submitted, expected] = write.mock.calls[0]!
  expect(submitted.goalsCommonActions?.collapsed).toBe(true)
  expect(expected?.goalsCommonActions?.collapsed).toBe(false)
  await act(async () => { useAppStore.setState({ config: submitted }); finish(submitted) })
  expect(checkbox().checked).toBe(false)
  expect(pane('goals').textContent).toContain('Unsaved changes')
})

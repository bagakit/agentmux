// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_ID, emptyNotebookState } from '@agentmux/core/notebook-catalog'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel, visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { GlobalRecallSurface } from '../src/renderer/src/components/GlobalRecallSurface'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  requestPmoTeamsTopicFloatingClose()
  useAppStore.setState({ config: structuredClone(composerConfig), sessions: [composerSession()], tabs: {}, layouts: {}, loading: false,
    mainSurface: 'workbench', recallNotebookId: 'research', recallNoteId: 'research-page',
    surveyZoneSelection: { zoneId: 'retained-webpage', selection: [], active: null },
    detectExecutors: async () => {}, checkHost: async () => {} })
  const library = emptyNotebookState()
  library.notebooks.research = { notebookId: 'research', name: 'Research journal', createdAt: 1 }
  library.pages.kept = { noteId: 'kept', notebookId: DEFAULT_NOTEBOOK_ID, parentNoteId: null, title: 'Saved from research',
    resource: { hostId: 'local', workspaceId: composerConfig.workspaces[0]!.id, workspacePath: composerConfig.workspaces[0]!.path, path: 'saved.note.json' },
    createdAt: 1, updatedAt: 1, sources: [], topics: [] }
  useNotebookLibrary.setState({ state: library, issue: null })
})
const section = (id: string) => dom.click(`nav [data-settings-target="${id}"]`)
const open = async (id: string) => {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>(`[data-settings-pane="${id}"] .small-button`)].find(button => button.textContent?.startsWith('Open '))!
  expect(button).toBeDefined(); await act(async () => button.click())
}

it('the real catalog and Overview expose Work and peer Mote; keyword discovery points to first-class modules', async () => {
  expect(settingsNavGroups('').map(group => group.title)).toEqual(['Preferences', 'Connections', 'Mods', 'Resources', 'Work', 'Mote'])
  expect(settingsNavGroups('').find(group => group.id === 'mote')?.items.map(module => module.id)).toEqual(['mote'])
  expect(settingsNavGroups('').find(group => group.id === 'work')?.items.map(module => module.id)).toEqual(['space', 'focus', 'goals', 'survey', 'notes'])
  for (const [query, id] of [['SOUL', 'mote'], ['research', 'survey'], ['notebook', 'notes']])
    expect(visibleSettingsSections(query!).some(module => module.id === id)).toBe(true)
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const groups = [...dom.container.querySelectorAll('[data-settings-overview] h3')].map(node => node.textContent)
  expect(groups).toEqual(['Preferences', 'Connections', 'Mods', 'Resources', 'Work', 'Mote'])
  expect(dom.container.textContent).not.toContain('Workflows')
  expect(dom.container.textContent).not.toContain('Saved configuration')
  expect(dom.container.querySelector('[data-settings-section="notes"]')).not.toBeNull()
  await section('space')
  expect([...dom.container.querySelectorAll('[data-workflows-manage]')].map(node => node.getAttribute('data-workflows-manage'))).toEqual(['topics', 'projects'])
})

it('Survey and Mote use original surface and floating owners; navigation does not write config or guess a content target', async () => {
  const close = vi.fn(), writes = vi.spyOn(api.config, 'save'), initial = useAppStore.getState(), library = useNotebookLibrary.getState().state
  await dom.render(<SettingsPanel onClose={close} initialSection="survey" />)
  await open('survey')
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(useAppStore.getState().surveyZoneSelection).toBe(initial.surveyZoneSelection)
  expect(useAppStore.getState().recallNotebookId).toBe('research')
  await section('mote'); await open('mote')
  expect(readPmoTeamsTopicFloatingState().open).toBe(true)
  requestPmoTeamsTopicFloatingClose()
  expect(close).toHaveBeenCalledTimes(2)
  expect(writes).not.toHaveBeenCalled()
  expect(useAppStore.getState().config).toBe(initial.config)
  expect(useAppStore.getState().sessions).toBe(initial.sessions)
  expect(useAppStore.getState().tabs).toBe(initial.tabs)
  expect(useNotebookLibrary.getState().state).toBe(library)
})

it('Notes leaves a retained webpage selection and opens actual original NotebookHome at 随手记 with existing pages intact', async () => {
  const initial = useAppStore.getState(), library = useNotebookLibrary.getState().state, close = vi.fn()
  const writes = vi.spyOn(api.notebooks, 'apply')
  await dom.render(<SettingsPanel onClose={close} initialSection="notes" />)
  await open('notes')
  const current = useAppStore.getState()
  expect(current.mainSurface).toBe('recall')
  expect(current.recallNotebookId).toBe(DEFAULT_NOTEBOOK_ID)
  expect(current.recallNoteId).toBeNull()
  expect(current.surveyZoneSelection).toBe(initial.surveyZoneSelection)
  expect(current.recallZoneSelection).toBeNull()
  expect(close).toHaveBeenCalledOnce()
  await dom.render(<GlobalRecallSurface catalog={null} projection={null} selection={current.recallZoneSelection} />)
  expect(dom.container.querySelector('.survey-notebook-home')).not.toBeNull()
  expect(dom.container.textContent).toContain('随手记')
  expect(dom.container.textContent).toContain('Saved from research')
  expect(useNotebookLibrary.getState().state?.notebooks.research?.name).toBe('Research journal')
  expect(useNotebookLibrary.getState().state).toBe(library)
  expect(useAppStore.getState().config).toBe(initial.config)
  expect(useAppStore.getState().tabs).toBe(initial.tabs)
  expect(useAppStore.getState().sessions).toBe(initial.sessions)
  expect(writes).not.toHaveBeenCalled()
})

it('visiting the new management modules keeps the original Space draft and causes no incremental Notebook reads or writes', async () => {
  const read = vi.spyOn(api.notebooks, 'read'), write = vi.spyOn(api.notebooks, 'apply'), close = vi.fn()
  await dom.render(<SettingsPanel onClose={close} initialSection="space" />)
  await dom.click('input[name=space-rail-density][value=dense]')
  const originalPane = dom.container.querySelector('[data-settings-pane="space"]')
  for (const id of ['mote', 'survey', 'notes']) await section(id)
  const trigger = dom.container.querySelector('[aria-label="Settings section"]')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Recall')
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Mote Club')
  const space = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent === 'Space')!
  await act(async () => space.click())
  expect(dom.container.querySelector('[data-settings-pane="space"]')).toBe(originalPane)
  expect(dom.container.querySelector<HTMLInputElement>('input[value=dense]')!.checked).toBe(true)
  expect(originalPane?.textContent).toContain('Unsaved changes')
  expect(close).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(readPmoTeamsTopicFloatingState().open).toBe(false)
})

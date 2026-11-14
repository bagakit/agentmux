// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { FocusProjectPreferences } from '../src/renderer/src/components/FocusProjectPreferences'
import { FocusSettingsPane } from '../src/renderer/src/components/settings/FocusSettingsPane'
import { saveFocusPreferences } from '../src/renderer/src/lib/focus-preferences'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { AppConfig } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM()
const key = (id: string) => JSON.stringify(['local', id])
const preference = (id: string) => ({ key: key(id), pinned: true, note: 'Before', color: 'blue' as const, collapsed: null })
function button(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)
  expect(element, label).not.toBeNull(); expect(element, label).not.toBeUndefined(); return element!
}
async function click(label: string) {
 await act(async()=>button(label).click())
 if (label.startsWith('Project preferences ·')) {
  const appearance=document.querySelector<HTMLButtonElement>('[aria-label="Project appearance"]')
  if(appearance?.getAttribute('aria-expanded')==='false') await act(async()=>appearance.click())
 }
}
function input() { return document.querySelector<HTMLInputElement>('[aria-label="Project note"]')! }
async function note(value: string) {
  const element = input(); expect(element).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function editor() {
  useAppStore.setState({ config: { ...composerConfig, focus: { recentActivityHours: 48, projects: [preference('one')] } } })
  await dom.render(<FocusProjectPreferences projectKey={key('one')} name="One" />)
  await click('Project preferences · One')
}

it('an older successful save keeps a later reopened editor, its new draft and active input', async () => {
  const request = deferred<AppConfig>()
  const save = vi.spyOn(api.config, 'save').mockImplementation(async () => request.promise)
  await editor(); await note('First submitted value')
  await click('Save project preferences'); expect(save).toHaveBeenCalledOnce()
  await click('Cancel'); await click('Project preferences · One'); await note('Later unsaved value')
  const laterInput = input()
  await act(async () => laterInput.focus())
  await act(async () => request.resolve({ ...composerConfig, focus: { recentActivityHours: 48, projects: [{ ...preference('one'), note: 'First submitted value' }] } }))
  expect(document.querySelector('[data-focus-project-preferences]')).not.toBeNull()
  expect(input()).toBe(laterInput); expect(input().value).toBe('Later unsaved value')
  expect(document.activeElement).toBe(laterInput)
  expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('First submitted value')
})

it('an older failed save does not publish its error into a later reopened editor', async () => {
  const request = deferred<AppConfig>()
  vi.spyOn(api.config, 'save').mockImplementation(async () => request.promise)
  await editor(); await note('Earlier submitted value'); await click('Save project preferences')
  await click('Cancel'); await click('Project preferences · One'); await note('Later draft')
  await act(async () => request.reject(Error('Older disk failure')))
  expect(document.querySelector('[data-focus-project-preferences]')).not.toBeNull()
  expect(input().value).toBe('Later draft')
  expect(document.querySelector('[data-focus-project-preferences]')?.textContent).not.toContain('Older disk failure')
  expect(button('Save project preferences').disabled).toBe(false)
})

it('explicit conflict review keeps authored note and adopts current unedited fields and unrelated project', async () => {
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  await editor(); await note('My new route')
  const other = { ...preference('two'), note: 'Concurrent other project' }
  await act(async () => useAppStore.setState({ config: { ...composerConfig, focus: { recentActivityHours: 48,
    projects: [{ ...preference('one'), color: 'green' }, other] } } }))
  await click('Save project preferences')
  expect(document.querySelector('[role="status"]')?.textContent).toContain('focus.projects')
  expect(input().value).toBe('My new route')
  await click('Review current project preferences')
  expect(input().value).toBe('My new route')
  await click('Save project preferences')
  expect(document.querySelector('[data-focus-project-preferences]')).toBeNull()
  expect(useAppStore.getState().config?.focus?.projects).toEqual([{ ...preference('one'), note: 'My new route', color: 'green' }, other])
})

it('the actual Focus List drops a pinned project below the last pinned row and preserves original workface', async () => {
  const workspaces = ['one', 'two', 'three'].map(id => ({ ...composerConfig.workspaces[0]!, id, name: id, path: composerConfig.workspaces[0]!.path + '/' + id }))
  const sessions = workspaces.map(workspace => ({ ...composerSession(workspace.id), workspacePath: workspace.path,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  const tabs = Object.fromEntries(workspaces.map(workspace => {
    const tab = createWorkbenchTab('tab-' + workspace.id, { kind: 'agent', phase: 'attached', regionId: 'r-' + workspace.id, workspaceId: workspace.id, sessionId: workspace.id }); return [tab.id, tab]
  }))
  useAppStore.setState({ config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48, projects: [preference('one'), preference('two')] } },
    mainSurface: 'agents', sessions, tabs, layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('g-' + workspace.id, ['tab-' + workspace.id])])),
    timelines: {}, agentNames: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  await dom.render(<GlobalFocusSurface />)
  const before = useAppStore.getState()
  const rows = () => [...dom.container.querySelectorAll<HTMLElement>('[data-project-id][data-lane-id]')]
  expect(rows().map(row => row.dataset.projectId)).toEqual(['one', 'two', 'three'])
  const destination = rows()[1]!, card = dom.container.querySelector('[data-session-id="one"]')
  vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 100, width: 300, height: 100, top: 100, left: 0, right: 300, bottom: 200, toJSON() {} })
  const dataTransfer = new DataTransfer()
  function drag(type: string, clientY = 175) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer }); return event
  }
  await act(async () => button('Reorder pinned project · one').dispatchEvent(drag('dragstart')))
  await act(async () => destination.dispatchEvent(drag('dragover')))
  await act(async () => destination.dispatchEvent(drag('drop')))
  expect(rows().map(row => row.dataset.projectId)).toEqual(['two', 'one', 'three'])
  expect(dom.container.querySelector('[data-session-id="one"]')).toBe(card)
  for (const field of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('restoring visible Focus defaults keeps saved personal project notes and routes', async () => {
  const projects = [{ ...preference('one'), note: 'Saved personal route' }, { ...preference('two'), note: 'Saved second route', color: 'violet' as const }]
  const config = { ...composerConfig, focus: { recentActivityHours: 72 as const, projects } }
  useAppStore.setState({ config })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  await dom.render(<FocusSettingsPane preferences={config.focus} active onSave={saveFocusPreferences} />)
  await click('Restore defaults')
  const save = dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
  expect(save).not.toBeNull()
  await act(async () => save.click())
  expect(useAppStore.getState().config?.focus?.recentActivityHours).toBe(48)
  expect(useAppStore.getState().config?.focus?.projects).toEqual(projects)
})

it('retrying a failed visibility change retains its exact collapse intent and concurrent notes and color', async () => {
  const workspaces = ['one', 'two'].map(id => ({ ...composerConfig.workspaces[0]!, id, name: id, path: composerConfig.workspaces[0]!.path + '/' + id }))
  const sessions = workspaces.map(workspace => ({ ...composerSession(workspace.id), workspacePath: workspace.path,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  const tabs = Object.fromEntries(workspaces.map(workspace => {
    const tab = createWorkbenchTab('tab-' + workspace.id, { kind: 'agent', phase: 'attached', regionId: 'r-' + workspace.id, workspaceId: workspace.id, sessionId: workspace.id }); return [tab.id, tab]
  }))
  useAppStore.setState({ config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48, projects: [preference('one'), preference('two')] } },
    mainSurface: 'agents', sessions, tabs, layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('g-' + workspace.id, ['tab-' + workspace.id])])),
    timelines: {}, agentNames: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  const request = deferred<AppConfig>()
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected!, next))
  save.mockImplementationOnce(async () => request.promise)
  await dom.render(<GlobalFocusSurface />)
  const card = dom.container.querySelector('[data-session-id="one"]')
  await click('Collapse project · one')
  expect(save).toHaveBeenCalledOnce()
  const concurrent = [{ ...preference('one'), note: 'Concurrent route', color: 'green' as const }, { ...preference('two'), note: 'Other concurrent route' }]
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, focus: { recentActivityHours: 48, projects: concurrent } } }))
  await act(async () => request.reject(Error('focus.projects changed concurrently')))
  expect(button('Collapse project · one').getAttribute('aria-expanded')).toBe('true')
  await click('Retry using current settings')
  expect(useAppStore.getState().config?.focus?.projects).toEqual([{ ...concurrent[0], collapsed: true }, concurrent[1]])
  expect(button('Expand project · one').getAttribute('aria-expanded')).toBe('false')
  expect(dom.container.querySelector('[data-session-id="one"]')).toBe(card)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().tabs).toBe(tabs)
})

import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
// Mote's independent launcher is a leaf boundary here; full App visual capture uses the real entry.
vi.mock('../src/renderer/src/components/PmoTeamsTopicEntry', () => ({ PmoTeamsTopicEntry: () => createElement('button', { 'aria-label': 'Open Mote coordination surface' }, 'Mote') }))
const original = useAppStore.getState()
let root: Root, container: HTMLDivElement
const openSettings = vi.fn(), closeSettings = vi.fn()
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="${name}"]`)!
const mount = (settingsOpen = false) => act(async () => root.render(createElement(SettingsNavigation.Provider, { value: { open: openSettings, openToolkit: vi.fn(), openHost: vi.fn() } }, createElement(SurfaceSwitch, { settingsOpen, onCloseSettings: closeSettings }))))
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot(), base = sessions.find(item => item.kind === 'agent')!
  const workspace = { ...(config.workspaces.find(item => item.path === base.workspacePath) ?? config.workspaces[0]!), path: _hygiene_fixturePath("private/footer-group-fixture") }
  const session = { ...base, workspacePath: workspace.path }
  const tab = createWorkbenchTab('footer-original', { kind: 'agent', phase: 'attached', regionId: 'footer-region', workspaceId: workspace.id, sessionId: session.id })
  useAppStore.setState({ ...original, config: { ...config, workspaces: [workspace] }, sessions: [session], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('footer-group', [tab.id]) }, activeWorkspaceId: workspace.id, mainSurface: 'workbench', timelines: {}, agentNames: {}, workbenchSpaceSelection: null, surveyZoneSelection: null, agentFocus: { execution: { sessionId: session.id, history: [] }, pmo: { sessionId: null } } }, true)
  useAppStore.getState().focusRegion(workspace.id, tab.id, 'footer-region', 'pointer', 'footer-group')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  openSettings.mockClear(); closeSettings.mockClear(); await mount()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('makes the three Work views one readable group, with independent Survey, settings and Mote entries', () => {
  const work = container.querySelector('[role="group"][aria-label="Work surfaces"]')!, utilities = container.querySelector('[role="group"][aria-label="Survey and Recall"]')!
  expect([...work.querySelectorAll('button')].map(item => item.getAttribute('aria-label')?.split(':')[0])).toEqual(['Space', 'Focus', 'Goals'])
  expect(work.textContent).not.toContain('Work')
  expect(work.querySelectorAll('[tabindex]')).toHaveLength(0)
  expect([...utilities.querySelectorAll('button')].map(item => item.getAttribute('aria-label')?.split(':')[0])).toEqual(['Survey', 'Recall'])
  const settings = container.querySelector('[role="group"][aria-label="App settings"]')!
  expect([...settings.querySelectorAll('button')].map(item => item.getAttribute('aria-label'))).toEqual(['Settings'])
  expect(utilities.nextElementSibling).toBe(settings)
  expect(work.contains(button('Survey'))).toBe(false); expect(work.contains(button('Settings'))).toBe(false)
  expect(document.querySelector('[aria-label="Open Mote coordination surface"]')?.closest('nav')).toBeNull()
  expect(container.querySelectorAll('nav[aria-label="Primary surfaces"]')).toHaveLength(1)
})
it('switches each original view without changing the Work address, Survey reference, Session or Run', async () => {
  const before = useAppStore.getState(); expect(before.workbenchSpaceSelection?.regionId).toBe('footer-region')
  for (const [name, surface] of [['Focus', 'agents'], ['Goals', 'board'], ['Survey', 'survey'], ['Recall', 'recall'], ['Space', 'workbench']] as const) {
    await act(async () => button(name).click())
    const state = useAppStore.getState(); expect(state.mainSurface).toBe(surface)
    expect(state.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection); expect(state.surveyZoneSelection).toBe(before.surveyZoneSelection)
    expect(state.sessions).toBe(before.sessions); expect(state.sessions[0]!.control).toBe(before.sessions[0]!.control)
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1); expect(button(name).getAttribute('aria-current')).toBe('page')
  }
})
it('opens and closes existing settings without turning it into a Work view or losing the background selection', async () => {
  const before = useAppStore.getState(); await act(async () => button('Settings').click())
  expect(openSettings).toHaveBeenCalledWith('overview'); expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(button('Space').getAttribute('aria-current')).toBe('page')
  await mount(true); expect(button('Settings').getAttribute('aria-expanded')).toBe('true')
  await act(async () => button('Settings').click()); expect(closeSettings).toHaveBeenCalledOnce()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  await act(async () => button('Survey').click()); expect(closeSettings).toHaveBeenCalledTimes(2)
})
it('keeps keyboard preview read-only and the original Focus click action reachable across the new group boundary', async () => {
  const before = useAppStore.getState(); await act(async () => button('Focus').focus())
  expect(document.querySelector('#surface-navigation-tooltip-focus')?.getAttribute('role')).toBe('tooltip')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection); expect(useAppStore.getState().mainSurface).toBe('workbench')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); expect(document.querySelector('#surface-navigation-tooltip-focus')).toBeNull()
  await act(async () => button('Focus').click()); expect(useAppStore.getState().mainSurface).toBe('agents')
})

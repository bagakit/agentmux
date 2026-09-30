// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
// Unrelated surfaces stay outside this input slice. The three callers and shared input are real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurveyBrowserTools', () => ({ SurveyBrowserTools: () => null }))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { LauncherSecondarySurfaces } from '../src/renderer/src/components/LauncherSecondarySurfaces'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig } from './helpers/composer-dom-fixture'

const workspace = composerConfig.workspaces[0]!
const tab = { id: 'page', browserId: 'page', regionId: 'page', kind: 'browser' as const, workspaceId: workspace.id,
  profileId: 'confirmed-profile', navigationId: 'nav', url: 'https://example.test/original', title: 'Original page',
  loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null }
const snapshot = { scope: { workspaceId: workspace.id, profileId: tab.profileId }, entries: [{ text: 'original search', submittedAt: 1 }] }
const initial = useAppStore.getState(), launcherInitial = useLauncherState.getState()
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id, tabs: {}, layouts: { [workspace.id]: createWorkspaceLayout('group', []) },
    mainSurface: 'survey', surveyZoneSelection: null, surveyCollectedZones: {}, surveyToolsOpen: false, toolsOpen: false, workbenchNavigationInputPolicy: 'preserve',
    scratchTopicSnapshots: {}, refreshScratchTopics: vi.fn(async () => {}), setSurveyZoneCollected: vi.fn(() => true), reportError: vi.fn(),
    executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] }) as never) })
  useLauncherState.setState({ drafts: {}, sections: {} })
  vi.spyOn(api.browser, 'listInputHistory').mockResolvedValue(snapshot)
  vi.spyOn(api.browser, 'recordInputHistory').mockResolvedValue({ ...snapshot, outcome: 'recorded' })
  vi.spyOn(api.browser, 'navigate').mockResolvedValue(tab)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); useLauncherState.setState(launcherInitial, true); vi.restoreAllMocks()
})
async function fill(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]'); expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit() {
  const form = container.querySelector('input[role="combobox"]')?.closest('form'); expect(form).not.toBeNull()
  await act(async () => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function inspectInputContextMenu() {
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]'); expect(input).not.toBeNull()
  await act(async () => input!.focus())
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
  // React delegates at this root; test the original event above that boundary.
  const bubbled = vi.fn(); document.body.addEventListener('contextmenu', bubbled)
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => input!.dispatchEvent(event))
  document.body.removeEventListener('contextmenu', bubbled)
  expect(event.defaultPrevented).toBe(false); expect(bubbled).not.toHaveBeenCalled()
}

it.each(['toolbar', 'survey blank'] as const)('the actual BrowserPane %s uses confirmed resource history and native right-click while navigating the human input', async mode => {
  const current = mode === 'toolbar' ? tab : { ...tab, url: 'about:blank' }
  await act(async () => root.render(<BrowserPane tab={current} visible {...(mode === 'survey blank' ? { controlPanelOpen: false } : {})} />))
  expect(container.querySelectorAll('input[role="combobox"]')).toHaveLength(1)
  await inspectInputContextMenu()
  expect(api.browser.listInputHistory).toHaveBeenCalledWith({ kind: 'browser', browserId: 'page', profileId: 'confirmed-profile' })
  await fill('human search ? original#fragment'); await submit()
  expect(api.browser.navigate).toHaveBeenCalledExactlyOnceWith('page', 'human search ? original#fragment')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith({ kind: 'browser', browserId: 'page', profileId: 'confirmed-profile' }, 'human search ? original#fragment')
})

it('a late real BrowserPane navigation update preserves a newer human draft and selection', async () => {
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  await fill('submitted'); await submit(); await fill('editing the next address')
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!; input.setSelectionRange(3, 7)
  await act(async () => root.render(<BrowserPane tab={{ ...tab, url: 'https://example.test/late' }} visible />))
  expect(input.value).toBe('editing the next address'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7])
  await act(async () => root.render(<BrowserPane tab={{ ...tab, browserId: 'different', url: 'https://example.test/other' }} visible />))
  expect(input.value).toBe('https://example.test/other')
})

it('the actual Launcher input shares resource history and right-click without waiting for a history save', async () => {
  const create = vi.fn(async () => {}); useAppStore.setState({ createBrowser: create })
  vi.mocked(api.browser.recordInputHistory).mockRejectedValueOnce(new Error('history unavailable'))
  await act(async () => root.render(<LauncherSecondarySurfaces workspace={workspace} tabGroupId="group" launcherRef={{ tabId: 'launcher', regionId: 'region' }} launcherId="launcher"
    sections={{ agents: 'hidden', terminal: 'hidden', browser: 'expanded', note: 'hidden' }} onSectionChange={vi.fn()} warmSession={null} warmPending={false}
    terminalThemeId="graphite" terminalFontSize={12} visible busy={null} onRun={async (_kind, action) => { await action() }} />))
  await inspectInputContextMenu(); expect(api.browser.listInputHistory).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: workspace.id })
  await fill('human launcher search'); await submit()
  expect(create).toHaveBeenCalledExactlyOnceWith('group', { tabId: 'launcher', regionId: 'region' }, 'human launcher search')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', workspaceId: workspace.id }, 'human launcher search')
  expect(container.textContent).toContain('history unavailable')
})

it('the actual Global Survey start form records only the human submission and preserves its original creation path', async () => {
  const zone = { zoneId: 'zone', workspaceId: workspace.id, spaceIds: [] }, region = 'region'
  const launcher = createWorkbenchTab('launcher', { kind: 'launcher', workspaceId: workspace.id, regionId: region })
  const create = vi.fn(async () => {
    useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { ...tab, browserId: region, regionId: region }) } })
  })
  useAppStore.setState({ createWorkbenchZone: vi.fn(async () => ({ zone, save: { localStorageWritten: true, storageFlushRequested: true }, issues: [] })) as never,
    openLauncher: vi.fn(() => { useAppStore.setState({ tabs: { launcher } }); return launcher.id }), createBrowser: create })
  await act(async () => root.render(<GlobalSurveySurface catalog={null} projection={null} />))
  await inspectInputContextMenu(); expect(api.browser.listInputHistory).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: workspace.id })
  await fill('human survey search'); expect(api.browser.recordInputHistory).not.toHaveBeenCalled(); await submit()
  expect(create).toHaveBeenCalledExactlyOnceWith('group', { tabId: 'launcher', regionId: region }, 'human survey search')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', workspaceId: workspace.id }, 'human survey search')
})

it('the actual compact Browser header expands its original input and only its human form submission creates and records', async () => {
  const create = vi.fn(async () => {}); useAppStore.setState({ createBrowser: create })
  useLauncherState.getState().setDraft('launcher', 'browser', 'kept compact draft')
  function CompactLauncher() {
    const [mode, setMode] = useState<'collapsed' | 'expanded' | 'hidden'>('collapsed')
    return <LauncherSecondarySurfaces workspace={workspace} tabGroupId="group" launcherRef={{ tabId: 'launcher', regionId: 'region' }} launcherId="launcher"
      sections={{ agents: 'hidden', terminal: 'hidden', browser: mode, note: 'hidden' }} onSectionChange={(section, next) => { if (section === 'browser') setMode(next) }}
      warmSession={null} warmPending={false} terminalThemeId="graphite" terminalFontSize={12} visible busy={null}
      onRun={async (_kind, action) => { await action() }} />
  }
  await act(async () => root.render(<CompactLauncher />))
  expect(container.querySelector('input[role="combobox"]')).toBeNull()
  expect(container.querySelector('[aria-label="Open Browser"]')).toBeNull()
  const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand Browser"]'); expect(expand).not.toBeNull()
  await act(async () => expand!.click())
  expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe('kept compact draft')
  expect(create).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await submit()
  expect(create).toHaveBeenCalledExactlyOnceWith('group', { tabId: 'launcher', regionId: 'region' }, 'kept compact draft')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', workspaceId: workspace.id }, 'kept compact draft')
})

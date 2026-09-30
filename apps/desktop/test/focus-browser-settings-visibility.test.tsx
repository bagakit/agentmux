// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
// Same installed browser primary used by the existing owning ratio/Header fixtures.
// Node primary registers Panels after the parent's layout effect and cannot own this DOM mount.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Only heavyweight adjacent presentation leaves are isolated. Actual App route state,
// WorkspaceWorkbench, StableWorkbenchView, BrowserPane and Store remain production modules.
// Actual GlobalFocusSurface supplies the current exact Workbench projection slot.
// Only the adjacent Timeline paint/read scope is isolated for this one Settings counter.
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId }: { sessionId: string }) => createElement('div', { 'data-fixture-agent': sessionId }, 'Original retained reading body')
}))
vi.mock('../src/renderer/src/components/SettingsPanel', () => ({
  SettingsPanel: ({ onClose }: { onClose: () => void }) => createElement('section', { 'data-fixture-settings': true },
    createElement('button', { 'data-fixture-settings-close': true, onClick: onClose }, 'Close settings'))
}))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { installNativePopover } from './fixtures/mote-workface'

const initial = useAppStore.getState()
const sourcePaths = ['apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/components/TopRowChrome.tsx',
  'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts',
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/preload/index.ts']
const identity = () => Object.fromEntries(sourcePaths.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')]))
const reports: unknown[] = []

it.each(['workbench', 'agents'] as const)('actual %s → Settings hides the retained Browser, and Settings return keeps its original instance', async (mainSurface) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const restorePopover = installNativePopover()
  const frames: { phase: string; browserId: string; visible: boolean }[] = []
  const residency: { phase: string; browserId: string; kind: string }[] = []
  let phase = 'mount'
  vi.stubGlobal('__focusBrowserVisibleCommit', (browserId: string, visible: boolean) => frames.push({ phase, browserId, visible }))
  vi.stubGlobal('__focusBrowserResidency', (browserId: string, kind: string) => residency.push({ phase, browserId, kind }))
  const sourceBefore = identity()
  const originalConfig = await api.config.get()
  const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/settings-topics', name: 'Topics', kind: 'folder' as const }
  // Current spatial catalog requires an explicit absolute resource; WebPreview's old relative demo path is not a confirmed directory.
  const originalResource = originalConfig.workspaces.find(workspace => workspace.id === 'workspace-demo')!
  expect(originalResource).toBeDefined()
  const resource = { ...originalResource, path: '/private/settings-proof-project' }
  const config = { ...originalConfig, workspaces: [...originalConfig.workspaces.map(workspace => workspace.id === resource.id ? resource : workspace), scratch] }
  const snapshot = await api.sessions.snapshot()
  const originalSession = snapshot.sessions.find(session => session.id === 'session-codex')!
  expect(originalSession).toBeDefined()
  const session = { ...originalSession, workspacePath: resource.path }
  const browserId = 'settings-visibility-browser'
  const tab = createWorkbenchTab('settings-visibility-tab', { regionId: 'agent-region', workspaceId: 'workspace-demo',
    kind: 'agent', phase: 'attached', sessionId: session.id })
  tab.regions['browser-region'] = { kind: 'browser', regionId: 'browser-region', workspaceId: tab.workspaceId,
    browserId, id: browserId, navigationId: 'settings-visibility-navigation', profileId: 'profile',
    url: 'https://example.test/unchanged', title: 'Original browser', loading: false, canGoBack: false,
    canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }
  tab.layout = splitWorkbenchRegion(tab.layout, 'agent-region', 'right', 'browser-region')
  const moteTopicId = 'launcher:settings-proof'
  const moteId = 'settings-foreground-mote-browser'
  const mote = { ...createWorkbenchTab('settings-foreground-mote-tab', {
    kind: 'browser', regionId: 'mote-browser-region', workspaceId: SCRATCH_WORKSPACE_ID,
    browserId: moteId, id: moteId, navigationId: 'mote-original-navigation', profileId: 'profile',
    url: 'https://example.test/mote-unchanged', title: 'Foreground Mote browser', loading: false,
    canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null
  }), topicId: moteTopicId }
  const path = scratch.path + '/' + scratchTopicDirectoryName(moteTopicId)
  const topic = { id: moteTopicId, directoryPath: path, topicPath: path + '/topic.md', title: 'Foreground Mote',
    summary: 'The other Tab stays usable above Settings.', collaborators: [],
    soul: { path: path + '/SOUL.md', content: '# SOUL', version: 'controlled-topic' } }
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false, config,
    sessions: [session], tabs: { [tab.id]: tab, [mote.id]: mote }, layouts: { 'workspace-demo': createWorkspaceLayout('original-group', [tab.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('foreground-mote-group', [mote.id]) },
    mainSurface, activeWorkspaceId: 'workspace-demo', toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: session.id, history: [], reference: { displayWorkspaceId: 'workspace-demo', groupId: 'original-group', tabId: tab.id, regionId: 'agent-region' } }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Original draft' } }, true)
  const fixtureReference = useAppStore.getState().agentFocus.execution.reference
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let hidden: boolean | undefined
  let restored: boolean | undefined
  let hiddenFacts: unknown = null
  const controlCalls = {
    create: vi.spyOn(api.browser, 'create'), close: vi.spyOn(api.browser, 'close'),
    release: vi.spyOn(api.browser, 'release'), restore: vi.spyOn(api.browser, 'restore'),
    navigate: vi.spyOn(api.browser, 'navigate')
  }
  const reads = {
    page: vi.spyOn(api.sessions, 'historyPage'),
    timeline: vi.spyOn(api.sessions, 'timeline'),
    catalogue: vi.spyOn(api.sessions, 'historySources')
  }
  try {
    await act(async () => root.render(createElement(App)))
    expect(container.querySelector('main.main-shell')).not.toBeNull()
    expect(container.querySelectorAll(`[data-native-browser-stage="${browserId}"]`)).toHaveLength(1)
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: mote.id, targetTopicId: moteTopicId }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const foreground = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')!
    expect(foreground).not.toBeNull()
    expect(foreground.matches(':popover-open')).toBe(true)
    const moteStage = foreground.querySelector(`[data-native-browser-stage="${moteId}"]`)!
    expect(moteStage).not.toBeNull()
    const moteHost = moteStage.closest('.retained-workbench-view')!
    expect(moteHost).not.toBeNull()
    const moteParent = moteHost.parentElement
    const original = useAppStore.getState()
    const moteFramesBeforeSettings = frames.filter(frame => frame.browserId === moteId)
    expect(moteFramesBeforeSettings.at(-1)?.visible).toBe(true)
    const browserStage = container.querySelector(`[data-native-browser-stage="${browserId}"]`)!
    const retainedHost = browserStage.closest('.retained-workbench-view')!
    expect(retainedHost).not.toBeNull()
    const originalParent = retainedHost.parentElement
    expect(originalParent).not.toBeNull()
    if (mainSurface === 'agents') expect(retainedHost.closest('.global-session-workspace')).not.toBeNull()
    const originalBody = retainedHost.querySelector<HTMLElement>('[data-fixture-agent]')!
    expect(originalBody).not.toBeNull()
    const text = originalBody.firstChild!
    expect(text).not.toBeNull()
    expect(text.nodeType).toBe(Node.TEXT_NODE)
    const reading = document.createRange()
    reading.setStart(text, 2); reading.setEnd(text, 19)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(reading)
    const originalSelection = document.getSelection()!.toString()
    expect(originalSelection.length).toBeGreaterThan(0)
    expect(frames.filter(frame => frame.browserId === browserId).at(-1)).toMatchObject({ browserId, visible: true })
    const readsBefore = Object.fromEntries(Object.entries(reads).map(([key, read]) => [key, read.mock.calls.length]))
    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
    expect(settings).not.toBeNull()
    phase = 'settings'
    await act(async () => settings.click())
    expect(container.querySelector('[data-fixture-settings]')).not.toBeNull()
    expect(container.querySelector('.app-shell__workspace')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector(`[data-native-browser-stage="${browserId}"]`)).toBe(browserStage)
    hidden = frames.filter(frame => frame.browserId === browserId).at(-1)!.visible
    const hiddenHost = browserStage.closest('.retained-workbench-view')!
    const hiddenSelection = document.getSelection()!
    hiddenFacts = { nonempty: true, originalParentId: originalParent!.id, hiddenParentId: hiddenHost.parentElement?.id,
      sameStage: container.querySelector(`[data-native-browser-stage="${browserId}"]`) === browserStage,
      sameHost: hiddenHost === retainedHost, sameParent: hiddenHost.parentElement === originalParent,
      stillFocusWorkspace: !!hiddenHost.closest('.global-session-workspace'), visible: hidden,
      bodySame: hiddenHost.querySelector('[data-fixture-agent]') === originalBody, originalSelection,
      selection: hiddenSelection.toString(), rangeCount: hiddenSelection.rangeCount,
      originalStartRetained: hiddenSelection.rangeCount > 0 && hiddenSelection.getRangeAt(0).startContainer === text,
      originalEndRetained: hiddenSelection.rangeCount > 0 && hiddenSelection.getRangeAt(0).endContainer === text }
    expect(hiddenHost.parentElement, 'Settings hides this binding; it must not move the original host home').toBe(originalParent)
    expect(hiddenHost.querySelector('[data-fixture-agent]')).toBe(originalBody)
    expect(hiddenSelection.rangeCount).toBe(1)
    expect(hiddenSelection.getRangeAt(0).startContainer).toBe(text)
    expect(hiddenSelection.getRangeAt(0).endContainer).toBe(text)
    expect(hiddenSelection.toString()).toBe(originalSelection)
    expect(foreground.matches(':popover-open')).toBe(true)
    expect(moteStage.closest('.retained-workbench-view')).toBe(moteHost)
    expect(moteHost.parentElement).toBe(moteParent)
    expect(frames.filter(frame => frame.browserId === moteId)).toEqual(moteFramesBeforeSettings)
    expect(foreground.querySelector(`[data-native-browser-stage="${moteId}"]`)).toBe(moteStage)
    // This real existing other-Tab Mote remains outside the inert background.
    expect(moteStage.closest('[inert]')).toBeNull()
    phase = 'return'
    await act(async () => container.querySelector<HTMLButtonElement>('[data-fixture-settings-close]')!.click())
    restored = frames.filter(frame => frame.browserId === browserId).at(-1)!.visible
    expect(container.querySelector('[data-fixture-settings]')).toBeNull()
    expect(container.querySelector(`[data-native-browser-stage="${browserId}"]`)).toBe(browserStage)
    expect(browserStage.closest('.retained-workbench-view')).toBe(retainedHost)
    expect(retainedHost.parentElement).toBe(originalParent)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().layouts).toBe(original.layouts)
    expect(useAppStore.getState().sessions).toBe(original.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(residency.filter(frame => frame.browserId === browserId)).toEqual([{ phase: 'mount', browserId, kind: 'mount' }])
    expect(residency.filter(frame => frame.browserId === moteId)).toHaveLength(1)
    expect(Object.fromEntries(Object.entries(reads).map(([key, read]) => [key, read.mock.calls.length]))).toEqual(readsBefore)
    const framesBeforeUnrelated = [...frames]
    await act(async () => useAppStore.setState({ agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts, 'unrelated-context': 'Unrelated draft' } }))
    expect(frames).toEqual(framesBeforeUnrelated)
    expect(Object.fromEntries(Object.entries(reads).map(([key, read]) => [key, read.mock.calls.length]))).toEqual(readsBefore)
    for (const call of Object.values(controlCalls)) expect(call).not.toHaveBeenCalled()
    expect(restored).toBe(true)
    expect(hidden, `${mainSurface} → Settings still tells the real BrowserPane it is visible`).toBe(false)
  } finally {
    const sourceAfter = identity()
    reports.push({ mainSurface, candidateInputPin: '02a76b8c29ab91dec67faf1c75bc7abb693fb6a0', rootObservedCommitOnly: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      hidden, restored, hiddenFacts, fixtureResource: { originalDemoPath: originalResource.path, currentAbsoluteResourcePath: resource.path, exactReference: fixtureReference }, focusRecoveryText: container.querySelector('.focus-location-recovery')?.textContent ?? null, foregroundMote: { browserId: moteId, frames: frames.filter(frame => frame.browserId === moteId), residency: residency.filter(frame => frame.browserId === moteId) }, frames: [...frames], residencyBeforeCleanup: [...residency], sourceBefore, sourceAfter,
      sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
      controls: Object.fromEntries(Object.entries(controlCalls).map(([key, fn]) => [key, fn.mock.calls.length])),
      historyReads: Object.fromEntries(Object.entries(reads).map(([key, fn]) => [key, fn.mock.calls.length])),
      conditions: { actualAppAndOriginalRetainedTree: true, settingsEnteredViaActualSurfaceSwitch: hiddenFacts !== null,
        observedBrowserPanePropViaAddedPassiveEffect: true, webPreviewApi: true,
        isolatedLeaves: ['RecentFocusTimeline adjacent paint/read scope only; actual GlobalFocusSurface/Workbench projection remains', 'SessionPane PTY/Agent painting only; added retained reading text for DOM Range', 'SettingsPanel content'],
        nativeWebContentsViewCreated: false, actualNativeHideMeasured: false, sharedRuntimeControlled: false } })
    phase = 'cleanup'; await act(async () => root.unmount()); container.remove(); restorePopover()
    useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    if (process.env.AGENTMUX_BROWSER_SETTINGS_REPORT) writeFileSync(process.env.AGENTMUX_BROWSER_SETTINGS_REPORT, JSON.stringify({ reports }, null, 2) + '\n')
  }
})

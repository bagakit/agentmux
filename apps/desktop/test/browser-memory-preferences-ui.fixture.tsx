// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useSurfaceMemoryBudget } from '../src/renderer/src/lib/surface-memory-budget-coordinator'
import { selectSurfaceMemoryReleases, nextSurfaceMemoryDeadlineMs, type SurfaceMemoryCandidate } from '../src/renderer/src/lib/surface-memory-budget'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { PerformancePanel } from '../src/renderer/src/components/performance/PerformancePanel'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'

const original = useAppStore.getState()
let root: ReturnType<typeof createClientUiRoot> | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})
function mount() { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container) }
const candidate = (kind: 'browser' | 'monaco'): SurfaceMemoryCandidate => ({ id: kind, kind, visible: false,
  navigationContextActive: true, hiddenSinceMs: 0, lastActivatedSeq: 0, ownerPresent: true, canRebuild: true, protected: false })
it('turns off only Browser selections and deadlines, keeping the independent Monaco policy', () => {
  const all = [candidate('browser'), candidate('monaco')], policy = { nowMs: 300001, browserAutomaticMemoryRelease: false }
  expect(selectSurfaceMemoryReleases(all, policy)).toEqual(new Set(['monaco']))
  expect(nextSurfaceMemoryDeadlineMs([candidate('browser')], { ...policy, nowMs: 1 })).toBeNull()
  expect(nextSurfaceMemoryDeadlineMs(all, { ...policy, nowMs: 1 })).toBe(59999)
  expect(selectSurfaceMemoryReleases(all, { nowMs: 300001 })).toEqual(new Set(['browser', 'monaco']))
})
it('the real coordinator consumes saved changes without waking an already released hidden original Pane', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); mount()
  const browser = (id: string, released = false) => createWorkbenchTab('tab-' + id, { kind: 'browser', regionId: 'region-' + id,
    workspaceId: 'workspace', id, browserId: id, navigationId: 'nav-' + id, profileId: 'original-profile', mode: 'normal', viewport: 'responsive',
    url: 'https://fixture.invalid/' + id, title: id, loading: false, driving: false, appLinkPrompt: null, error: null,
    canGoBack: false, canGoForward: false, retention: { status: 'eligible', reasons: [] }, ...(released ? { nativeOwnerReleased: true } : {}) })
  const active = createWorkbenchTab('launcher', { kind: 'launcher', regionId: 'launcher-region', workspaceId: 'workspace' })
  const live = browser('live'), released = browser('released', true)
  const file = createWorkbenchTab('file', { kind: 'file', regionId: 'file-region', workspaceId: 'workspace', path: 'draft.md' })
  const tabs = Object.fromEntries([active, live, released, file].map(tab => [tab.id, tab]))
  useAppStore.setState({ config: { ...composerConfig, browser: { ...composerConfig.browser, automaticMemoryRelease: false } }, tabs,
    layouts: { workspace: createWorkspaceLayout('group', Object.keys(tabs)) }, activeWorkspaceId: 'workspace',
    documents: { 'workspace\0draft.md': {} as never }, dirtyDocuments: {}, savingDocuments: {} })
  const restore = vi.spyOn(api.browser, 'restore'), create = vi.spyOn(api.browser, 'create'), release = vi.spyOn(api.browser, 'release')
  function Probe() {
    const budget = useSurfaceMemoryBudget({ workbenchVisible: true })
    return <><output data-browser={[...budget.browserRegionIds].join(',')} data-monaco={[...budget.monacoRegionIds].join(',')} />
      <BrowserPane tab={released.regions['region-released'] as BrowserWorkbenchSurface} visible={false} released={budget.browserRegionIds.has('region-released')} /></>
  }
  await act(async () => root!.render(<Probe />))
  await act(async () => vi.advanceTimersByTimeAsync(300001))
  expect(container!.querySelector('output')!.dataset.browser).toBe('')
  expect(container!.querySelector('output')!.dataset.monaco).toBe('file-region')
  expect(useAppStore.getState().tabs).toBe(tabs)
  expect(restore).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, browser: { ...state.config!.browser, automaticMemoryRelease: true } } })))
  // Existing released membership is retained; it does not issue another native release.
  expect(new Set(container!.querySelector('output')!.dataset.browser!.split(','))).toEqual(new Set(['region-live', 'region-released']))
  expect(release).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, browser: { ...state.config!.browser, automaticMemoryRelease: false } } })))
  expect(container!.querySelector('output')!.dataset.browser).toBe('')
  expect(restore).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs['tab-released']!.regions['region-released']).toHaveProperty('nativeOwnerReleased', true)
})
it('the actual Performance popover closes before opening original Browser settings and keeps Toolkit Configure', async () => {
  mount(); const opened: string[] = [], order: string[] = []
  const inspect = vi.spyOn(api.performance, 'inspectScene').mockResolvedValue({ status: 'absent', scene: null, issue: null })
  const capture = vi.spyOn(api.performance, 'captureScene')
  vi.spyOn(api.toolkit, 'observe').mockReturnValue({ dispose() {} })
  useAppStore.setState({ config: { ...composerConfig, toolkit: { performance: { enabled: true, statusBar: 'label' } } } })
  function Fixture() {
    const [selectedToolId, setSelectedTool] = useState<string | symbol | null>(null)
    const onSelectTool = (value: string | symbol | null) => { if (value === null) order.push('close'); setSelectedTool(value) }
    return <SettingsNavigation.Provider value={{ open(tab) { opened.push(tab); order.push('open:' + tab) },
      openToolkit() {}, openHost() {}, openChannel() {}, channelPresentation: () => null, channelEntries: [], openMoteLark() {}, chooseAgent() {} }}>
      <PerformancePanel selectedToolId={selectedToolId} onSelectTool={onSelectTool} /></SettingsNavigation.Provider>
  }
  await act(async () => root!.render(<Fixture />))
  const click = async (selector: string) => act(async () => container!.querySelector<HTMLButtonElement>(selector)!.click())
  await click('.performance-trigger')
  const byText = (text: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text); expect(button).toBeDefined(); return button! }
  await act(async () => byText('Manage browsers').click())
  expect(opened).toEqual(['browser']); expect(order).toEqual(['close', 'open:browser'])
  expect(document.querySelector('.performance-popover')).toBeNull()
  await click('.performance-trigger'); await act(async () => byText('Configure').click())
  expect(opened).toEqual(['browser', 'toolkit']); expect(order).toEqual(['close', 'open:browser', 'close', 'open:toolkit'])
  expect(document.querySelector('.performance-popover')).toBeNull(); expect(inspect).toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
// Terminal and Browser rendering are outside close ownership; actual Workbench, modal and Store are mounted.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session-id={sessionId}>{sessionId}</output> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <output>Changed editor</output> }))
vi.mock('../src/renderer/src/components/BrowserPane', () => ({ BrowserPane: () => <output>Browser</output> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { regionExecutionHost } from '../src/renderer/src/lib/region-execution-host'
import { connectWorkbenchCloseApiOwner } from './helpers/workbench-close-api-owner'
import { WorkbenchCloseRequests } from '../src/renderer/src/hooks/useWorkbenchTabsClose'

const initial = useAppStore.getState()
let root: Root, element: HTMLDivElement, overlay: HTMLDivElement
let closeOwner: Awaited<ReturnType<typeof connectWorkbenchCloseApiOwner>>
const lonely = composerSession('lonely')
const shared = composerSession('shared')
const file = { kind: 'file' as const, regionId: 'file-region', workspaceId: 'workspace', path: 'changed.txt' }
const split = addWorkbenchRegion(
  createWorkbenchTab('split', { kind: 'agent', regionId: 'lonely-region', phase: 'attached', workspaceId: 'workspace', sessionId: lonely.id }),
  'lonely-region', 'right', file)
const elsewhere = createWorkbenchTab('elsewhere', { kind: 'agent', regionId: 'shared-region', phase: 'attached', workspaceId: 'workspace', sessionId: shared.id })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  element = document.createElement('div'); overlay = document.createElement('div'); overlay.dataset.overlayHost = ''
  document.body.append(element, overlay); root = createRoot(element)
  useAppStore.setState({ config: composerConfig, sessions: [lonely, shared], loading: false, mainSurface: 'workbench', activeWorkspaceId: 'workspace',
    tabs: { [split.id]: split, [elsewhere.id]: elsewhere }, layouts: { workspace: createWorkspaceLayout('group', [split.id, elsewhere.id]) },
    agentNames: { [lonely.id]: 'Lonely Reviewer' },
    closingWorkbenchViews: {}, closeTabRequest: null, closeRegionRequest: null, error: null, dirtyDocuments: {},
    documents: { [documentKey('workspace', 'changed.txt')]: { path: 'changed.txt', content: 'Original changed editor content', revision: 'original-file-revision' } },
    agentOperations: {}, agentComposerDrafts: { [lonely.id]: 'Original unsent draft' }, prewarmTerminal: vi.fn() })
  useAppStore.getState().activateTab('workspace', 'group', split.id)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, operationId) =>
    control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  closeOwner = await connectWorkbenchCloseApiOwner()
})
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); overlay.remove()
  await closeOwner.dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})
// Real presentation consumers read the original Store operation independently of the isolated PTY body.
function FeedbackConsumers() {
  const project = useMemo(createFocusProjectionSelector, [])
  const { contexts } = useAppStore(project)
  return <aside>
    {contexts.filter(context => context.id === lonely.id).map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)}
    <div data-original-region-header=""><AgentRegionHeader name="Lonely Reviewer" executorLabel="Codex"
      sessionId={lonely.id} sessionKind="agent" executionHost={regionExecutionHost(lonely)}
      regionId="lonely-region" readOnly={false} onHistory={undefined} /></div>
    <input aria-label="Neighboring work" defaultValue="Keep working" />
  </aside>
}
async function mount(feedback = false) {
  await act(async () => root.render(<><WorkbenchCloseRequests /><WorkspaceWorkbench workspaceId="workspace" />{feedback ? <FeedbackConsumers /> : null}</>))
}
async function closeSplit(regionId: string) {
  const close = element.querySelector<HTMLElement>(`[data-workbench-region-id="${regionId}"] .workbench-region__close`)
  expect(close, `Close split on ${regionId}`).not.toBeNull(); await act(async () => { close!.click(); await closeOwner.settle() })
}
async function click(label: string, settled = true) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(button, `Actual close action ${label}`).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => { button!.click(); if (settled) await closeOwner.settle() })
  if (!settled) await vi.waitFor(() => expect(api.sessions.stop).toHaveBeenCalled())
}
const dialog = () => document.querySelector('[role="dialog"]')
const regions = () => Object.keys(useAppStore.getState().tabs[split.id]!.regions)

it.each(['tab', 'region'] as const)('[confirmation-target] %s rejects a replacement Agent before the original Stop and permits a fresh request', async kind => {
  await mount(); await askClose(kind)
  await act(async () => useAppStore.setState(state => ({ tabs: { [split.id]: { ...state.tabs[split.id]!, regions: {
    ...state.tabs[split.id]!.regions, 'lonely-region': { ...split.regions['lonely-region']!, sessionId: shared.id } } } },
    layouts: { workspace: createWorkspaceLayout('group', [split.id]) } })))
  const replacement = useAppStore.getState().tabs[split.id]!
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(dialog()).toBeNull()
  expect(useAppStore.getState().tabs[split.id]).toBe(replacement)
  expect(String(useAppStore.getState().error ?? '')).toContain('Inspect with amux space close inspect')
  expect(useAppStore.getState().sessions.find(session => session.id === shared.id)?.control).toEqual(shared.control)
  await askClose(kind); await click('Keep Session & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
})

it.each(['tab', 'region'] as const)('[confirmation-target] %s permits title favicon and ordinary status updates', async kind => {
  const browser = { ...file, kind: 'browser' as const, id: 'metadata-browser', browserId: 'metadata-browser', regionId: 'metadata-browser-region',
    navigationId: 'metadata-navigation', mode: 'normal' as const, profileId: 'profile', url: 'https://example.test/', title: 'Before',
    loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null, agent: null }
  const withBrowser = addWorkbenchRegion(split, 'file-region', 'right', browser)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [split.id]: withBrowser } }))
  await mount(); await askClose(kind)
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [split.id]: { ...withBrowser, name: 'Updated title',
    regions: { ...withBrowser.regions, [browser.regionId]: { ...browser, title: 'After', faviconDataUrl: 'data:image/png;base64,AA==' } } } },
    sessions: state.sessions.map(session => session.kind === 'agent' && session.id === lonely.id ? { ...session, label: 'Updated Agent', status: { ...session.status, state: 'waiting' as const, observedAt: 12 } } : session) })))
  await click('Stop & Close')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
})

it.each(['tab', 'region'] as const)('[confirmation-target] %s requires a current review after the old Stop plan gains another View', async kind => {
  await mount(); await askClose(kind)
  const other = createWorkbenchTab('new-view', { ...split.regions['lonely-region']!, regionId: 'new-view-region' })
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [other.id]: other },
    layouts: { workspace: createWorkspaceLayout('group', [split.id, elsewhere.id, other.id]) } })))
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeDefined()
  expect(useAppStore.getState().tabs[other.id]).toBe(other)
  expect(useAppStore.getState().sessions.find(session => session.id === lonely.id)?.control).toEqual(lonely.control)
  await applyCurrentKeep(kind)
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
  expect(useAppStore.getState().tabs[other.id]).toBe(other)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('[confirmation-target] a new display invalidates the old Stop approval; a current Keep plan removes only the selected binding', async () => {
  const placeholder = createWorkbenchTab('other-placeholder', { kind: 'launcher', regionId: 'placeholder-region', workspaceId: 'workspace' })
  const layout = createWorkspaceLayout('group', [split.id, elsewhere.id])
  layout.groups.push({ id: 'new-display', tabOrder: [placeholder.id], activeTabId: placeholder.id, recentTabIds: [placeholder.id] })
  layout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: layout.root, second: { type: 'leaf', groupId: 'new-display' } }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [placeholder.id]: placeholder }, layouts: { workspace: layout } }))
  await mount(); await askClose('tab')
  const state = useAppStore.getState()
  await act(async () => useAppStore.setState({ layouts: { workspace: { ...layout, groups: layout.groups.map(group => group.id === 'new-display'
    ? { ...group, tabOrder: [placeholder.id, split.id], activeTabId: split.id, recentTabIds: [placeholder.id, split.id] } : group) } } }))
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[split.id]).toBe(state.tabs[split.id])
  expect(useAppStore.getState().layouts.workspace!.groups.find(group => group.id === 'group')!.tabOrder).toContain(split.id)
  await applyCurrentKeep('tab')
  expect(useAppStore.getState().layouts.workspace!.groups.find(group => group.id === 'group')!.tabOrder).not.toContain(split.id)
  expect(useAppStore.getState().layouts.workspace!.groups.find(group => group.id === 'new-display')!.tabOrder).toContain(split.id)
})

it.each(['tab', 'region'] as const)('[confirmation-target] %s retains an unconfirmed old Stop target until a current explicit view-only review', async kind => {
  await mount(); await askClose(kind)
  await act(async () => useAppStore.setState({ sessions: [] }))
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeDefined()
  await applyCurrentKeep(kind)
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

async function applyCurrentKeep(kind: 'tab' | 'region') {
  await act(async () => {
    const record = await useAppStore.getState().prepareWorkbenchClose({ target: { kind: kind === 'tab' ? 'tab-occurrence' : 'region', displayWorkspaceId: 'workspace', groupId: 'group', tabId: split.id,
      ...(kind === 'region' ? { regionId: 'lonely-region' } : {}) } as import('@agentmux/core').SpaceCloseTarget, keepAgentSessions: true })
    await useAppStore.getState().applyWorkbenchClose(record)
  })
}

it('[confirmation-target] a new Run requires a new Stop confirmation for the same Session', async () => {
  await mount(); await askClose('tab')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' && session.id === lonely.id
    ? { ...session, control: { ...session.control, run: { runId: 'new-original-run' } } } : session) })))
  const original = useAppStore.getState().tabs[split.id]
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[split.id]).toBe(original)
  await askClose('tab'); await click('Keep Session & Close')
  expect(useAppStore.getState().tabs[split.id]).toBeUndefined(); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('[confirmation-target] the same file path in another resource Workspace is replacement content', async () => {
  useAppStore.setState({ dirtyDocuments: { [documentKey(file.workspaceId, file.path)]: true } })
  await mount(); await askClose('tab')
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [split.id]: { ...split,
    regions: { ...split.regions, [file.regionId]: { ...file, workspaceId: 'different-resource' } } } } })))
  const replacement = useAppStore.getState().tabs[split.id]
  await click('Stop & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[split.id]).toBe(replacement)
  expect(useAppStore.getState().dirtyDocuments[documentKey(file.workspaceId, file.path)]).toBe(true)
})

it.each(['missing', 'exited'] as const)('[confirmation-target] Region Stop succeeds when its confirmed receipt leaves the Session %s', async outcome => {
  vi.mocked(api.sessions.stop).mockImplementationOnce(async (control, operationId) => {
    const receipt = control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined
    useAppStore.setState(state => ({ sessions: outcome === 'missing' ? state.sessions.filter(session => session.id !== lonely.id)
      : state.sessions.map(session => session.id === lonely.id ? { ...session, processState: 'exited' as const } : session) }))
    return receipt
  })
  await mount(); await askClose('region'); await click('Stop & Close')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
})

it('[confirmation-target] a new Run appearing after the Region Stop receipt remains visible', async () => {
  vi.mocked(api.sessions.stop).mockImplementationOnce(async (control, operationId) => {
    const receipt = control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined
    useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' && session.id === lonely.id
      ? { ...session, control: { ...session.control, run: { runId: 'late-new-run' } } } : session) }))
    return receipt
  })
  await mount(); await askClose('region'); await click('Stop & Close')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toEqual(split.regions['lonely-region'])
  expect(useAppStore.getState().sessions.find(session => session.id === lonely.id)?.control.run.runId).toBe('late-new-run')
})

async function askClose(kind: 'tab' | 'region') {
  if (kind === 'region') await closeSplit('lonely-region')
  else {
    const close = element.querySelector<HTMLElement>(`.workbench-tab[data-workbench-tab-id="${split.id}"] .workbench-tab__close`)
    expect(close).not.toBeNull()
    await act(async () => { close!.click(); await closeOwner.settle() })
  }
  expect(dialog()?.textContent).toContain('Stop Agent Session?')
}

it.each(['tab', 'region'] as const)('%s Stop & Close dismisses immediately while its original Stop and both feedback consumers remain pending', async kind => {
  let release!: () => void
  vi.mocked(api.sessions.stop).mockImplementationOnce((control, operationId) => new Promise(resolve => {
    release = () => resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  }))
  await mount(true); await askClose(kind); await click('Stop & Close', false)
  const neighbor = element.querySelector<HTMLInputElement>('[aria-label="Neighboring work"]')!
  try {
    expect(dialog()).toBeNull()
    expect(regions()).toContain('lonely-region')
    expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
    expect(element.querySelector('.focus-context-card .agent-operation-feedback[data-phase="pending"]')?.textContent).toContain('停止中')
    expect(element.querySelector('[data-original-region-header] .agent-operation-feedback[data-phase="pending"]')?.textContent).toContain('停止中')
    expect(useAppStore.getState().agentComposerDrafts[lonely.id]).toBe('Original unsent draft')
    neighbor.focus(); neighbor.value = 'Continue neighboring work'
    expect(document.activeElement).toBe(neighbor)
  } finally { await act(async () => { release(); await closeOwner.settle() }) }
  expect(dialog()).toBeNull()
  expect(useAppStore.getState().tabs[elsewhere.id]).toEqual(elsewhere)
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toBeUndefined()
  expect(neighbor.value).toBe('Continue neighboring work')
  expect(document.activeElement).toBe(neighbor)
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
})

it.each(['tab', 'region'] as const)('%s Stop & Close retains the original View and nonmodal feedback after an unconfirmed Stop', async kind => {
  let reject!: (error: Error) => void
  vi.mocked(api.sessions.stop).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await mount(true); await askClose(kind); await click('Stop & Close', false)
  try { expect(dialog()).toBeNull() }
  finally { await act(async () => { reject(new Error('Original Stop observation unavailable')); await closeOwner.settle() }) }
  expect(dialog()).toBeNull()
  expect(regions()).toContain('lonely-region')
  expect(useAppStore.getState().agentComposerDrafts[lonely.id]).toBe('Original unsent draft')
  expect(element.querySelector('.focus-context-card .agent-operation-feedback[data-phase="unconfirmed"]')?.textContent).toContain('停止未确认')
  expect(element.querySelector('[data-original-region-header] .agent-operation-feedback[data-phase="unconfirmed"]')?.textContent).toContain('停止未确认')
  expect(String(useAppStore.getState().error?.message ?? useAppStore.getState().error)).toContain('Original Stop observation unavailable')
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
})

it.each(['tab', 'region'] as const)('%s Stop & Close cannot remove a replacement Region after the original Stop returns', async kind => {
  let release!: () => void
  vi.mocked(api.sessions.stop).mockImplementationOnce((control, operationId) => new Promise(resolve => {
    release = () => resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  }))
  await mount(true); await askClose(kind); await click('Stop & Close', false)
  const replacement = { ...split.regions['lonely-region']!, sessionId: shared.id }
  try {
    expect(dialog()).toBeNull()
    await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs,
      [split.id]: { ...state.tabs[split.id]!, regions: { ...state.tabs[split.id]!.regions, 'lonely-region': replacement } } } })))
  } finally { await act(async () => { release(); await closeOwner.settle() }) }
  expect(useAppStore.getState().tabs[split.id]?.regions['lonely-region']).toEqual(replacement)
  expect(useAppStore.getState().tabs[elsewhere.id]).toEqual(elsewhere)
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(dialog()).toBeNull()
})

it('split X on an Agent’s last View asks first and names it; Stop & Close stops that exact Run, then closes', async () => {
  await mount(); await closeSplit('lonely-region')
  expect(dialog()?.textContent).toContain('Stop Agent Session?')
  expect(dialog()?.textContent).toContain('Lonely Reviewer')
  expect(regions()).toEqual(['lonely-region', 'file-region'])
  expect(api.sessions.stop).not.toHaveBeenCalled()
  await click('Stop & Close')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(regions()).toEqual(['file-region'])
  expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
  expect(dialog()).toBeNull()
})

it('Keep Session & Close closes only the presentation', async () => {
  await mount(); await closeSplit('lonely-region')
  await click('Keep Session & Close')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(regions()).toEqual(['file-region'])
  expect(useAppStore.getState().sessions).toEqual([lonely, shared])
})

it('a failed Stop keeps the only View and reports it', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValue(new Error('Runtime stop step failed'))
  await mount(); await closeSplit('lonely-region'); await click('Stop & Close')
  expect(regions()).toEqual(['lonely-region', 'file-region'])
  expect(String(useAppStore.getState().error?.message ?? useAppStore.getState().error)).toContain('Runtime stop step failed')
  expect(useAppStore.getState().closingWorkbenchViews).toEqual({})
})

it('a dirty file split keeps its discard confirmation; the Agent split beside it asks Stop; Cancel keeps both', async () => {
  useAppStore.setState({ dirtyDocuments: { [documentKey('workspace', 'changed.txt')]: true } })
  const both = addWorkbenchRegion(
    createWorkbenchTab('split', { kind: 'agent', regionId: 'lonely-region', phase: 'attached', workspaceId: 'workspace', sessionId: lonely.id }),
    'lonely-region', 'right', file)
  useAppStore.setState({ tabs: { [both.id]: both, [elsewhere.id]: elsewhere } })
  await mount(); await closeSplit('file-region')
  expect(dialog()?.textContent).toContain('Discard editor contents?')
  await click('Cancel')
  await closeSplit('lonely-region')
  expect(dialog()?.textContent).toContain('Stop Agent Session?')
  await click('Cancel')
  expect(regions()).toEqual(['lonely-region', 'file-region'])
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it.each(['mouse', 'keyboard'] as const)('tab dirty file close uses the shared confirmation and Cancel preserves it (%s)', async input => {
  const original = createWorkbenchTab('split', file)
  useAppStore.setState({ tabs: { [original.id]: original, [elsewhere.id]: elsewhere },
    dirtyDocuments: { [documentKey('workspace', 'changed.txt')]: true } })
  await mount()
  if (input === 'keyboard') await act(async () => { useAppStore.getState().requestCloseTab('workspace', 'group', original.id); await closeOwner.settle() })
  else {
    const close = element.querySelector<HTMLButtonElement>('[data-workbench-tab-id="split"] .workbench-tab__close')!
    await act(async () => { close.click(); await closeOwner.settle() })
  }
  expect(dialog()?.textContent).toContain('Discard editor contents?')
  await click('Cancel')
  expect(useAppStore.getState().tabs[original.id]).toBe(original)
  expect(useAppStore.getState().dirtyDocuments[documentKey('workspace', 'changed.txt')]).toBe(true)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('tab discard confirms only the requested file Tab and keeps its neighbor', async () => {
  const original = createWorkbenchTab('split', file)
  useAppStore.setState({ tabs: { [original.id]: original, [elsewhere.id]: elsewhere },
    dirtyDocuments: { [documentKey('workspace', 'changed.txt')]: true } })
  await mount()
  await act(async () => { element.querySelector<HTMLButtonElement>('[data-workbench-tab-id="split"] .workbench-tab__close')!.click(); await closeOwner.settle() })
  expect(dialog()?.textContent).toContain('Discard editor contents?')
  await click('Discard & Close')
  expect(useAppStore.getState().tabs[original.id]).toBeUndefined()
  expect(useAppStore.getState().tabs[elsewhere.id]).toBe(elsewhere)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('another View of the same Agent closes the split silently without Stop', async () => {
  const twin = addWorkbenchRegion(
    createWorkbenchTab('split', { kind: 'agent', regionId: 'shared-split-region', phase: 'attached', workspaceId: 'workspace', sessionId: shared.id }),
    'shared-split-region', 'right', file)
  useAppStore.setState({ tabs: { [twin.id]: twin, [elsewhere.id]: elsewhere } })
  await mount(); await closeSplit('shared-split-region')
  expect(dialog()).toBeNull()
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(regions()).toEqual(['file-region'])
})

it('keyboard close of the Region takes the same confirmation', async () => {
  await mount()
  await act(async () => { useAppStore.getState().requestCloseRegion('workspace', split.id, 'lonely-region'); await closeOwner.settle() })
  expect(dialog()?.textContent).toContain('Stop Agent Session?')
  expect(regions()).toEqual(['lonely-region', 'file-region'])
})

it('closing a Browser Region bound to a live Agent with no other View stops that Agent, then releases the Browser', async () => {
  const browser = { id: 'page', navigationId: 'page:navigation', regionId: 'browser-region', kind: 'browser' as const, workspaceId: 'workspace',
    browserId: 'page', profileId: null, url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false,
    viewport: 'responsive' as const, error: null,
    control: { owner: 'human' as const, activeOperationId: null, revision: 1, inputIsolation: 'inactive' as const,
      agent: { hostId: lonely.control.hostId, agentSessionId: lonely.control.agentSessionId } } }
  const withBrowser = addWorkbenchRegion(createWorkbenchTab('split', file), 'file-region', 'right', browser)
  useAppStore.setState({ tabs: { [withBrowser.id]: withBrowser, [elsewhere.id]: elsewhere } })
  const approved = await useAppStore.getState().prepareWorkbenchClose({ target: { kind: 'region', displayWorkspaceId: 'workspace', groupId: 'group', tabId: split.id, regionId: 'browser-region' }, keepAgentSessions: false })
  await useAppStore.getState().closeRegion('workspace', split.id, 'browser-region', { approved })
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(lonely.control, expect.any(String))
  expect(api.browser.close).toHaveBeenCalledExactlyOnceWith('page')
  expect(regions()).toEqual(['file-region'])
  vi.mocked(api.sessions.stop).mockClear()
  useAppStore.setState({ tabs: { [withBrowser.id]: withBrowser, [elsewhere.id]: elsewhere } })
  await useAppStore.getState().closeRegion('workspace', split.id, 'browser-region', { keepAgentSessions: true })
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(regions()).toEqual(['file-region'])
})

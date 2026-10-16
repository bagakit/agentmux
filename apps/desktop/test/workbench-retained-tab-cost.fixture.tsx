// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { conversationRevision } from '@agentmux/core/conversation'
import { normalizeAgentTimelineItem } from '@agentmux/core/timeline'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { App } from '../src/renderer/src/App'
import { addWorkbenchRegion, createWorkbenchTab, focusWorkbenchTabRegion } from '../src/renderer/src/lib/workbench-tabs'
import type { RegionSwapMenuEntry } from '../src/renderer/src/lib/workbench-tab-actions'
import type { WorkbenchViewTargets } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


// Keep the original Store, Workbench, Pane, Activity, Composer and editor.
// Only PTY painting and the native Desktop API ports are controlled in Node.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))

type Counts = {
  workspace: number
  hosts: Record<string, number>
  trees: Record<string, number>
  paneRender: Record<string, number>
  composerRender: Record<string, number>
  paneCommit: Record<string, number>
  composerCommit: Record<string, number>
  browser: Record<string, number>
  paneProps: Record<string, { visible: boolean; interactiveResize: boolean }>
  menus: Record<string, readonly RegionSwapMenuEntry[]>
}
const globals = globalThis as typeof globalThis & { __retainedTabCounts: Counts }
const counts = () => globals.__retainedTabCounts
function reset() {
  globals.__retainedTabCounts = { workspace: 0, hosts: {}, trees: {}, paneRender: {}, composerRender: {},
    paneCommit: {}, composerCommit: {}, browser: {}, paneProps: {}, menus: {} }
}
const dom = composerDOM()
let syncConversation: (sessionId: string) => Promise<void>
const a = 'retained-agent-a', b = 'retained-agent-b'
const browser = { id: 'retained-browser', mode: 'normal' as const, navigationId: 'original-navigation',
  profileId: 'original-profile', url: 'https://example.test/original', title: 'Original page', loading: false,
  canGoBack: false, canGoForward: false, viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null }
const region = (id: string) => dom.container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)!
const settle = async () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })
const noNative = () => [api.browser.create, api.browser.restore, api.browser.armPresentationCapture,
  api.browser.captureScreenshot, api.browser.openDevTools]

beforeEach(async () => {
  expect(homedir()).toBe(process.env.AGENTMUX_RETAINED_TAB_PRIVATE_HOME)
  for (const name of ['HOME', 'CODEX_HOME', 'AGENTMUX_RUNTIME_DIR', 'AGENTMUX_STATE_DIR']) {
    expect(process.env[name]).toContain(process.env.AGENTMUX_RETAINED_TAB_PRIVATE_ROOT)
  }
  reset()
  vi.spyOn(Date, 'now').mockReturnValue(_historyFixtureEpoch(0, 1, 0))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const sourceFor = (reference: { agentSessionId: string }) => ({ providerId: 'codex', nativeSessionId: `original-source-${reference.agentSessionId}` })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async reference => ({ source: sourceFor(reference), dispose() {} }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async reference => ({ agentSessionId: reference.agentSessionId, source: sourceFor(reference), items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input) => ({ ...reference, source: input.source,
    kind: 'user-message', revision: 'a'.repeat(64), availability: 'empty', order: 'newest-first', items: [], userMessages: [],
    budgetBytes: 128 * 1024, scan: { examined: 0, complete: true }, nextCursor: null }))
  vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => ({ leaseId: `original-${request.occurrence.presentationId}` }))
  vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'create'); vi.spyOn(api.browser, 'restore'); vi.spyOn(api.browser, 'armPresentationCapture')
  vi.spyOn(api.browser, 'captureScreenshot'); vi.spyOn(api.browser, 'openDevTools')
  const conversation = await agentCardConversationFixture(sourceFor)
  syncConversation = sessionId => conversation.sync({ hostId: 'local', agentSessionId: sessionId })
})
afterEach(() => vi.unstubAllGlobals())

function append(sessionId: string, content: string) {
  const revision = (useAppStore.getState().timelines[sessionId]?.revision ?? 0) + 1
  const item = normalizeAgentTimelineItem({ id: `record-${sessionId}-${revision}`, agentSessionId: sessionId,
    kind: 'assistant_message', status: 'complete', source: 'native-hook', title: 'Original reading',
    content, createdAt: _historyFixtureEpoch(0, 0, 100) + revision, updatedAt: _historyFixtureEpoch(0, 0, 100) + revision })
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-timeline', agentSessionId: sessionId, sourceHostId: 'local', revision,
    stream: { epoch: `original-${sessionId}`, sequence: revision, revision, origin: 'beginning', gaps: [] },
    position: { id: item.id, sequence: revision, firstSequence: revision, revision: conversationRevision(item) },
    mutation: { type: 'append', agentSessionId: sessionId, item },
    evidence: { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 100) + revision, run: { runId: `run-${sessionId}` } }
  } })
  expect(useAppStore.getState().timelines[sessionId]!.items.at(-1)).toEqual(item)
  expect(useAppStore.getState().timelines[sessionId]!.stream?.sequence).toBe(revision)
}
function fixture(kind: 'browser' | 'agent') {
  const tabB = createWorkbenchTab('tab-b', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'region-b', sessionId: b })
  const tabA = createWorkbenchTab('tab-a', kind === 'browser'
    ? { ...browser, browserId: browser.id, kind: 'browser', workspaceId: 'workspace', regionId: 'region-a' }
    : { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'region-a', sessionId: a })
  useAppStore.setState({ config: composerConfig, loading: false, sessions: [composerSession(a), composerSession(b)],
    tabs: { [tabB.id]: tabB, [tabA.id]: tabA }, layouts: { workspace: createWorkspaceLayout('group', [tabB.id, tabA.id]) },
    mainSurface: 'workbench', activeWorkspaceId: 'workspace', workbenchSpaceSelection: null, retainedSpatialFocus: null,
    workbenchNavigationInputPolicy: null, agentNames: { [a]: 'Original A', [b]: 'Original B' }, sessionNameMetadata: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], viewModes: { [a]: 'activity', [b]: 'activity' }, timelines: {},
    agentComposerDrafts: { [a]: 'Original A draft', [b]: 'Original B draft' }, agentSteerQueues: {}, agentSteerInFlight: {},
    scratchTopicSnapshots: {}, noticeReadReceipts: {}, runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [],
    displacedAgentSessionIds: [], notificationEvents: [], error: null, errorNoticeContext: null,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null })
  append(b, 'Original B reading')
  if (kind === 'agent') append(a, 'Original A reading')
  return { tabA, tabB }
}
function preserveB() {
  const state = useAppStore.getState(), session = state.sessions.find(value => value.id === b)!
  const node = region('region-b'), editor = node.querySelector<HTMLElement>('.ProseMirror')!, feed = node.querySelector<HTMLElement>('.activity-feed')!
  feed.scrollTop = 73
  const range = document.createRange(); range.selectNodeContents(editor)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  return { node, editor, feed, selection: document.getSelection()!.toString(), tab: state.tabs['tab-b'],
    session, control: session.control, run: session.control.run, draft: state.agentComposerDrafts[b], layout: state.layouts }
}
function unchangedB(original: ReturnType<typeof preserveB>) {
  const state = useAppStore.getState(), session = state.sessions.find(value => value.id === b)!
  expect(state.tabs['tab-b']).toBe(original.tab); expect(session).toBe(original.session)
  expect(session.control).toBe(original.control); expect(session.control.run).toBe(original.run)
  expect(state.layouts).toBe(original.layout); expect(state.agentComposerDrafts[b]).toBe(original.draft)
  expect(region('region-b')).toBe(original.node); expect(original.node.querySelector('.ProseMirror')).toBe(original.editor)
  expect(original.node.querySelector('.activity-feed')).toBe(original.feed); expect(original.feed.scrollTop).toBe(73)
  expect(document.getSelection()!.toString()).toBe(original.selection)
  for (const port of noNative()) expect(port).not.toHaveBeenCalled()
}
function zeroB(phase: string) {
  const current = structuredClone(counts())
  if (process.env.AGENTMUX_RETAINED_TAB_SAMPLES) appendFileSync(process.env.AGENTMUX_RETAINED_TAB_SAMPLES, JSON.stringify({ phase, counts: current }) + '\n')
  expect.soft(current.hosts['tab-b'] ?? 0, 'Unchanged B content owner renders').toBe(0)
  expect.soft(current.paneRender[b] ?? 0, 'Unchanged B Pane renders').toBe(0)
  expect.soft(current.composerRender[b] ?? 0, 'Unchanged B Composer renders').toBe(0)
  expect.soft(current.paneCommit[b] ?? 0, 'Unchanged B Pane commits').toBe(0)
  expect.soft(current.composerCommit[b] ?? 0, 'Unchanged B Composer commits').toBe(0)
}
async function prepare(kind: 'browser' | 'agent') {
  const original = fixture(kind)
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible />); await settle()
  expect(dom.container.querySelectorAll('.retained-workbench-region')).toHaveLength(2)
  expect(region('region-b').querySelector('.ProseMirror')!.textContent).toBe('Original B draft')
  await waitForAgentCardReading(() => expect(region('region-b').querySelector('.activity-feed')!.textContent).toContain('Original B reading'))
  for (const field of ['paneRender', 'paneCommit', 'composerRender', 'composerCommit'] as const) expect(counts()[field][b]).toBeGreaterThan(0)
  await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible={false} />); await settle()
  const preserved = preserveB()
  reset()
  return { ...original, preserved }
}

it.each([0, 24])('switches actual App surfaces without rendering unchanged retained Tab consumers with %i additional Tabs', async extraCount => {
  fixture('agent')
  const extraIds = Array.from({ length: extraCount }, (_, index) => `unrelated-${index}`)
  const extraTabs = extraIds.map(id => createWorkbenchTab(id, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: `region-${id}`, sessionId: id }))
  useAppStore.setState(state => ({ initialize: vi.fn(async () => () => {}), projectRailOpen: false, toolsOpen: false,
    sessions: [...state.sessions, ...extraIds.map(id => composerSession(id))],
    tabs: { ...state.tabs, ...Object.fromEntries(extraTabs.map(tab => [tab.id, tab])) },
    layouts: { workspace: createWorkspaceLayout('group', ['tab-b', 'tab-a', ...extraIds]) },
    viewModes: { ...state.viewModes, ...Object.fromEntries(extraIds.map(id => [id, 'terminal' as const])) } }))
  await dom.render(<App />); await settle()
  await waitForAgentCardReading(() => expect(region('region-b').querySelector('.activity-feed')!.textContent).toContain('Original B reading'))
  await dom.click('button[data-workbench-tab-id="tab-a"]'); await settle()
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe('tab-a')
  const original = preserveB()
  reset()
  await dom.click('button[aria-label^="Focus: show execution contexts"]'); await settle()
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(dom.container.querySelector('.global-focus-surface')?.hasAttribute('hidden')).toBe(false)
  zeroB('app-space-to-focus'); unchangedB(original)
  for (const id of extraIds) {
    expect(counts().hosts[id] ?? 0, id).toBe(0)
    expect(counts().paneRender[id] ?? 0, id).toBe(0)
    expect(counts().paneCommit[id] ?? 0, id).toBe(0)
    expect(counts().composerRender[id] ?? 0, id).toBe(0)
    expect(counts().composerCommit[id] ?? 0, id).toBe(0)
  }
  reset()
  await dom.click('button[aria-label="Space: show terminal and file workbench"]'); await settle()
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  zeroB('app-focus-to-space'); unchangedB(original)
  for (const id of extraIds) {
    expect(counts().hosts[id] ?? 0, id).toBe(0)
    expect(counts().paneRender[id] ?? 0, id).toBe(0)
    expect(counts().paneCommit[id] ?? 0, id).toBe(0)
    expect(counts().composerRender[id] ?? 0, id).toBe(0)
    expect(counts().composerCommit[id] ?? 0, id).toBe(0)
  }
})

it('updates the original hidden Browser without rendering or committing an unchanged retained Agent Tab', async () => {
  const original = await prepare('browser'), before = useAppStore.getState().tabs['tab-a']
  const next = { ...browser, navigationId: 'next-navigation', url: 'https://example.test/next', title: 'Updated original page', loading: true }
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: next })); await settle()
  expect(useAppStore.getState().tabs['tab-a']).not.toBe(before)
  expect(useAppStore.getState().tabs['tab-a']!.regions['region-a']).toMatchObject({ browserId: browser.id,
    navigationId: next.navigationId, url: next.url, title: next.title, loading: true })
  expect(region('region-a').querySelector<HTMLInputElement>('input')!.value).toBe(next.url)
  expect(counts().browser[browser.id]).toBeGreaterThan(0)
  zeroB('browser-updated'); unchangedB(original.preserved)
})

it('admits exact Agent events without waking another hidden Tab and shows its own new message and status on reveal', async () => {
  const original = await prepare('agent')
  await act(async () => { append(a, 'Fresh A output'); await syncConversation(a) }); await settle()
  expect(counts().paneCommit[a]).toBeGreaterThan(0); expect(counts().composerCommit[a]).toBeGreaterThan(0)
  zeroB('agent-timeline'); unchangedB(original.preserved); reset()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: a, state: 'working',
    evidence: { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 110), run: { runId: `run-${a}` } }
  } })); await settle()
  expect(useAppStore.getState().sessions.find(session => session.id === a)!.status.state).toBe('working')
  expect(counts().paneCommit[a]).toBeGreaterThan(0); expect(counts().composerCommit[a]).toBeGreaterThan(0)
  zeroB('agent-status'); unchangedB(original.preserved)
  // Selection and visibility are positive controls outside the isolated cost window.
  await act(async () => useAppStore.setState(state => ({ mainSurface: 'workbench', layouts: { ...state.layouts,
    workspace: { ...state.layouts.workspace!, groups: state.layouts.workspace!.groups.map(group => ({ ...group, activeTabId: 'tab-a' })) } } })))
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible />); await settle()
  await waitForAgentCardReading(() => expect(region('region-a').textContent).toContain('Fresh A output'))
  expect(region('region-a').querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
  await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts,
    workspace: { ...state.layouts.workspace!, groups: state.layouts.workspace!.groups.map(group => ({ ...group, activeTabId: 'tab-b' })) } } })))
  reset()
  await act(async () => {
    append(b, 'Fresh B output')
    await syncConversation(b)
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: b,
      state: 'working', evidence: { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 111), run: { runId: `run-${b}` } } } })
  }); await settle()
  await waitForAgentCardReading(() => expect(region('region-b').textContent).toContain('Fresh B output'))
  expect(region('region-b').querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
  expect(counts().paneCommit[b]).toBeGreaterThan(0); expect(counts().composerCommit[b]).toBeGreaterThan(0)
  expect(region('region-b').querySelector('.ProseMirror')).toBe(original.preserved.editor)
  expect(useAppStore.getState().agentComposerDrafts[b]).toBe(original.preserved.draft)
  expect(useAppStore.getState().sessions.find(session => session.id === b)!.control.run).toBe(original.preserved.run)
})

it('keeps original names, Region layout, visibility, resize and explicit target presentation live across the memo boundary', async () => {
  const { tabB } = fixture('agent')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible />); await settle()
  const original = preserveB()
  const split = focusWorkbenchTabRegion(addWorkbenchRegion(tabB, 'region-b', 'right', { kind: 'agent', phase: 'attached',
    workspaceId: 'workspace', regionId: 'region-c', sessionId: a }), 'region-b')
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [split.id]: split } })))
  expect(dom.container.querySelectorAll('.retained-workbench-region')).toHaveLength(3)
  expect(counts().menus['region-c']![0]).toMatchObject({ targetRegionId: 'region-b', label: 'Swap with Original B' })
  const splitTab = useAppStore.getState().tabs['tab-b']
  await act(async () => useAppStore.setState({ agentNames: { [a]: 'Original A', [b]: 'Renamed original B' } }))
  expect(useAppStore.getState().tabs['tab-b']).toBe(splitTab)
  expect(counts().menus['region-c']![0]).toMatchObject({ targetRegionId: 'region-b', label: 'Swap with Renamed original B' })
  const primary = dom.container.querySelector<HTMLElement>('[data-workbench-primary-tab-id="tab-b"]')!
  expect(primary.dataset.workbenchPrimaryReference).toContain('region-b')
  const selected = focusWorkbenchTabRegion(split, 'region-c')
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [selected.id]: selected } })))
  expect(primary.dataset.workbenchPrimaryReference).toContain('region-c')
  expect(region('region-b').querySelector('.ProseMirror')).toBe(original.editor)

  await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts,
    workspace: moveTabToNewGroup(state.layouts.workspace!, 'tab-b', 'group', 'group', 'right', 'group-b') } })))
  expect(dom.container.querySelector('.pane-split')).not.toBeNull()
  expect(primary.dataset.workbenchPrimaryReference).toContain('group-b')
  expect(useAppStore.getState().tabs['tab-b']).toBe(selected)

  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible={false} interactiveResize />); await settle()
  expect(counts().paneProps[b]).toEqual({ visible: false, interactiveResize: true })
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible interactiveResize={false} />); await settle()
  expect(counts().paneProps[b]).toEqual({ visible: true, interactiveResize: false })

  const destination = document.createElement('div'); destination.id = 'retained-exact-target'; dom.container.append(destination)
  const reference = { displayWorkspaceId: 'workspace', groupId: 'group-b', tabId: 'tab-b', regionId: 'region-c' }
  const oldSelect = vi.fn(), currentSelect = vi.fn()
  const targets: WorkbenchViewTargets = { 'tab-b': [{ hostId: destination.id, active: true, visible: true, surface: 'space', reference, onSelectRegion: oldSelect }] }
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible viewTargets={targets} />); await settle()
  expect(destination.querySelector('[data-workbench-primary-tab-id="tab-b"]')).toBe(primary)
  expect(destination.querySelector('[data-workbench-region-id="region-b"] .ProseMirror')).toBe(original.editor)
  expect(primary.dataset.workbenchPrimaryReference).toContain('region-c')
  const updatedTargets: WorkbenchViewTargets = { 'tab-b': [{ ...targets['tab-b']![0]!, onSelectRegion: currentSelect }] }
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible viewTargets={updatedTargets} />); await settle()
  await act(async () => region('region-b').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(currentSelect).toHaveBeenCalledWith('region-b'); expect(oldSelect).not.toHaveBeenCalled()
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" visible />); await settle()
  expect(dom.container.querySelector('[data-workbench-primary-tab-id="tab-b"]')).toBe(primary)
  expect(destination.querySelector('[data-workbench-primary-tab-id]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[b]).toBe(original.draft)
  expect(useAppStore.getState().sessions.find(session => session.id === b)!.control.run).toBe(original.run)
  for (const port of noNative()) expect(port).not.toHaveBeenCalled()
})

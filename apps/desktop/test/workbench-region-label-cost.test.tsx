// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { addWorkbenchRegion, createWorkbenchTab, removeWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { sessionNameMetadataKey } from '../src/renderer/src/lib/session-name-metadata'
import type { RegionSwapMenuEntry } from '../src/renderer/src/lib/workbench-tab-actions'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Only PTY painting is unavailable in happy-dom. The original Workbench, menus,
// SessionPane, Activity, Composer, editor and Store remain actual consumers.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))

type Counts = { tree: number; pane: Record<string, number>; composer: Record<string, number>; menus: Record<string, readonly RegionSwapMenuEntry[]> }
const counts = () => (globalThis as typeof globalThis & { __regionLabelCounts: Counts }).__regionLabelCounts
const reset = () => { counts().tree = 0; counts().pane = {}; counts().composer = {} }
const dom = composerDOM()
const ids = ['label-a', 'label-b'] as const
let clock = 0
beforeEach(() => {
  expect(homedir()).toBe(process.env.AGENTMUX_REGION_LABEL_PRIVATE_HOME)
  for (const name of ['HOME', 'CODEX_HOME', 'AGENTMUX_RUNTIME_DIR', 'AGENTMUX_STATE_DIR']) expect(process.env[name]).toContain(process.env.AGENTMUX_REGION_LABEL_PRIVATE_ROOT)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  clock = Date.now()
})
afterEach(() => vi.unstubAllGlobals())
function fixture(names: Record<string, string> = {}) {
  let tab = createWorkbenchTab('label-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'region-a', sessionId: ids[0] })
  tab = addWorkbenchRegion(tab, 'region-a', 'right', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'region-b', sessionId: ids[1] })
  useAppStore.setState({ config: composerConfig, loading: false,
    sessions: ids.map((id, n) => ({ ...composerSession(id), label: `Original ${n ? 'B' : 'A'}` })),
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('label-group', [tab.id]) },
    mainSurface: 'workbench', activeWorkspaceId: 'workspace', workbenchSpaceSelection: null,
    retainedSpatialFocus: null, workbenchNavigationInputPolicy: null,
    agentNames: names, sessionNameMetadata: {}, pendingAgentLaunches: {}, recoveryCandidates: [],
    viewModes: { [ids[0]]: 'activity', [ids[1]]: 'activity' }, timelines: {},
    agentComposerDrafts: { [ids[0]]: 'Original A draft', [ids[1]]: 'Original B draft' },
    agentSteerQueues: {}, agentSteerInFlight: {}, scratchTopicSnapshots: {},
    noticeReadReceipts: {}, runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [],
    displacedAgentSessionIds: [], notificationEvents: [], error: null, errorNoticeContext: null,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null })
  return tab
}
async function append(kind: 'assistant_message' | 'user_message', content: string) {
  const revision = (useAppStore.getState().timelines[ids[0]]?.revision ?? 0) + 1
  const at = ++clock
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-timeline', agentSessionId: ids[0], revision,
    mutation: { type: 'append', agentSessionId: ids[0], item: { id: `record-${revision}`, agentSessionId: ids[0],
      kind, status: 'complete', source: kind === 'user_message' ? 'user' : 'native-hook',
      createdAt: at, updatedAt: at, title: 'Recorded fixture', content } },
    evidence: { source: 'native-hook', observedAt: at, run: { runId: `run-${ids[0]}` } }
  } }))
}
async function status() {
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: ids[0], state: 'working',
    evidence: { source: 'native-hook', observedAt: ++clock, run: { runId: `run-${ids[0]}` } }
  } }))
}
const region = (id: string) => dom.container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)!
const menu = (id: string) => counts().menus[id]!
async function mount() {
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  expect(dom.container.querySelectorAll('.retained-workbench-region')).toHaveLength(2)
  expect(counts().tree).toBeGreaterThan(0)
  expect(counts().pane[ids[1]]).toBeGreaterThan(0)
  expect(counts().composer[ids[1]]).toBeGreaterThan(0)
  expect(menu('region-a')).toHaveLength(1)
}

it('keeps unchanged same-Tab sibling consumers out of menu work while the actual A Activity and Composer update', async () => {
  fixture({ [ids[0]]: 'Original A', [ids[1]]: 'Original B' }); await mount()
  const b = region('region-b'), editor = b.querySelector<HTMLElement>('.ProseMirror')!, feed = b.querySelector<HTMLElement>('.activity-feed')!
  expect(editor.textContent).toBe('Original B draft')
  feed.scrollTop = 73
  const selected = document.createRange(); selected.selectNodeContents(editor)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(selected)
  const selection = document.getSelection()!.toString(), before = useAppStore.getState()
  reset(); await append('assistant_message', 'Fresh A output'); await status()
  expect.soft(counts().tree, 'unchanged displayed names must not rerender the menu owner').toBe(0)
  expect.soft(counts().pane[ids[1]] ?? 0, 'B Pane must not inherit A menu work').toBe(0)
  expect.soft(counts().composer[ids[1]] ?? 0, 'B Composer must not inherit A menu work').toBe(0)
  expect(counts().pane[ids[0]]).toBeGreaterThan(0); expect(counts().composer[ids[0]]).toBeGreaterThan(0)
  expect(region('region-a').textContent).toContain('Fresh A output')
  expect(region('region-a').querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
  expect(region('region-b')).toBe(b); expect(b.querySelector('.ProseMirror')).toBe(editor)
  expect(b.querySelector('.activity-feed')).toBe(feed); expect(feed.scrollTop).toBe(73)
  expect(document.getSelection()!.toString()).toBe(selection)
  expect(useAppStore.getState().agentComposerDrafts[ids[1]]).toBe('Original B draft')
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions.map(s => s.control.run.runId)).toEqual(before.sessions.map(s => s.control.run.runId))
})

it('updates original first-prompt and manual-name priorities, then ignores later messages with the same name', async () => {
  fixture(); await mount()
  expect(menu('region-b')[0]).toMatchObject({ targetRegionId: 'region-a', label: 'Swap with Original A' })
  await append('user_message', 'First real prompt')
  expect(menu('region-b')[0]!.label).toBe('Swap with First real prompt')
  reset(); await append('assistant_message', 'Later output')
  expect(counts().tree).toBe(0)
  await act(async () => useAppStore.setState({ agentNames: { [ids[0]]: 'Manual name' } }))
  expect(menu('region-b')[0]!.label).toBe('Swap with Manual name')
  await act(async () => useAppStore.setState({ agentNames: {} }))
  expect(menu('region-b')[0]!.label).toBe('Swap with First real prompt')
})

it('keeps exact Host metadata, missing and pending labels live in the actual Region menu', async () => {
  fixture(); await mount()
  const metadata = { agentSessionId: ids[1], hostId: 'local', providerId: 'codex', executorId: 'codex',
    workspacePath: composerConfig.workspaces[0]!.path, label: 'Retained B', state: 'active' as const }
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(s => s.id !== ids[1]),
    pendingAgentLaunches: { [ids[1]]: { request: { hostId: 'local', executorId: 'codex', workspacePath: metadata.workspacePath } } } as never,
    sessionNameMetadata: { [sessionNameMetadataKey('local', ids[1])]: metadata,
      [sessionNameMetadataKey('remote', ids[1])]: { ...metadata, hostId: 'remote', label: 'Foreign B' } } })))
  expect(menu('region-a')[0]!.label).toBe('Swap with Retained B')
  await act(async () => useAppStore.setState({ sessionNameMetadata: {} }))
  expect(menu('region-a')[0]!.label).toBe('Swap with Agent · name unconfirmed')
  await act(async () => useAppStore.setState({ pendingAgentLaunches: {}, sessionNameMetadata: {
    [sessionNameMetadataKey('remote', ids[1])]: { ...metadata, hostId: 'remote', label: 'Foreign B' }
  } }))
  expect(menu('region-a')[0]!.label).toBe('Swap with Agent · name unconfirmed')
})

it('preserves Region order, repeated-name numbering, type changes and original swap action IDs', async () => {
  const original = fixture({ [ids[0]]: 'Repeated', [ids[1]]: 'Repeated' }); await mount()
  expect(menu('region-a')[0]).toMatchObject({ targetRegionId: 'region-b', label: 'Swap with Repeated 2' })
  const swap = vi.fn(); await act(async () => useAppStore.setState({ swapRegions: swap }))
  await act(async () => menu('region-a')[0]!.onSelect())
  expect(swap).toHaveBeenCalledExactlyOnceWith('workspace', original.id, 'region-a', 'region-b')
  const root = original.layout.root
  expect(root.type).toBe('split'); if (root.type !== 'split') throw new Error('Expected original split fixture')
  const reordered = { ...original, layout: { ...original.layout, root: { ...root, first: root.second, second: root.first } } }
  await act(async () => useAppStore.setState({ tabs: { [original.id]: reordered } }))
  expect(menu('region-a')[0]!.label).toBe('Swap with Repeated 1')
  const terminal = { kind: 'terminal' as const, phase: 'attached' as const, regionId: 'region-b', workspaceId: 'workspace', sessionId: ids[1] }
  const typed = { ...reordered, regions: { ...reordered.regions, 'region-b': terminal } }
  await act(async () => useAppStore.setState({ tabs: { [original.id]: typed } }))
  expect(menu('region-a')[0]!.label).toBe('Swap with Terminal')
  const added = addWorkbenchRegion(typed, 'region-b', 'right', { ...terminal, regionId: 'region-c' })
  await act(async () => useAppStore.setState({ tabs: { [original.id]: added } }))
  expect(menu('region-a').map(entry => [entry.targetRegionId, entry.label])).toEqual([
    ['region-b', 'Swap with Terminal 1'], ['region-c', 'Swap with Terminal 2']
  ])
  await act(async () => useAppStore.setState({ tabs: { [original.id]: removeWorkbenchRegion(added, 'region-c')! } }))
  expect(menu('region-a').map(entry => [entry.targetRegionId, entry.label])).toEqual([['region-b', 'Swap with Terminal']])
})

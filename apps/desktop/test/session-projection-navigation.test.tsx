const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlRequest } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { SessionObservationRegions } from '../src/renderer/src/components/SessionObservationRegions'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { SessionResultReview } from '../src/renderer/src/components/SessionResultReview'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Navigation consumers and the real Store are under test. Terminal transport and Git rendering
// have separate native/owning proofs; they cannot change the projection's placement here.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, loading: false, error: null }) }))

const initial = useAppStore.getState()
const topicId = 'view:existing-topic'
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
  workspaces: [
    { id: 'repo', hostId: 'local', name: 'Execution', path: _hygiene_fixturePath("repo"), kind: 'folder' },
    { id: 'other', hostId: 'local', name: 'Other', path: _hygiene_fixturePath("other"), kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: _hygiene_fixturePath("scratch"), kind: 'folder' }
  ], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: id,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run:${id}` } }
  }
}
let root: Root
let container: HTMLDivElement
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  useAppStore.setState({ ...initial, config: null, sessions: [], tabs: {}, layouts: {},
    restoredWorkbench: null, spaceZoneBindings: {}, spatialRequests: {}, retainedSpatialFocus: null,
    activeWorkspaceId: 'repo', mainSurface: 'board', regionCaretFocus: null, error: null }, true)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: topicId, title: 'Existing Topic', summary: '',
    directoryPath: 'topic--existing', topicPath: 'topic--existing/topic.md', collaborators: [] }])
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(structuredClone(config))
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ sessions: [agent('a'), agent('b')], activeWorkspaceId: 'repo', mainSurface: 'board' })
  container = document.createElement('div')
  const overlay = document.createElement('div'); overlay.dataset.overlayHost = ''; container.append(overlay)
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  dispose?.(); dispose = undefined
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(one => one.textContent?.trim() === label)
  expect(button, `Real consumer button ${label} is present`).toBeTruthy()
  await act(async () => button!.click())
}
function placements() {
  return Object.entries(useAppStore.getState().layouts).flatMap(([workspaceId, layout]) =>
    layout.groups.flatMap(group => group.tabOrder.map(tabId => ({ workspaceId, tabId }))))
}
async function moveIntoTopic({ duplicate }: { duplicate: boolean }) {
  const source = createWorkbenchTab('source', { regionId: 'a-region', workspaceId: 'repo', kind: 'agent', phase: 'attached', sessionId: 'a' })
  let target = createWorkbenchTab('target', { regionId: 'vacancy', workspaceId: SCRATCH_WORKSPACE_ID, kind: 'launcher' })
  target = { ...addWorkbenchRegion(target, 'vacancy', 'right', { regionId: 'b-region', workspaceId: SCRATCH_WORKSPACE_ID,
    kind: 'agent', phase: 'attached', sessionId: 'b' }), topicId }
  const copy = createWorkbenchTab('duplicate', { regionId: 'duplicate-region', workspaceId: 'other', kind: 'agent', phase: 'attached', sessionId: 'a' })
  useAppStore.setState({ tabs: { source, target, ...(duplicate ? { duplicate: copy } : {}) }, layouts: {
    repo: createWorkspaceLayout('source-group', ['source']),
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('topic-group', ['target']),
    other: createWorkspaceLayout('other-group', duplicate ? ['duplicate'] : [])
  } })
  const receipt = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
    requestId: 'private:move-for-navigation', operation: 'space.mv', fromRegionId: 'a-region', expectedAgentSessionId: 'a',
    destination: { regionId: 'vacancy' }, focus: false }))
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ operation: 'space.mv', outcome: 'moved', to: { workspaceId: SCRATCH_WORKSPACE_ID, tabId: 'target', regionId: 'a-region' } })
  expect(Object.keys(useAppStore.getState().tabs.target!.regions).sort()).toEqual(['a-region', 'b-region'])
}

describe('existing Session projection navigation', () => {
  it.each(['Open Session', 'Continue in Session'])('mv → real %s navigates durable placement without reparenting a Topic Tab or extra projection', async label => {
    await moveIntoTopic({ duplicate: false })
    const before = useAppStore.getState()
    const tabs = structuredClone(before.tabs)
    const graph = placements()
    const sessions = before.sessions
    const start = vi.spyOn(api.sessions, 'launchAgent')
    const stop = vi.spyOn(api.sessions, 'stop')
    const recover = vi.spyOn(api.sessions, 'recover')
    if (label === 'Open Session') {
      await act(async () => root.render(<SessionObservationRegions sessionIds={['a']} contextId="private-board" />))
      expect(container.querySelector('.global-session-region__jump [data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('navigation.space')
    } else {
      await act(async () => {
        useAppStore.setState({ sessions: before.sessions.map(one => one.id === 'a' ? { ...one, status: { state: 'done', source: 'run-process', observedAt: 2 } } : one) })
        root.render(<SessionResultReview sessionId="a" items={[]} origin={{ workspaceId: 'repo', tabGroupId: 'source-group' }} visible surfaceAnchor="--fixture-result-surface" />)
      })
      await click('Review')
    }
    await click(label)
    const after = useAppStore.getState()
    expect(after.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(after.mainSurface).toBe('workbench')
    expect(after.tabs.target!.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(after.tabs.target!.topicId).toBe(topicId)
    expect(after.tabs.target!.regions).toEqual(tabs.target!.regions)
    expect(after.tabs.target!.layout.root).toEqual(tabs.target!.layout.root)
    expect(after.tabs.target!.layout.activeRegionId).toBe('a-region')
    expect(placements()).toEqual(graph)
    expect(graph).toEqual([{ workspaceId: SCRATCH_WORKSPACE_ID, tabId: 'target' }])
    expect(after.sessions.map(one => ({ id: one.id, control: one.control, cwd: one.workspacePath, hostId: one.hostId })))
      .toEqual(sessions.map(one => ({ id: one.id, control: one.control, cwd: one.workspacePath, hostId: one.hostId })))
    expect(after.retainedSpatialFocus).toBeNull()
    expect(after.regionCaretFocus).toBeNull()
    expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  })

  it('the actual awaiting-recovery Open Session consumer can enter the preserved projection before Session facts arrive', async () => {
    await moveIntoTopic({ duplicate: false })
    useAppStore.setState({ sessions: [], mainSurface: 'board' })
    const before = structuredClone(useAppStore.getState().tabs)
    const graph = placements()
    await act(async () => root.render(<SessionObservationRegions sessionIds={['a']} contextId="private-recovery" />))
    expect(container.textContent).toContain('Session awaiting recovery')
    await click('Open Session')
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(useAppStore.getState().tabs.target!.regions).toEqual(before.target!.regions)
    expect(useAppStore.getState().sessions).toEqual([])
    expect(placements()).toEqual(graph)
    expect(graph).toHaveLength(1)
  })

  async function openLocations() {
    await act(async () => root.render(<><SessionObservationRegions sessionIds={['a']} contextId="private-board" /><QuickSwitcher open={false} onClose={() => {}} /></>))
    await click('Open Session')
    expect(document.querySelector('[aria-label="Choose a Session location"]')).not.toBeNull()
  }
  const locationRows = () => [...document.querySelectorAll<HTMLButtonElement>('.quick-switch__row')]
  const field = () => document.querySelector<HTMLInputElement>('[aria-label="Search Session locations"]')!
  async function key(value: string, isComposing = false) {
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true })))
  }

  it('real Open Session scopes the shared picker and opens the exact chosen durable occurrence without new work', async () => {
    await moveIntoTopic({ duplicate: true })
    useAppStore.setState({ agentComposerDrafts: { a: 'Original unsent input' } })
    const before = useAppStore.getState(), tabs = structuredClone(before.tabs), graph = placements()
    const start = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop'), recover = vi.spyOn(api.sessions, 'recover')
    await openLocations()
    expect(locationRows()).toHaveLength(2)
    expect(locationRows().map(row => JSON.parse(row.title))).toEqual(expect.arrayContaining([
      { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'topic-group', tabId: 'target', regionId: 'a-region' },
      { displayWorkspaceId: 'other', groupId: 'other-group', tabId: 'duplicate', regionId: 'duplicate-region' }
    ]))
    expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(useAppStore.getState().tabs).toEqual(tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    const chosen = locationRows().find(row => JSON.parse(row.title).tabId === 'target')!
    // A later observation may hold another occurrence; the person's explicit row still owns this choice.
    await act(async () => { expect(useAppStore.getState().focusExecutionSession('a',
      { displayWorkspaceId: 'other', groupId: 'other-group', tabId: 'duplicate', regionId: 'duplicate-region' }, { navigate: false })).toBe(true) })
    await act(async () => chosen.click())
    const after = useAppStore.getState()
    expect(after.sessionLocationRequest).toBeNull()
    expect(after.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, groupId: 'topic-group', tabId: 'target', regionId: 'a-region' })
    expect(after.regionCaretFocus).toMatchObject({ regionId: 'a-region', nonce: expect.any(Number) })
    expect(after.tabs.duplicate).toEqual(tabs.duplicate)
    expect(after.agentComposerDrafts.a).toBe('Original unsent input')
    expect(after.sessions).toBe(before.sessions)
    expect(placements()).toEqual(graph)
    expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  })

  it('IME cannot select; keyboard selection uses the complete Group and Region even before snapshots return', async () => {
    await moveIntoTopic({ duplicate: true })
    const state = useAppStore.getState(), tab = state.tabs.duplicate!
    const twoRegions = addWorkbenchRegion(tab, 'duplicate-region', 'right', { regionId: 'second-a', workspaceId: 'other', kind: 'agent', phase: 'attached', sessionId: 'a' })
    const layout = state.layouts.other!
    useAppStore.setState({ sessions: [], tabs: { ...state.tabs, duplicate: twoRegions }, layouts: { ...state.layouts,
      other: { ...layout, root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: layout.root, second: { type: 'leaf', groupId: 'second-group' } },
        groups: [...layout.groups, { ...layout.groups[0]!, id: 'second-group' }] } } })
    await openLocations()
    expect(locationRows()).toHaveLength(5)
    const index = locationRows().findIndex(row => { const ref = JSON.parse(row.title); return ref.groupId === 'second-group' && ref.regionId === 'second-a' })
    expect(index).toBeGreaterThanOrEqual(0)
    await key('Enter', true)
    expect(useAppStore.getState().mainSurface).toBe('board')
    for (let at = 0; at < index; at++) await key('ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).toBe(locationRows()[index]!.id)
    await key('Enter')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: 'other', groupId: 'second-group', tabId: 'duplicate', regionId: 'second-a' })
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().tabs.duplicate!.regions).toEqual(twoRegions.regions)
  })

  it('cancel keeps the original workface and draft, while an explicitly held occurrence still opens directly', async () => {
    await moveIntoTopic({ duplicate: true })
    useAppStore.setState({ agentComposerDrafts: { a: 'Keep this draft' } })
    const before = useAppStore.getState()
    await openLocations()
    await key('Escape')
    expect(useAppStore.getState().sessionLocationRequest).toBeNull()
    expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    await act(async () => { expect(useAppStore.getState().focusExecutionSession('a',
      { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'topic-group', tabId: 'target', regionId: 'a-region' }, { navigate: false })).toBe(true) })
    await click('Open Session')
    expect(useAppStore.getState().sessionLocationRequest).toBeNull()
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  })

  it.each(['replaced', 'removed'] as const)('rechecks a %s target, retains the request and never falls through to creating a projection', async change => {
    await moveIntoTopic({ duplicate: true })
    await openLocations()
    const stale = locationRows().find(row => JSON.parse(row.title).tabId === 'duplicate')!
    const state = useAppStore.getState(), requestId = state.sessionLocationRequest!.requestId
    const reference = JSON.parse(stale.title)
    await act(async () => useAppStore.setState({ tabs: change === 'removed' ? {} : { ...state.tabs,
      duplicate: { ...state.tabs.duplicate!, regions: { 'duplicate-region': { ...state.tabs.duplicate!.regions['duplicate-region']!, sessionId: 'b' } as never } } } }))
    const before = useAppStore.getState(), start = vi.spyOn(api.sessions, 'launchAgent')
    await act(async () => expect(useAppStore.getState().chooseSessionLocation(requestId, reference)).toBe(false))
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/no longer contains the original Session/)
    expect(useAppStore.getState().sessionLocationRequest?.requestId).toBe(requestId)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(start).not.toHaveBeenCalled()
  })

  it('a removed highlighted row cannot silently retarget Enter, and stale request callbacks cannot cancel or choose a newer request', async () => {
    await moveIntoTopic({ duplicate: true })
    await openLocations()
    const first = JSON.parse(locationRows()[0]!.title), oldId = useAppStore.getState().sessionLocationRequest!.requestId
    const state = useAppStore.getState(), layout = state.layouts[first.displayWorkspaceId]!
    await act(async () => useAppStore.setState({ layouts: { ...state.layouts, [first.displayWorkspaceId]: { ...layout,
      groups: layout.groups.map(group => group.id === first.groupId ? { ...group, tabOrder: group.tabOrder.filter(id => id !== first.tabId), activeTabId: null } : group) } } }))
    expect(locationRows()).toHaveLength(1)
    expect(field().hasAttribute('aria-activedescendant')).toBe(false)
    await key('Enter')
    expect(useAppStore.getState().mainSurface).toBe('board')
    // A fresh request owns its own callbacks, independent of the previous modal render.
    await act(async () => { useAppStore.setState({ tabs: state.tabs, layouts: state.layouts }); expect(useAppStore.getState().selectSession('a')).toBe(false) })
    const newId = useAppStore.getState().sessionLocationRequest!.requestId
    expect(newId).not.toBe(oldId)
    await act(async () => {
      useAppStore.getState().dismissSessionLocationRequest(oldId)
      expect(useAppStore.getState().chooseSessionLocation(oldId, first)).toBe(false)
    })
    expect(useAppStore.getState().sessionLocationRequest?.requestId).toBe(newId)
    expect(useAppStore.getState().mainSurface).toBe('board')
  })

  it('missing durable Tab Group reports failure and preserves the projection instead of falling back to execution cwd', async () => {
    await moveIntoTopic({ duplicate: false })
    useAppStore.setState({ layouts: { repo: createWorkspaceLayout('source-group'), other: useAppStore.getState().layouts.other! } })
    const tabs = structuredClone(useAppStore.getState().tabs)
    const graph = placements()
    expect(useAppStore.getState().selectSession('a')).toBe(false)
    expect(useAppStore.getState().tabs).toEqual(tabs)
    expect(placements()).toEqual(graph)
    expect(graph).toEqual([])
    expect(useAppStore.getState().notificationEvents.at(-1)?.message).toMatch(/no unique confirmed display occurrence/)
    expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
  })
})

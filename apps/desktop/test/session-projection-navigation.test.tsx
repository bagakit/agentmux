// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlRequest } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { SessionObservationRegions } from '../src/renderer/src/components/SessionObservationRegions'
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
    { id: 'repo', hostId: 'local', name: 'Execution', path: '/repo', kind: 'folder' },
    { id: 'other', hostId: 'local', name: 'Other', path: '/other', kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/scratch', kind: 'folder' }
  ], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: '/repo', label: id,
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
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ sessions: [agent('a'), agent('b')], activeWorkspaceId: 'repo', mainSurface: 'board' })
  container = document.createElement('div')
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
async function moveIntoTopic() {
  const source = createWorkbenchTab('source', { regionId: 'a-region', workspaceId: 'repo', kind: 'agent', phase: 'attached', sessionId: 'a' })
  let target = createWorkbenchTab('target', { regionId: 'vacancy', workspaceId: SCRATCH_WORKSPACE_ID, kind: 'launcher' })
  target = { ...addWorkbenchRegion(target, 'vacancy', 'right', { regionId: 'b-region', workspaceId: SCRATCH_WORKSPACE_ID,
    kind: 'agent', phase: 'attached', sessionId: 'b' }), topicId }
  const duplicate = createWorkbenchTab('duplicate', { regionId: 'duplicate-region', workspaceId: 'other', kind: 'agent', phase: 'attached', sessionId: 'a' })
  // target precedes duplicate after source removal: keep the established first-projection selection
  // policy, while proving navigation cannot rewrite the unselected projection either.
  useAppStore.setState({ tabs: { source, target, duplicate }, layouts: {
    repo: createWorkspaceLayout('source-group', ['source']),
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('topic-group', ['target']),
    other: createWorkspaceLayout('other-group', ['duplicate'])
  } })
  const receipt = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
    requestId: 'private:move-for-navigation', operation: 'space.mv', fromRegionId: 'a-region', expectedAgentSessionId: 'a',
    destination: { regionId: 'vacancy' }, focus: false }))
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ operation: 'space.mv', outcome: 'moved', to: { workspaceId: SCRATCH_WORKSPACE_ID, tabId: 'target', regionId: 'a-region' } })
  expect(Object.keys(useAppStore.getState().tabs.target!.regions).sort()).toEqual(['a-region', 'b-region'])
}

describe('existing Session projection navigation', () => {
  it.each(['Open Session', 'Continue in Session'])('mv → real %s navigates durable placement without reparenting a Topic Tab or extra projection', async label => {
    await moveIntoTopic()
    const before = useAppStore.getState()
    const tabs = structuredClone(before.tabs)
    const graph = placements()
    const sessions = before.sessions
    const start = vi.spyOn(api.sessions, 'launchAgent')
    const stop = vi.spyOn(api.sessions, 'stop')
    const recover = vi.spyOn(api.sessions, 'recover')
    if (label === 'Open Session') {
      await act(async () => root.render(<SessionObservationRegions sessionIds={['a']} contextId="private-board" />))
    } else {
      await act(async () => {
        useAppStore.setState({ sessions: before.sessions.map(one => one.id === 'a' ? { ...one, status: { state: 'done', source: 'run-process', observedAt: 2 } } : one) })
        root.render(<SessionResultReview sessionId="a" items={[]} origin={{ workspaceId: 'repo', tabGroupId: 'source-group' }} visible />)
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
    expect(after.tabs.duplicate).toEqual(tabs.duplicate)
    expect(placements()).toEqual(graph)
    expect(graph).toEqual([{ workspaceId: SCRATCH_WORKSPACE_ID, tabId: 'target' }, { workspaceId: 'other', tabId: 'duplicate' }])
    expect(after.sessions.map(one => ({ id: one.id, control: one.control, cwd: one.workspacePath, hostId: one.hostId })))
      .toEqual(sessions.map(one => ({ id: one.id, control: one.control, cwd: one.workspacePath, hostId: one.hostId })))
    expect(after.retainedSpatialFocus).toBeNull()
    expect(after.regionCaretFocus).toBeNull()
    expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  })

  it('the actual awaiting-recovery Open Session consumer can enter the preserved projection before Session facts arrive', async () => {
    await moveIntoTopic()
    useAppStore.setState({ sessions: [], mainSurface: 'board' })
    const before = structuredClone(useAppStore.getState().tabs)
    const graph = placements()
    await act(async () => root.render(<SessionObservationRegions sessionIds={['a']} contextId="private-recovery" />))
    expect(container.textContent).toContain('Session awaiting recovery')
    await click('Open Session')
    expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(useAppStore.getState().tabs.target!.regions).toEqual(before.target!.regions)
    expect(useAppStore.getState().tabs.duplicate).toEqual(before.duplicate)
    expect(useAppStore.getState().sessions).toEqual([])
    expect(placements()).toEqual(graph)
    expect(graph).toHaveLength(2)
  })

  it('missing durable Tab Group reports failure and preserves the projection instead of falling back to execution cwd', async () => {
    await moveIntoTopic()
    useAppStore.setState({ layouts: { repo: createWorkspaceLayout('source-group'), other: useAppStore.getState().layouts.other! } })
    const tabs = structuredClone(useAppStore.getState().tabs)
    const graph = placements()
    useAppStore.getState().selectSession('a')
    expect(useAppStore.getState().tabs).toEqual(tabs)
    expect(placements()).toEqual(graph)
    expect(graph).toEqual([{ workspaceId: 'other', tabId: 'duplicate' }])
    expect(useAppStore.getState().error).toMatch(/Tab Group/)
    expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
  })
})

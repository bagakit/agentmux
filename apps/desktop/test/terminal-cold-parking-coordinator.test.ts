import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: () => undefined
}))
import {
  collectTerminalColdParkCandidates,
  useTerminalColdParking
} from '../src/renderer/src/lib/terminal-cold-parking-coordinator.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

function terminalTab(id: string, phase: 'launching' | 'attached' = 'attached') {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'terminal',
    phase,
    workspaceId: 'workspace-1',
    sessionId: `session:${id}`
  })
}

function session(id: string, processState: 'running' | 'exited' = 'running') {
  return {
    id: `session:${id}`,
    kind: 'terminal' as const,
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState,
    status: {
      state: processState === 'running' ? 'running' as const : 'exited' as const,
      source: 'run-process' as const,
      observedAt: 1
    },
    latestOutputBytes: 0,
    control: {
      kind: 'terminal' as const,
      hostId: 'local',
      runId: `session:${id}`,
      run: { runId: `run:${id}` }
    }
  }
}

describe('window terminal parking coordinator', () => {
  it('treats a partially hydrated store as an empty workbench during static render', () => {
    function Probe() {
      const parkedRegionIds = useTerminalColdParking({ workbenchVisible: false })
      return createElement('output', { 'data-parked-count': parkedRegionIds.size })
    }

    expect(() => renderToStaticMarkup(createElement(Probe))).not.toThrow()
  })

  it('marks only the active tab Region visible and keeps Region identity stable', () => {
    const first = terminalTab('first')
    const second = terminalTab('second')
    const tabs = { [first.id]: first, [second.id]: second }
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs,
      layouts: { 'workspace-1': layout },
      sessions: [session('first'), session('second')],
      activeWorkspaceId: 'workspace-1',
      workbenchVisible: true
    })

    expect(candidates).toEqual([
      expect.objectContaining({ id: 'region:first', visible: true, navigationContextActive: true, canRebuild: true }),
      expect.objectContaining({ id: 'region:second', visible: false, navigationContextActive: true, canRebuild: true })
    ])
  })

  it('blocks parking for launching or exited Sessions', () => {
    const launching = terminalTab('launching', 'launching')
    const exited = terminalTab('exited')
    const layout = createWorkspaceLayout('group', [launching.id, exited.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [launching.id]: launching, [exited.id]: exited },
      layouts: { 'workspace-1': layout },
      sessions: [session('launching'), session('exited', 'exited')],
      activeWorkspaceId: 'other-workspace',
      workbenchVisible: true
    })

    expect(candidates).toEqual([
      expect.objectContaining({ id: 'region:launching', phase: 'launching', navigationContextActive: false, canRebuild: true }),
      expect.objectContaining({ id: 'region:exited', phase: 'attached', navigationContextActive: false, canRebuild: false })
    ])
  })

  it('keeps a hidden Region warm when only the Workspace context changed', () => {
    const tab = terminalTab('remote-project')
    const layout = createWorkspaceLayout('group', [tab.id])
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-1': layout },
      sessions: [session('remote-project')],
      activeWorkspaceId: 'another-workspace',
      workbenchVisible: true
    })

    expect(candidates[0]).toMatchObject({
      id: 'region:remote-project',
      visible: false,
      navigationContextActive: false
    })
  })

  it('keeps a hidden Region warm when only the Scratch Topic changed', () => {
    const workspaceId = '__scratch__'
    const topicA = 'view:topic-a'
    const topicB = 'view:topic-b'
    const first = {
      ...terminalTab('topic-a'),
      workspaceId,
      topicId: topicA
    }
    const second = {
      ...terminalTab('topic-b'),
      workspaceId,
      topicId: topicB
    }
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const activeTopicLayout = {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: second.id }))
    }
    const candidates = collectTerminalColdParkCandidates({
      tabs: { [first.id]: first, [second.id]: second },
      layouts: { [workspaceId]: activeTopicLayout },
      sessions: [session('topic-a'), session('topic-b')],
      activeWorkspaceId: workspaceId,
      workbenchVisible: true
    })

    expect(candidates.find((candidate) => candidate.id === 'region:topic-a')).toMatchObject({
      visible: false,
      navigationContextActive: false
    })
    expect(candidates.find((candidate) => candidate.id === 'region:topic-b')).toMatchObject({
      visible: true,
      navigationContextActive: true
    })
  })
})

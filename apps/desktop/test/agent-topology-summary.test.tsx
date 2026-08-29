import { describe, expect, it } from 'vitest'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectAgentTopology } from '../src/renderer/src/components/AgentTopologySummary'
import type { SessionSnapshot } from '../src/shared/contracts'

function session(id: string, label: string): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    hostId: 'local',
    workspacePath: '/repo',
    label,
    providerId: 'codex',
    executorId: 'codex',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'working' },
    latestOutputBytes: 1,
    capabilities: {}
  } as SessionSnapshot
}

describe('AgentTopologySummary projection', () => {
  it('projects every linked Tab and every Region with the running Agent identity', () => {
    const first = createWorkbenchTab('tab-a', { regionId: 'region-a', kind: 'agent', phase: 'attached', workspaceId: 'project-a', sessionId: 'session-a' })
    const second: WorkbenchTab = {
      ...createWorkbenchTab('tab-b', { regionId: 'region-b', kind: 'agent', phase: 'attached', workspaceId: 'project-a', sessionId: 'session-a' }),
      topicId: 'view:shared'
    }
    second.regions['region-b2'] = { regionId: 'region-b2', kind: 'terminal', phase: 'attached', workspaceId: 'project-a', sessionId: 'session-b' }

    const projections = projectAgentTopology({
      sessionIds: ['session-a'],
      sessions: [session('session-a', 'Planner'), session('session-b', 'Builder')],
      tabs: { [first.id]: { ...first, topicId: 'view:shared' }, [second.id]: second },
      config: { workspaces: [{ id: 'project-a', name: 'Project A', branch: 'feature/demand', path: '/repo', hostId: 'local', kind: 'worktree' }] } as never
    })

    // 先钉住「恰好一条」，再看它的内容。上一版直接解构第一项，于是投影成了两条（同一件事被拆成
    // 两个 topology）时，这里仍只读第一条，断言照样全绿。
    expect(projections).toHaveLength(1)
    const projection = projections[0]!

    expect(projection.topicId).toBe('view:shared')
    expect(projection.branch).toBe('feature/demand')
    expect(projection.tabs).toHaveLength(2)
    expect(projection.tabs.flatMap((tab) => tab.regions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ regionId: 'region-a', agentLabel: 'Planner', providerId: 'codex', status: 'working' }),
      expect.objectContaining({ regionId: 'region-b2', agentLabel: 'Builder' })
    ]))
  })

  it('does not invent a topology for a Demand with no linked Session', () => {
    expect(projectAgentTopology({ sessionIds: [], sessions: [], tabs: {}, config: null })).toEqual([])
  })
})

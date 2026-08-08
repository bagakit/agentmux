import { describe, expect, it } from 'vitest'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { activityContextsForWorkspaces, buildActivityGroups } from '../src/renderer/src/lib/activity-groups'

function agent(id: string, workspacePath: string, overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: id.startsWith('claude') ? 'claude' : 'codex',
    executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local',
    workspacePath,
    label: id,
    createdAt: 1,
    updatedAt: 10,
    processState: 'running',
    status: { state: 'working', source: 'run-process', observedAt: 10 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as SessionSnapshot
}

function workspace(id: string, path: string, branch?: string, hostId = 'local'): WorkspaceRecord {
  return { id, name: id, path, hostId, kind: branch ? 'worktree' : 'folder', ...(branch ? { branch } : {}) } as WorkspaceRecord
}

describe('Activity work-line grouping', () => {
  it('groups multiple Agents by explicit branch/worktree context', () => {
    const contexts = activityContextsForWorkspaces([
      workspace('w-main', 'repo', 'main'),
      workspace('w-feature', 'repo-feature', 'feat/ui')
    ])
    const groups = buildActivityGroups([
      agent('codex-1', 'repo'),
      agent('claude-1', 'repo'),
      agent('codex-2', 'repo-feature')
    ], contexts)

    expect(groups.map((group) => [group.label, group.sessions.map((session) => session.id)])).toEqual([
      ['feat/ui', ['codex-2']],
      ['main', ['claude-1', 'codex-1']]
    ])
  })

  it('keeps same path on different hosts and unbound sessions separate', () => {
    const contexts = activityContextsForWorkspaces([
      workspace('local', 'repo', 'main', 'local'),
      workspace('remote', 'repo', 'main', 'studio')
    ])
    const groups = buildActivityGroups([
      agent('local-agent', 'repo'),
      agent('remote-agent', 'repo', { hostId: 'studio' }),
      agent('orphan', 'elsewhere')
    ], contexts)

    expect(groups.map((group) => ({ label: group.label, host: group.hostId, ids: group.sessions.map((session) => session.id) }))).toEqual([
      { label: 'main', host: 'local', ids: ['local-agent'] },
      { label: 'main', host: 'studio', ids: ['remote-agent'] },
      { label: 'Unassigned', host: 'local', ids: ['orphan'] }
    ])
  })

  it('does not merge unbound Sessions from different Hosts into one misleading row', () => {
    const groups = buildActivityGroups([
      agent('local-orphan', 'elsewhere'),
      agent('remote-orphan', 'elsewhere', { hostId: 'studio' })
    ])

    expect(groups.map((group) => ({ label: group.label, host: group.hostId, ids: group.sessions.map((session) => session.id) }))).toEqual([
      { label: 'Unassigned', host: 'local', ids: ['local-orphan'] },
      { label: 'Unassigned', host: 'studio', ids: ['remote-orphan'] }
    ])
  })
})

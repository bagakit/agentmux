import { describe, expect, it } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import type { AgentDisplayState } from '@agentmux/core'
import { buildAgentTree } from '../src/renderer/src/lib/agent-tree.js'

// ---------------------------------------------------------------------------
// The project→Agent tree behind each status-bar count. Pins the grouping key, the ordering, the
// no-project bucket, and the empty case — the four things the composition has to get right, and the two
// mutations the task names (collapse the key; open when empty) each go red here.
// ---------------------------------------------------------------------------

function agent(
  id: string,
  state: AgentDisplayState,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo/one',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as unknown as SessionSnapshot
}

function workspace(id: string, name: string, path: string, hostId = 'local'): WorkspaceRecord {
  return { id, name, hostId, path, kind: 'folder' }
}

const NO_CATALOG: readonly AgentCatalogEntry[] = []

describe('buildAgentTree', () => {
  it('groups agents by the workspace that owns their path, named by the workspace', () => {
    const sessions = [
      agent('a', 'working', { workspacePath: '/repo/one' }),
      agent('b', 'working', { workspacePath: '/repo/two' }),
      agent('c', 'working', { workspacePath: '/repo/one' })
    ]
    const workspaces = [workspace('w1', 'One', '/repo/one'), workspace('w2', 'Two', '/repo/two')]
    const tree = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'working' })

    expect(tree.map((project) => project.name)).toEqual(['One', 'Two'])
    expect(tree.find((project) => project.name === 'One')?.rows.map((row) => row.sessionId)).toEqual(['a', 'c'])
    expect(tree.find((project) => project.name === 'Two')?.rows.map((row) => row.sessionId)).toEqual(['b'])
  })

  it('files a session no workspace owns under one Unassigned bucket, never a guessed name', () => {
    const sessions = [agent('lost', 'working', { workspacePath: '/nowhere' })]
    const tree = buildAgentTree({
      sessions,
      providerCatalog: NO_CATALOG,
      workspaces: [workspace('w1', 'One', '/repo/one')],
      filter: 'working'
    })
    expect(tree).toHaveLength(1)
    expect(tree[0]!.name).toBe('Unassigned')
    expect(tree[0]!.rows.map((row) => row.sessionId)).toEqual(['lost'])
  })

  it('keeps two Unassigned sessions on different hosts in separate buckets', () => {
    const sessions = [
      agent('x', 'working', { workspacePath: '/nowhere', hostId: 'local' }),
      agent('y', 'working', { workspacePath: '/nowhere', hostId: 'remote' })
    ]
    const tree = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces: [], filter: 'working' })
    expect(tree).toHaveLength(2)
    expect(new Set(tree.map((project) => project.key)).size).toBe(2)
  })

  it('orders projects by their most urgent row: needs-you above merely-working', () => {
    const sessions = [
      agent('busy', 'working', { workspacePath: '/repo/one' }),
      agent('waits', 'waiting', { workspacePath: '/repo/two' })
    ]
    const workspaces = [workspace('w1', 'One', '/repo/one'), workspace('w2', 'Two', '/repo/two')]
    const tree = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'all' })
    expect(tree.map((project) => project.name)).toEqual(['Two', 'One'])
  })

  it('working filter is the Board working column, not state === working (starting/running count)', () => {
    // If it re-decided "in flight" as `state === 'working'` it would drop starting/running — the #582
    // class — and disagree with the count above it. Delegating to sessionBoardColumn keeps all three.
    const sessions = [
      agent('s', 'starting', { workspacePath: '/repo/one' }),
      agent('r', 'running', { workspacePath: '/repo/one' }),
      agent('w', 'working', { workspacePath: '/repo/one' }),
      agent('idle', 'done', { workspacePath: '/repo/one' })
    ]
    const workspaces = [workspace('w1', 'One', '/repo/one')]
    const tree = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'working' })
    expect(tree).toHaveLength(1)
    expect(tree[0]!.rows.map((row) => row.sessionId).sort()).toEqual(['r', 's', 'w'])
  })

  it('needs-you and error filters narrow to their own attention class only', () => {
    const sessions = [
      agent('w', 'waiting', { workspacePath: '/repo/one' }),
      agent('b', 'blocked', { workspacePath: '/repo/one' }),
      agent('e', 'error', { workspacePath: '/repo/one' }),
      agent('go', 'working', { workspacePath: '/repo/one' })
    ]
    const workspaces = [workspace('w1', 'One', '/repo/one')]
    const needsYou = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'needs-you' })
    expect(needsYou.flatMap((project) => project.rows.map((row) => row.sessionId)).sort()).toEqual(['b', 'w'])
    const error = buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'error' })
    expect(error.flatMap((project) => project.rows.map((row) => row.sessionId))).toEqual(['e'])
  })

  it('is empty when the class holds no agent — the zero-count case renders nothing', () => {
    const sessions = [agent('done', 'done', { workspacePath: '/repo/one' })]
    const workspaces = [workspace('w1', 'One', '/repo/one')]
    expect(buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'working' })).toEqual([])
    expect(buildAgentTree({ sessions, providerCatalog: NO_CATALOG, workspaces, filter: 'needs-you' })).toEqual([])
  })

  it('ignores terminal sessions — they are not agents', () => {
    const terminal = {
      id: 't',
      kind: 'terminal',
      providerId: null,
      hostId: 'local',
      workspacePath: '/repo/one',
      label: 't',
      createdAt: 1,
      updatedAt: 1,
      processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal', hostId: 'local', runId: 't', run: { runId: 'run-t' } }
    } as unknown as SessionSnapshot
    const workspaces = [workspace('w1', 'One', '/repo/one')]
    expect(buildAgentTree({ sessions: [terminal], providerCatalog: NO_CATALOG, workspaces, filter: 'all' })).toEqual([])
  })
})

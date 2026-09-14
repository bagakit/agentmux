import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { deriveFocusProjectLanes, isActiveFocusAgent } from '../src/renderer/src/lib/focus-project-lanes.js'

const workspaces: WorkspaceRecord[] = [
  { id: 'alpha', name: 'Alpha', hostId: 'local', path: '/alpha', kind: 'folder' },
  { id: 'beta', name: 'Beta', hostId: 'local', path: '/beta', kind: 'folder' }
]
const config = { workspaces } as AppConfig

function session(id: string, workspacePath: string, processState: 'running' | 'exited', kind: 'agent' | 'terminal' = 'agent'): SessionSnapshot {
  return {
    id, kind, providerId: kind === 'agent' ? 'codex' : null, executorId: kind === 'agent' ? 'codex' : null,
    hostId: 'local', workspacePath, label: id, createdAt: 1, updatedAt: 1, processState,
    latestOutputBytes: 0, status: { state: processState === 'running' ? 'working' : 'done', source: 'run-process', observedAt: 1 },
    control: kind === 'agent'
      ? { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id, generation: 1 } }
      : { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  } as SessionSnapshot
}

describe('Focus project lanes', () => {
  it('shows only configured projects with running Agent sessions', () => {
    const sessions = [
      session('alpha-live', '/alpha', 'running'),
      session('alpha-exited', '/alpha', 'exited'),
      session('beta-terminal', '/beta', 'running', 'terminal'),
      session('unknown-live', '/elsewhere', 'running')
    ]
    expect(deriveFocusProjectLanes(config, sessions)).toEqual([
      { workspaceId: 'alpha', name: 'Alpha', path: '/alpha', activeAgentIds: ['alpha-live'] }
    ])
  })

  it('treats a waiting Agent as active while excluding terminals and exited runs', () => {
    expect(isActiveFocusAgent(session('waiting', '/alpha', 'running'))).toBe(true)
    expect(isActiveFocusAgent(session('terminal', '/alpha', 'running', 'terminal'))).toBe(false)
    expect(isActiveFocusAgent(session('done', '/alpha', 'exited'))).toBe(false)
  })
})

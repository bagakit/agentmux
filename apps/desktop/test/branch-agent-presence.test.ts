import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import {
  runningAgentPresenceByWorktree,
  worktreePresenceKey
} from '../src/renderer/src/lib/branch-agent-presence'

function session(input: {
  id: string
  agentId: string | null
  hostId?: string
  workspacePath?: string
  processState?: SessionSnapshot['processState']
  updatedAt?: number
}): SessionSnapshot {
  const common = {
    id: input.id,
    hostId: input.hostId ?? 'local',
    workspacePath: input.workspacePath ?? '/repo',
    label: input.id,
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
    processState: input.processState ?? 'running',
    status: { state: 'running', source: 'kernel', observedAt: 1 },
    latestOutputBytes: 0
  } as const
  return input.agentId
    ? {
        ...common,
        kind: 'agent',
        agentId: input.agentId,
        control: {} as Extract<SessionSnapshot, { kind: 'agent' }>['control']
      }
    : {
        ...common,
        kind: 'terminal',
        agentId: null,
        control: {} as Extract<SessionSnapshot, { kind: 'terminal' }>['control']
      }
}

describe('runningAgentPresenceByWorktree', () => {
  it('groups live Agent sessions by host, worktree and provider', () => {
    const presence = runningAgentPresenceByWorktree([
      session({ id: 'codex-old', agentId: 'codex', updatedAt: 10 }),
      session({ id: 'codex-new', agentId: 'codex', updatedAt: 30 }),
      session({ id: 'claude', agentId: 'claude', updatedAt: 20 }),
      session({ id: 'other-host', agentId: 'pi', hostId: 'studio', updatedAt: 40 })
    ])

    expect(presence.get(worktreePresenceKey('local', '/repo'))).toEqual([
      { agentId: 'codex', count: 2, updatedAt: 30 },
      { agentId: 'claude', count: 1, updatedAt: 20 }
    ])
    expect(presence.get(worktreePresenceKey('studio', '/repo'))).toEqual([
      { agentId: 'pi', count: 1, updatedAt: 40 }
    ])
  })

  it('excludes terminals and non-running Agent Runs', () => {
    const presence = runningAgentPresenceByWorktree([
      session({ id: 'terminal', agentId: null }),
      session({ id: 'exited', agentId: 'codex', processState: 'exited' }),
      session({ id: 'interrupted', agentId: 'claude', processState: 'interrupted' })
    ])

    expect(presence.size).toBe(0)
  })
})

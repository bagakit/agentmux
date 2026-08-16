import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import {
  runningAgentPresenceByWorktree,
  worktreePresenceKey
} from '../src/renderer/src/lib/branch-agent-presence'

function session(input: {
  id: string
  providerId: string | null
  executorId?: string
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
  return input.providerId
    ? {
        ...common,
        kind: 'agent',
        providerId: input.providerId,
        executorId: input.executorId ?? input.providerId,
        control: {} as Extract<SessionSnapshot, { kind: 'agent' }>['control']
      }
    : {
        ...common,
        kind: 'terminal',
        providerId: null,
        control: {} as Extract<SessionSnapshot, { kind: 'terminal' }>['control']
      }
}

describe('runningAgentPresenceByWorktree', () => {
  it('groups live Agent sessions by host, worktree and provider', () => {
    const presence = runningAgentPresenceByWorktree([
      session({ id: 'codex-old', providerId: 'codex', updatedAt: 10 }),
      session({ id: 'codex-new', providerId: 'codex', updatedAt: 30 }),
      session({ id: 'claude', providerId: 'claude', updatedAt: 20 }),
      session({ id: 'other-host', providerId: 'pi', hostId: 'studio', updatedAt: 40 })
    ])

    expect(presence.get(worktreePresenceKey('local', '/repo'))).toEqual([
      { providerId: 'codex', executorId: 'codex', state: 'running', count: 2, updatedAt: 30 },
      { providerId: 'claude', executorId: 'claude', state: 'running', count: 1, updatedAt: 20 }
    ])
    expect(presence.get(worktreePresenceKey('studio', '/repo'))).toEqual([
      { providerId: 'pi', executorId: 'pi', state: 'running', count: 1, updatedAt: 40 }
    ])
  })

  it('excludes terminals and non-running Agent Runs', () => {
    const presence = runningAgentPresenceByWorktree([
      session({ id: 'terminal', providerId: null }),
      session({ id: 'exited', providerId: 'codex', processState: 'exited' }),
      session({ id: 'interrupted', providerId: 'claude', processState: 'interrupted' })
    ])

    expect(presence.size).toBe(0)
  })
})

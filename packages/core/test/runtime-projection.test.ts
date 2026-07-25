import { describe, expect, it } from 'vitest'
import { projectAgentMuxRuntimeSubjects } from '../src/runtime.js'
import type { AgentMuxAgentSession, AgentMuxRun } from '../src/types.js'

const run: AgentMuxRun = {
  runId: 'run-1',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  agentSessionId: 'semantic-1',
  workspacePath: '/repo',
  pid: 42,
  state: 'running',
  cols: 80,
  rows: 24,
  observedAt: 100,
  latestOutputBytes: 12,
  acceptedInputBytes: 0
}

const agentSession: AgentMuxAgentSession = {
  kind: 'agent',
  agentSessionId: 'semantic-1',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  run: { runId: 'run-1' },
  retiredRuns: [],
  outputCursorBytes: 0,
  createdAt: 100,
  updatedAt: 100
}

describe('AgentMux runtime projection', () => {
  it('projects Agent and Raw Terminal runs without storing terminal output', () => {
    const terminal: AgentMuxRun = {
      ...run,
      runId: 'terminal-1',
      kind: 'terminal',
      providerId: null,
      executorId: null,
      agentSessionId: null
    }
    const subjects = projectAgentMuxRuntimeSubjects('local', [run, terminal], [agentSession])
    expect(subjects).toMatchObject([
      {
        subjectId: 'agent:local:semantic-1',
        kind: 'agent',
        agentSession: { agentSessionId: 'semantic-1' }
      },
      {
        subjectId: 'terminal:local:terminal-1',
        kind: 'terminal',
        run: { latestOutputBytes: 12 }
      }
    ])
    expect(JSON.stringify(subjects)).not.toContain('terminalSnapshot')
  })

  it('projects two independent Runtime Subjects over one Agent Session without changing Agent identity', () => {
    const subjects = projectAgentMuxRuntimeSubjects('local', [run], [agentSession], [
      { subjectId: 'subject-left', target: { kind: 'agent-session', agentSessionId: 'semantic-1' } },
      { subjectId: 'subject-right', target: { kind: 'agent-session', agentSessionId: 'semantic-1' } }
    ])
    expect(subjects.map((subject) => subject.subjectId)).toEqual(['subject-left', 'subject-right'])
    expect(subjects).toMatchObject([
      { agentSession: { agentSessionId: 'semantic-1' }, run: { runId: 'run-1' } },
      { agentSession: { agentSessionId: 'semantic-1' }, run: { runId: 'run-1' } }
    ])
    expect(subjects[0]).not.toBe(subjects[1])
  })

  it('fails closed when an Agent Session record points to another Run', () => {
    try {
      projectAgentMuxRuntimeSubjects('local', [run], [{
        ...agentSession,
        run: { runId: 'stale-run' }
      }])
      throw new Error('Expected Runtime Subject projection to fail.')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'UNKNOWN_RUNTIME_SUBJECT_TARGET',
        message: 'Runtime Subject target is unavailable.'
      })
    }
  })

})

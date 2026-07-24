import { describe, expect, it } from 'vitest'
import { projectAgentMuxViews } from '../src/runtime.js'
import type { AgentMuxAgentSession, AgentMuxRun } from '../src/types.js'

const run: AgentMuxRun = {
  runId: 'run-1',
  incarnationId: 'incarnation-1',
  createOperationId: 'create-1',
  kind: 'agent',
  agentId: 'codex',
  agentSessionId: 'semantic-1',
  workspacePath: '/repo',
  pid: 42,
  state: 'running',
  cols: 80,
  rows: 24,
  createdAt: 100,
  latestOutputBytes: 12,
  acceptedInputBytes: 0
}

const agentSession: AgentMuxAgentSession = {
  kind: 'agent',
  agentSessionId: 'semantic-1',
  agentId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  run: { runId: 'run-1', incarnationId: 'incarnation-1' },
  outputCursorBytes: 0,
  createdAt: 100,
  updatedAt: 100
}

describe('AgentMux runtime projection', () => {
  it('projects Agent and Raw Terminal runs without storing terminal output', () => {
    const terminal: AgentMuxRun = {
      ...run,
      runId: 'terminal-1',
      incarnationId: 'terminal-incarnation',
      createOperationId: 'terminal-create',
      kind: 'terminal',
      agentId: null,
      agentSessionId: null
    }
    const views = projectAgentMuxViews('local', [run, terminal], [agentSession])
    expect(views).toMatchObject([
      {
        viewId: 'agent-view:local:semantic-1',
        kind: 'agent',
        agentSession: { agentSessionId: 'semantic-1' }
      },
      {
        viewId: 'terminal-view:local:terminal-1:terminal-incarnation',
        kind: 'terminal',
        run: { latestOutputBytes: 12 }
      }
    ])
    expect(JSON.stringify(views)).not.toContain('terminalSnapshot')
  })

  it('projects two independent Views over one Agent Session without changing Agent identity', () => {
    const views = projectAgentMuxViews('local', [run], [agentSession], [
      { viewId: 'view-left', target: { kind: 'agent-session', agentSessionId: 'semantic-1' } },
      { viewId: 'view-right', target: { kind: 'agent-session', agentSessionId: 'semantic-1' } }
    ])
    expect(views.map((view) => view.viewId)).toEqual(['view-left', 'view-right'])
    expect(views).toMatchObject([
      { agentSession: { agentSessionId: 'semantic-1' }, run: { runId: 'run-1' } },
      { agentSession: { agentSessionId: 'semantic-1' }, run: { runId: 'run-1' } }
    ])
    expect(views[0]).not.toBe(views[1])
  })

  it('fails closed when an Agent Session record points to another Run incarnation', () => {
    expect(() => projectAgentMuxViews('local', [run], [{
      ...agentSession,
      run: { ...agentSession.run, incarnationId: 'stale-incarnation' }
    }])).toThrow('does not match')
  })
})

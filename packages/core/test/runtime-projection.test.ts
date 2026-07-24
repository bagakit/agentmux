import { describe, expect, it } from 'vitest'
import { projectAgentMuxViews, resolveAgentMuxViewFocus } from '../src/runtime.js'
import type { AgentMuxAgentSession, AgentMuxRun } from '../src/types.js'

const run: AgentMuxRun = {
  runId: 'run-1',
  kind: 'agent',
  agentId: 'codex',
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
  agentId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  run: { runId: 'run-1' },
  retiredRuns: [],
  hookBindingId: 'hook-binding-1',
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
        viewId: 'terminal-view:local:terminal-1',
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

  it('fails closed when an Agent Session record points to another Run', () => {
    expect(() => projectAgentMuxViews('local', [run], [{
      ...agentSession,
      run: { runId: 'stale-run' }
    }])).toThrow('unavailable')
  })

  it('resolves only one currently open Terminal View or Agent View', () => {
    const views = [
      { viewId: 'terminal-left', kind: 'terminal' as const },
      { viewId: 'agent-left', kind: 'agent' as const, agentSessionId: 'semantic-1' }
    ]
    expect(resolveAgentMuxViewFocus(views, { kind: 'terminal-view', viewId: 'terminal-left' })).toEqual({
      viewId: 'terminal-left', kind: 'terminal'
    })
    expect(resolveAgentMuxViewFocus(views, { kind: 'agent-session', agentSessionId: 'semantic-1' })).toEqual({
      viewId: 'agent-left', kind: 'agent'
    })
    expect(() => resolveAgentMuxViewFocus(views, {
      kind: 'terminal-view', viewId: 'closed-terminal'
    })).toThrow('not currently open')
    expect(() => resolveAgentMuxViewFocus([...views, {
      viewId: 'agent-right', kind: 'agent', agentSessionId: 'semantic-1'
    }], {
      kind: 'agent-session', agentSessionId: 'semantic-1'
    })).toThrow('ambiguous')
  })
})

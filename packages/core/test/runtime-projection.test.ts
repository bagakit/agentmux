import { describe, expect, it } from 'vitest'
import type { AgentMuxDaemonSession } from '../src/daemon-protocol.js'
import { projectAgentMuxSessions } from '../src/runtime.js'
import type { AgentMuxSemanticSession } from '../src/types.js'

const run: AgentMuxDaemonSession = {
  sessionId: 'run-1',
  incarnationId: 'incarnation-1',
  createOperationId: 'create-1',
  kind: 'agent',
  agentId: 'codex',
  semanticSessionId: 'semantic-1',
  cwd: '/repo',
  pid: 42,
  state: 'running',
  cols: 80,
  rows: 24,
  createdAt: 100,
  latestSequence: 12,
  acceptedInputSequence: 0
}

const semantic: AgentMuxSemanticSession = {
  kind: 'agent',
  semanticSessionId: 'semantic-1',
  agentId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  daemonSession: { sessionId: 'run-1', incarnationId: 'incarnation-1' },
  outputCursor: 0,
  createdAt: 100,
  updatedAt: 100
}

describe('AgentMux runtime projection', () => {
  it('projects Agent and Raw Terminal runs without storing terminal output', () => {
    const terminal: AgentMuxDaemonSession = {
      ...run,
      sessionId: 'terminal-1',
      incarnationId: 'terminal-incarnation',
      createOperationId: 'terminal-create',
      kind: 'terminal',
      agentId: null,
      semanticSessionId: null
    }
    const sessions = projectAgentMuxSessions('local', [run, terminal], [semantic])
    expect(sessions).toMatchObject([
      { id: 'semantic-1', kind: 'agent', semantic: { semanticSessionId: 'semantic-1' } },
      { id: 'terminal-1', kind: 'terminal', run: { latestSequence: 12 } }
    ])
    expect(JSON.stringify(sessions)).not.toContain('terminalSnapshot')
  })

  it('fails closed when a semantic record points to another daemon incarnation', () => {
    expect(() => projectAgentMuxSessions('local', [run], [{
      ...semantic,
      daemonSession: { ...semantic.daemonSession, incarnationId: 'stale-incarnation' }
    }])).toThrow('does not match')
  })
})

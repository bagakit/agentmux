import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { rowAttention, rowAttentionLabel } from '../src/renderer/src/lib/row-attention.js'

function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function terminal(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

describe('row attention rollup', () => {
  it('stays neutral when nothing under the row wants anything', () => {
    expect(rowAttention([agent('a', 'working'), agent('b', 'running')]))
      .toEqual({ category: null, count: 0, agents: 2 })
    // A row with no Agents at all is neutral too, not an empty warning.
    expect(rowAttention([terminal('t')])).toEqual({ category: null, count: 0, agents: 0 })
  })

  it('surfaces needs-you through a collapsed row, which is the whole point', () => {
    // Before this, a collapsed project holding a waiting Agent looked identical to an idle one.
    expect(rowAttention([agent('a', 'working'), agent('b', 'waiting')]))
      .toEqual({ category: 'needs-you', count: 1, agents: 2 })
  })

  it('counts waiting and blocked as one needs-you class', () => {
    expect(rowAttention([agent('a', 'waiting'), agent('b', 'blocked')]))
      .toEqual({ category: 'needs-you', count: 2, agents: 2 })
  })

  it('ranks needs-you above error, so the row shows the most urgent thing under it', () => {
    const attention = rowAttention([agent('a', 'error'), agent('b', 'waiting')])
    expect(attention.category).toBe('needs-you')
    expect(attention.count).toBe(1)
  })

  it('shows error when that is all there is', () => {
    expect(rowAttention([agent('a', 'error'), agent('b', 'working')]))
      .toEqual({ category: 'error', count: 1, agents: 2 })
  })

  it('does not light the row for a finished Agent', () => {
    // done is a notification and a Board column. A persistent mark would leave the rail always lit and
    // make "someone is waiting on you" indistinguishable from routine completion.
    expect(rowAttention([agent('a', 'done'), agent('b', 'done')]))
      .toEqual({ category: null, count: 0, agents: 2 })
  })

  it('does not light the row for a dropped link', () => {
    // disconnected keeps its neutral treatment here too, matching the shared vocabulary.
    expect(rowAttention([agent('a', 'disconnected')]))
      .toEqual({ category: null, count: 0, agents: 1 })
  })

  it('puts the count in words for the accessible name, not just a colour', () => {
    expect(rowAttentionLabel(rowAttention([agent('a', 'waiting')]))).toBe('1 Agent needs you')
    expect(rowAttentionLabel(rowAttention([agent('a', 'waiting'), agent('b', 'blocked')])))
      .toBe('2 Agents need you')
    expect(rowAttentionLabel(rowAttention([agent('a', 'error')]))).toBe('1 Agent in error')
    // Neutral rows contribute no label at all rather than "0 Agents need you".
    expect(rowAttentionLabel(rowAttention([agent('a', 'working')]))).toBeNull()
  })

  // The rollup being right is not the same as the row using it. These assert the DERIVED attributes the
  // row emits — the data attribute the stylesheet keys on, and the accessible name a reader gets — so
  // the wiring is proven without asserting on CSS declarations.
  it('marks the row with its category so the shared status treatment can apply', () => {
    expect(rowAttention([agent('a', 'waiting')]).category).toBe('needs-you')
    expect(rowAttention([agent('a', 'error')]).category).toBe('error')
    // Neutral means no attribute at all, so a quiet row inherits its normal treatment untouched.
    expect(rowAttention([agent('a', 'working')]).category).toBeNull()
  })

  it('reports the total Agents under the row alongside the attention count', () => {
    // Lets a caller say "1 of 3" without walking the sessions again.
    const attention = rowAttention([agent('a', 'waiting'), agent('b', 'working'), agent('c', 'done')])
    expect(attention).toEqual({ category: 'needs-you', count: 1, agents: 3 })
  })
})

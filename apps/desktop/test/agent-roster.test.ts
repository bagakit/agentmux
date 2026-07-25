import { describe, expect, it } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import {
  buildAgentRoster,
  resolveRosterScopes,
  rosterBadgeCount,
  rowRiskTier
} from '../src/renderer/src/lib/agent-roster.js'

function agent(
  id: string,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): SessionSnapshot {
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
    status: { state: 'working' as AgentDisplayState, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as unknown as SessionSnapshot
}

// A codex-shaped catalog entry carrying only the launch-option DESCRIBE half the roster reads.
function catalogEntry(): AgentCatalogEntry {
  return {
    id: 'codex',
    label: 'Codex',
    launchOptions: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        choices: [
          { id: 'read-only', label: 'Read only', tier: 'safe', argv: [] },
          { id: 'danger-full-access', label: 'Danger full access', tier: 'danger', argv: [] }
        ]
      },
      {
        id: 'approval',
        label: 'Approvals',
        choices: [
          { id: 'untrusted', label: 'Ask for untrusted', tier: 'safe', argv: [] },
          { id: 'never', label: 'Never ask', tier: 'caution', argv: [] }
        ]
      }
    ]
  } as unknown as AgentCatalogEntry
}

describe('agent roster', () => {
  it('enumerates every projected Agent, which the attention bar alone could not', () => {
    // The bar can only route to one Session; with several in flight the rest were invisible.
    const rows = buildAgentRoster({
      sessions: [agent('a'), agent('b'), agent('c')],
      providerCatalog: [catalogEntry()]
    })

    expect(rows.map((row) => row.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('ignores terminals: this is a roster of Agents', () => {
    const terminal = {
      id: 't',
      kind: 'terminal',
      hostId: 'local',
      workspacePath: '/repo',
      label: 'Terminal',
      createdAt: 1,
      updatedAt: 1,
      processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal', hostId: 'local', run: { runId: 'run-t' } }
    } as unknown as SessionSnapshot

    expect(buildAgentRoster({ sessions: [terminal, agent('a')], providerCatalog: [] })
      .map((row) => row.sessionId)).toEqual(['a'])
  })

  it('ranks needs-you first, then error, then working, then idle', () => {
    const rows = buildAgentRoster({
      sessions: [
        agent('idle', { status: { state: 'done', source: 'native-hook', observedAt: 1 } }),
        agent('working', { status: { state: 'working', source: 'native-hook', observedAt: 1 } }),
        agent('error', { status: { state: 'error', source: 'run-process', observedAt: 1 } }),
        agent('waiting', { status: { state: 'waiting', source: 'native-hook', observedAt: 1 } })
      ],
      providerCatalog: []
    })

    expect(rows.map((row) => row.sessionId)).toEqual(['waiting', 'error', 'working', 'idle'])
  })

  it('puts the longest wait first inside one attention class', () => {
    // Matches the attention bar's "jump to the earliest" contract, so list order and bar target agree.
    const rows = buildAgentRoster({
      sessions: [
        agent('recent', { status: { state: 'waiting', source: 'native-hook', observedAt: 900 } }),
        agent('oldest', { status: { state: 'blocked', source: 'native-hook', observedAt: 100 } })
      ],
      providerCatalog: []
    })

    expect(rows.map((row) => row.sessionId)).toEqual(['oldest', 'recent'])
  })

  it('marks the rows Core is holding a request for, so the roster doubles as the work queue', () => {
    const rows = buildAgentRoster({
      sessions: [
        agent('a'),
        agent('b', {
          status: { state: 'waiting', source: 'native-hook', observedAt: 1 },
          pendingInteraction: {
            kind: 'permission',
            id: 'permission-1',
            agentSessionId: 'b',
            title: 'Allow command?',
            options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
            evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run-b' }, hookReceiptId: 'p1' }
          }
        } as never)
      ],
      providerCatalog: []
    })

    expect(rows.find((row) => row.sessionId === 'b')?.awaitingReply).toBe(true)
    expect(rows.find((row) => row.sessionId === 'a')?.awaitingReply).toBe(false)
  })

  it('shows what the Agent was authorized to do, resolved from the Provider declaration', () => {
    // The selection is {optionId: choiceId} and carries no words; the labels come from the same
    // DESCRIBE half the launcher rendered.
    const scopes = resolveRosterScopes(
      { sandbox: 'danger-full-access', approval: 'never' },
      catalogEntry()
    )

    expect(scopes).toEqual([
      { label: 'Sandbox', value: 'Danger full access', tier: 'danger' },
      { label: 'Approvals', value: 'Never ask', tier: 'caution' }
    ])
  })

  it('shows nothing when the create narrowed nothing — absence hides, never a guess', () => {
    // An Agent on Provider defaults has no declared posture to display. Inventing "default" here would
    // claim a fact nobody recorded.
    expect(resolveRosterScopes(undefined, catalogEntry())).toEqual([])
    expect(buildAgentRoster({ sessions: [agent('a')], providerCatalog: [catalogEntry()] })[0]?.scopes)
      .toEqual([])
  })

  it('drops a selection the Provider no longer declares rather than rendering a raw id', () => {
    // A retired choice id shown as a label would read as a verified scope while being unresolvable.
    expect(resolveRosterScopes({ sandbox: 'retired-choice' }, catalogEntry())).toEqual([])
    expect(resolveRosterScopes({ 'retired-option': 'read-only' }, catalogEntry())).toEqual([])
    // With no catalog entry at all there is nothing to resolve against.
    expect(resolveRosterScopes({ sandbox: 'read-only' }, undefined)).toEqual([])
  })

  it('surfaces the most permissive tier as the row mark', () => {
    const rows = buildAgentRoster({
      sessions: [agent('a', { launchOptions: { sandbox: 'danger-full-access', approval: 'never' } } as never)],
      providerCatalog: [catalogEntry()]
    })

    // danger outranks caution: scanning a list, the widest grant is the fact worth seeing.
    expect(rowRiskTier(rows[0]!)).toBe('danger')
    expect(rowRiskTier({ ...rows[0]!, scopes: [{ label: 'Sandbox', value: 'Read only', tier: 'safe' }] }))
      .toBe('safe')
    expect(rowRiskTier({ ...rows[0]!, scopes: [] })).toBeNull()
  })

  it('counts the badge exactly as the attention bar counts, so the two never disagree', () => {
    const rows = buildAgentRoster({
      sessions: [
        agent('a', { status: { state: 'waiting', source: 'native-hook', observedAt: 1 } }),
        agent('b', { status: { state: 'error', source: 'run-process', observedAt: 1 } }),
        agent('c', { status: { state: 'working', source: 'native-hook', observedAt: 1 } }),
        agent('d', { status: { state: 'done', source: 'native-hook', observedAt: 1 } })
      ],
      providerCatalog: []
    })

    // needs-you + error. Working and done are not things waiting on the user.
    expect(rosterBadgeCount(rows)).toBe(2)
    expect(rosterBadgeCount([])).toBe(0)
  })
})

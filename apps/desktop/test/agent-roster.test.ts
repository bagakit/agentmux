import { describe, expect, it } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentDisplayState } from '@agentmux/core'
import { CLAUDE_LAUNCH_OPTIONS, describeLaunchOptions } from '@agentmux/core'
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

// A claude-shaped catalog entry carrying the REAL SSOT launch-option DESCRIBE half, projected exactly as
// the core catalog projects it (agent-provider.ts → describeLaunchOptions). Feeding the same constant the
// launcher reads proves the roster resolves the T-001 model/effort declaration with no renderer change.
function claudeCatalogEntry(): AgentCatalogEntry {
  return {
    id: 'claude',
    label: 'Claude',
    launchOptions: describeLaunchOptions(CLAUDE_LAUNCH_OPTIONS)
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

  it('shows a claude agent its picked model and effort as scope text, with NO risk mark', () => {
    // model and effort carry no tier in the SSOT declaration on purpose (picking a model or reasoning
    // depth neither widens nor narrows a permission), so their scopes must render their labels while the
    // row shows no risk mark at all — a tier here would be a false danger claim.
    const scopes = resolveRosterScopes({ model: 'opus', effort: 'high' }, claudeCatalogEntry())
    expect(scopes).toEqual([
      { label: 'Model', value: 'Opus' },
      { label: 'Effort', value: 'High' }
    ])
    // No scope carries a tier, so no argv/flag word leaked into the resolved display either.
    expect(scopes.every((scope) => scope.tier === undefined)).toBe(true)
    expect(JSON.stringify(scopes)).not.toContain('--model')
    expect(JSON.stringify(scopes)).not.toContain('--effort')

    const rows = buildAgentRoster({
      sessions: [agent('c', { providerId: 'claude', launchOptions: { model: 'opus', effort: 'high' } } as never)],
      providerCatalog: [claudeCatalogEntry()]
    })
    expect(rows[0]?.scopes).toEqual([
      { label: 'Model', value: 'Opus' },
      { label: 'Effort', value: 'High' }
    ])
    // Both choices are tier-less, so the row's single risk mark resolves to null — nothing to flag.
    expect(rowRiskTier(rows[0]!)).toBeNull()
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

// Inbox 不是第二个列表——按这份名册自己的声明（本文件头注释），待办就是它的行。
// 未确认的 Thread 因此是一列，与 awaitingReply 并列，而不是另开一张卡片墙。
describe('未确认 Thread 是名册的一列', () => {
  function sessionWith(id: string): SessionSnapshot {
    return {
      id, kind: 'agent', providerId: 'codex', executorId: 'codex',
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'streaming', permission: 'observe',
        providerResume: true, acp: false, replyCorrelation: 'none'
      },
      hostId: 'local', workspacePath: '/repo', label: id, createdAt: 1, updatedAt: 1,
      processState: 'running', status: { state: 'working', source: 'run-process', observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
    }
  }

  it('把未确认 Thread 数带到对应的行上', () => {
    const rows = buildAgentRoster({
      sessions: [sessionWith('a-1'), sessionWith('a-2')],
      providerCatalog: [],
      unacknowledgedThreads: { 'a-1': 2 }
    })
    expect(rows.find((row) => row.sessionId === 'a-1')?.unacknowledgedThreads).toBe(2)
    // 没有 Thread 的行报 0，而不是 undefined——它是一列，不是可选装饰。
    expect(rows.find((row) => row.sessionId === 'a-2')?.unacknowledgedThreads).toBe(0)
  })

  it('不传时全为 0，名册照常可用', () => {
    const rows = buildAgentRoster({ sessions: [sessionWith('a-1')], providerCatalog: [] })
    expect(rows[0]!.unacknowledgedThreads).toBe(0)
  })
})

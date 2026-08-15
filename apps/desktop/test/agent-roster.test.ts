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
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
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

describe('名册真的把 usage 投影接上了，而不是每行都写死"不报用量"', () => {
  // 这一组守的是**接线**，不是判定。判定层的四条（塌成 0、awaiting 塌成 0、无视 capability 声明、
  // 伪造 tok/s 速率）都在 agent-usage-display.test.ts 里直接调纯函数，各自能变红；但它们一条都
  // 够不着「roster 到底有没有调那个函数」。实测过：把 agent-roster.ts 里的
  // `usage: agentUsageDisplay(session)` 换成写死的 `{kind:'unsupported',text:'',title:''}`，
  // 那 23 条断言**全绿**——于是 claude/codex 明明报了 token 用量，名册上却全变成「不报用量」，
  // 一个用户看得见的功能静默消失。判定有人守而接线无人守，是本仓反复出现的形状。

  function reporting(id: string, turnUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; observedAt: number }): SessionSnapshot {
    return agent(id, {
      capabilities: {
        terminal: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none',
        // 报用量的 Provider（claude/codex）在 catalog 里声明这一项；判定只依据它，不按 Provider 名硬编码。
        usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
      },
      ...(turnUsage ? { turnUsage } : {})
    } as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)
  }

  it('声明了 usage 且跑完过一 turn 的行，带着那一 turn 的真实数字', () => {
    const rows = buildAgentRoster({
      sessions: [reporting('a-1', { inputTokens: 8000, outputTokens: 2432, totalTokens: 10432, observedAt: 5 })],
      providerCatalog: []
    })

    expect(rows[0]!.usage.kind).toBe('tokens')
    // 数字必须真的来自那条 turnUsage：2432 → '2.4k'，那位小数只可能由这个数算出来。
    // 写死一个常量、换个量级、或塌成 'unsupported'，三种改法都过不了。
    expect(rows[0]!.usage.text).toContain('2.4k')
    expect(rows[0]!.usage.title).toContain('10,432')
  })

  it('声明了 usage 但还没有一 turn 的行，报"不知道"而不是 0', () => {
    const rows = buildAgentRoster({ sessions: [reporting('a-1')], providerCatalog: [] })

    expect(rows[0]!.usage.kind).toBe('awaiting')
    // 关键是它**不**是 0：0 会被读成"这一 turn 一个 token 都没花"，那是假话。
    expect(rows[0]!.usage.text).not.toContain('0')
  })

  it('未声明 usage 的行明说不报，且与上面两类分得开', () => {
    // 三态必须在同一次投影里彼此可区分——只验其中一类时，把另外两类折成它也照样绿。
    const rows = buildAgentRoster({
      sessions: [
        reporting('a-1', { inputTokens: 1, outputTokens: 2, totalTokens: 3, observedAt: 5 }),
        reporting('a-2'),
        agent('a-3')
      ],
      providerCatalog: []
    })
    const kindOf = (id: string) => rows.find((row) => row.sessionId === id)!.usage.kind

    expect(kindOf('a-1')).toBe('tokens')
    expect(kindOf('a-2')).toBe('awaiting')
    expect(kindOf('a-3')).toBe('unsupported')
    // 且三者互不相等——任何把两类说成同一件事的改动都在这里红。
    expect(new Set([kindOf('a-1'), kindOf('a-2'), kindOf('a-3')]).size).toBe(3)
  })
})

describe('名册行真的接上了上下文压力，而不是永远不标记', () => {
  // 与上一组同样的形状：判定层（门槛、null 不塌成 safe、两档可区分）在 agent-usage-display.test.ts
  // 里直接调纯函数守着。这一组守的是**接线**——把 agent-roster.ts 里的 `contextPressure(percent)`
  // 换成写死的 `null`，判定层那五条一条都不会红，而名册上「快满了」的提醒会静默消失。

  function withContext(id: string, usedTokens: number, capacityTokens: number): SessionSnapshot {
    return agent(id, {
      capabilities: {
        terminal: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
      },
      turnUsage: {
        inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: 5,
        context: { usedTokens, capacityTokens }
      }
    } as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)
  }

  it('百分比与档位都落到行上，且百分比真的由那两个数算出来', () => {
    // 190_000/200_000 = 95%。写死一个常量、或者取错分母，都算不出这个数。
    const rows = buildAgentRoster({
      sessions: [withContext('a-1', 190_000, 200_000)],
      providerCatalog: []
    })

    expect(rows[0]!.contextPercent).toBe(95)
    expect(rows[0]!.contextPressure).toBe('danger')
  })

  it('三种压力在同一次投影里彼此可区分——把任意两类折成一类都要红', () => {
    // 只验其中一类时，「所有行都返回 null」或「所有行都返回 danger」照样能过。
    const rows = buildAgentRoster({
      sessions: [
        withContext('quiet', 20_000, 200_000),   // 10% → 不标记
        withContext('warm', 150_000, 200_000),   // 75% → caution
        withContext('full', 190_000, 200_000)    // 95% → danger
      ],
      providerCatalog: []
    })
    const pressureOf = (id: string) => rows.find((row) => row.sessionId === id)!.contextPressure

    expect(pressureOf('quiet')).toBeNull()
    expect(pressureOf('warm')).toBe('caution')
    expect(pressureOf('full')).toBe('danger')
    expect(new Set([pressureOf('quiet'), pressureOf('warm'), pressureOf('full')]).size).toBe(3)
  })

  it('不报用量的 Provider：百分比与档位都是 null，绝不塌成 0% 或"安全"', () => {
    // 0% 会被读成「这个 Agent 刚开始跑，还早得很」，而真相是我们根本不知道它用了多少。
    // 这是本组唯一一条能挡住「用 ?? 0 兜底」那类改动的断言。
    const rows = buildAgentRoster({ sessions: [agent('no-usage')], providerCatalog: [] })

    expect(rows[0]!.contextPercent).toBeNull()
    expect(rows[0]!.contextPressure).toBeNull()
  })

  it('声明了 usage 但这一 turn 没带 context：同样是 null，不是 0', () => {
    // 与上一条是不同的缺席形态——Provider 报用量、也跑完了一 turn，只是这一 turn 没采到 context。
    // 两条都要，因为「按 capability 判」和「按 context 在不在判」是两个分岔点。
    const rows = buildAgentRoster({
      sessions: [agent('a-1', {
        capabilities: {
          terminal: true, timeline: 'complete-events', permission: 'observe',
          providerResume: true, replyCorrelation: 'none',
          usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
        },
        turnUsage: { inputTokens: 8000, outputTokens: 2432, totalTokens: 10432, observedAt: 5 }
      } as Partial<Extract<SessionSnapshot, { kind: 'agent' }>>)],
      providerCatalog: []
    })

    // 这一行仍然有 token 用量可显示——两件事互相独立，缺了存量不该把流量也抹掉。
    expect(rows[0]!.usage.kind).toBe('tokens')
    expect(rows[0]!.contextPercent).toBeNull()
    expect(rows[0]!.contextPressure).toBeNull()
  })
})

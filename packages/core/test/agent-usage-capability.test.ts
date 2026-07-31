import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { HOOK_PAYLOAD_USAGE_KEY } from '../src/agent-usage-transcript.js'
import type {
  AgentMuxStoredAgentSession,
  AgentProviderId,
  AgentTurnUsage,
  NativeHookEnvelope
} from '../src/types.js'

// 守 usage 能力的**声明**与 normalizer 对 payload 里 usage 的**投影**两件事。前者是 catalog SSOT 的
// 契约（未声明的 Provider UI 上表现为"不报用量"），后者是 hook 进程抽好的 usage 能穿过 normalizer 到
// 达会话的那一步。

describe('agent usage capability declaration', () => {
  const registry = new AgentProviderRegistry()

  it('claude and codex declare native-transcript usage with the right format', () => {
    expect(registry.get('claude').catalog.capabilities.usage).toEqual({
      kind: 'native-transcript',
      transcriptFormat: 'claude-jsonl'
    })
    expect(registry.get('codex').catalog.capabilities.usage).toEqual({
      kind: 'native-transcript',
      transcriptFormat: 'codex-rollout'
    })
  })

  it('every other built-in provider leaves usage undeclared (surfaces as "no token usage")', () => {
    // 未接入的 Provider 必须是 undefined，UI 据此显示"此 Provider 不报 token 用量"而不是 0。
    // 若给它们误加了 usage 声明，这里会红——守的是验收 1/6 那一侧。
    const others: AgentProviderId[] = [
      'traex', 'hermes', 'pi', 'grok', 'gemini', 'antigravity', 'cursor'
    ]
    for (const id of others) {
      expect(registry.get(id).catalog.capabilities.usage, `${id} must not declare usage`).toBeUndefined()
    }
  })
})

describe('normalizeHook usage projection', () => {
  const registry = new AgentProviderRegistry()

  it('projects usage the hook process merged into the Stop payload onto the event', () => {
    const event = registry.get('claude').normalizeHook({
      receiptId: 'r-usage',
      agentSessionId: 'sess-usage',
      runId: 'run-usage',
      providerId: 'claude',
      eventName: 'Stop',
      payload: {
        last_assistant_message: 'DONE',
        session_id: 'claude-native',
        [HOOK_PAYLOAD_USAGE_KEY]: {
          inputTokens: 2,
          outputTokens: 5,
          totalTokens: 7,
          observedAt: 1234
        }
      }
    })
    expect(event.turnUsage).toEqual({ inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: 1234 })
  })

  it('leaves turnUsage absent when the payload carries no usage', () => {
    // 没有 usage 的收尾事件（Provider 不报、或读 transcript 失败）——turnUsage 必须缺席，绝不合成 0。
    const event = registry.get('claude').normalizeHook({
      receiptId: 'r-nousage',
      agentSessionId: 'sess',
      runId: 'run',
      providerId: 'claude',
      eventName: 'Stop',
      payload: { last_assistant_message: 'DONE', session_id: 'claude-native' }
    })
    expect(event.turnUsage).toBeUndefined()
  })

  it('drops a half-filled usage object rather than half-reporting', () => {
    const event = registry.get('codex').normalizeHook({
      receiptId: 'r-partial',
      agentSessionId: 'sess',
      runId: 'run',
      providerId: 'codex',
      eventName: 'Stop',
      payload: {
        last_assistant_message: 'ok',
        session_id: 'codex-native',
        [HOOK_PAYLOAD_USAGE_KEY]: { inputTokens: 10, outputTokens: 5 }
      }
    })
    expect(event.turnUsage).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 会话侧对 turnUsage 的**权威覆盖**（client.acceptHookEvent 的 persistReceipt reducer）。
// normalizeHook 只做投影；这里守的是投影落到持久会话时的三分支解析：
//   1) 收尾事件带 usage → 用新的（fresh number wins）。
//   2) 收尾事件没带 usage → 清掉上一 turn 的值（收尾本该带用量，没带说明这一 turn 读失败，
//      把陈旧数字挂在「Last turn」下是撒谎）。
//   3) mid-turn 事件没带 usage → 保留上一 turn 的值（迟到的不带 usage 事件不该抹掉刚采到的那一 turn）。
// 「清掉」这一支是 fix #1 的同源陷阱：reducer 用 `...current` 展开，只有把 turnUsage 从基础展开里
// destructure 掉，「不写入」才等于「清掉」而非「保留」。
// ---------------------------------------------------------------------------

const USAGE: AgentTurnUsage = { inputTokens: 11, outputTokens: 22, totalTokens: 33, observedAt: 100 }

function storedClaudeSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'usage-agent',
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'usage-run' },
    retiredRuns: [],
    hookBindingId: 'binding-usage',
    hookToken: 'token-usage',
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'claude-native' }
  }
}

function usageEnvelope(
  receiptId: string,
  eventName: string,
  usage: AgentTurnUsage | null
): NativeHookEnvelope {
  return {
    receiptId,
    agentSessionId: 'usage-agent',
    runId: 'usage-run',
    providerId: 'claude' as AgentProviderId,
    eventName,
    payload: {
      last_assistant_message: 'DONE',
      session_id: 'claude-native',
      ...(usage ? { [HOOK_PAYLOAD_USAGE_KEY]: usage } : {})
    }
  }
}

async function usageClient(): Promise<{
  client: AgentMuxClient
  accept(envelope: NativeHookEnvelope): Promise<void>
  turnUsage(): AgentTurnUsage | undefined
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedClaudeSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as {
    registry: { load(hostId: string): Promise<void> }
    acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  }
  await internals.registry.load('local')
  return {
    client,
    accept: (envelope) => internals.acceptHookEvent(envelope, new AbortController().signal),
    turnUsage: () => client.agentSession('usage-agent').turnUsage
  }
}

describe('turnUsage 会话侧权威覆盖（收尾清、mid-turn 留）', () => {
  it('收尾事件缺用量时清掉上一 turn 的 turnUsage，落回等待记号', async () => {
    const { client, accept, turnUsage } = await usageClient()

    // 防假绿的锚：先让一条带 usage 的收尾事件把值真正写进去。若清空发生在恒为 undefined 的字段上，
    // 这条锚会先红——它证明后面的「变没了」是从有到无，而非本来就没有。
    await accept(usageEnvelope('r-1', 'StopFailure', USAGE))
    expect(turnUsage()).toEqual(USAGE)

    // 再发一条不带 usage 的收尾事件（StopFailure ∈ USAGE_FINALIZATION_EVENTS）：陈旧数字必须被清掉。
    await accept(usageEnvelope('r-2', 'StopFailure', null))
    expect(turnUsage()).toBeUndefined()

    await client.dispose()
  })

  it('收尾事件带用量时用新的覆盖旧的（fresh number wins）', async () => {
    const { client, accept, turnUsage } = await usageClient()

    await accept(usageEnvelope('r-1', 'StopFailure', USAGE))
    expect(turnUsage()).toEqual(USAGE)

    const fresher: AgentTurnUsage = { inputTokens: 5, outputTokens: 6, totalTokens: 11, observedAt: 200 }
    await accept(usageEnvelope('r-2', 'StopFailure', fresher))
    expect(turnUsage()).toEqual(fresher)

    await client.dispose()
  })

  it('mid-turn 事件缺用量时保留上一 turn 的 turnUsage（守另一侧出口）', async () => {
    const { client, accept, turnUsage } = await usageClient()

    // 同一个锚：先把 usage 写进去。
    await accept(usageEnvelope('r-1', 'StopFailure', USAGE))
    expect(turnUsage()).toEqual(USAGE)

    // 一条 mid-turn 事件（PostToolUse ∉ USAGE_FINALIZATION_EVENTS）不带 usage：绝不能抹掉刚采到的那一 turn。
    // 这条守住「永远清」这个变异——只守收尾清空那一侧会把它放过去。
    await accept(usageEnvelope('r-2', 'PostToolUse', null))
    expect(turnUsage()).toEqual(USAGE)

    await client.dispose()
  })
})

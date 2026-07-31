import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { HOOK_PAYLOAD_USAGE_KEY } from '../src/agent-usage-transcript.js'
import type { AgentProviderId } from '../src/types.js'

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

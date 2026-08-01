import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import {
  AGENT_HOOK_LIFECYCLE_DIALECT,
  HOOK_EVENT_NAME_PAYLOAD_KEYS,
  canonicalHookLifecycleEvent,
  rawEventNamesForLifecycle,
  resolveHookEventName
} from '../src/agent-hook-event.js'
import { USAGE_FINALIZATION_EVENTS } from '../src/agent-hook-command.js'
import type { AgentHookLifecycleEvent, AgentCatalogEntry } from '../src/types.js'

/**
 * T-002 的合同测试。分三组，各守验收里一条不同的东西：
 *
 * 1. **七条能力轴**：每个 Provider 的公共合同都同时诚实表达 capability / evidence / Hook /
 *    permission / resume / prompt delivery / reply-correlation，且整份合同可序列化——新 Provider
 *    只填这份声明，Desktop 与 ctxmux 都不必长出分支。
 * 2. **事件名归一化**：三个拼法（hook_event_name / hookEventName / eventName）都到得了同一个
 *    canonical 事件；snake_case 生命周期名按显式映射表归一化。
 * 3. **未知事件可诊断**：归一化不了的事件绝不伪造 working/done，且原始名必须留在诊断里。
 *
 * 归一化的**行为**后果（工具结果能否进时间轴）由 hook-normalizer.test.ts 守；这里守的是协议本身。
 */
describe('Core Provider protocol', () => {
  const registry = new AgentProviderRegistry()
  const providers = registry.list()

  describe('七条能力轴在公共合同上齐备且诚实', () => {
    it('每个 Provider 都声明全部七条轴，没有一条靠代码里的隐式知识', () => {
      expect(providers.length).toBeGreaterThan(0)
      for (const provider of providers) {
        const catalog = provider.catalog
        // 1. capability：逐项声明。
        expect(catalog.capabilities.terminal).toBe(true)
        expect(typeof catalog.capabilities.hookEvents).toBe('boolean')
        // 2. evidence：凭什么算就绪，指名观察者。
        expect(catalog.readySignal).toEqual({
          kind: 'foreground-process',
          expectedProcess: catalog.expectedProcess
        })
        // 3. Hook：有无，以及配置由谁安装。
        expect(['none', 'native']).toContain(catalog.hookStrategy.kind)
        // 4. permission：观察还是应答。
        expect(['none', 'observe', 'respond']).toContain(catalog.capabilities.permission)
        // 5. resume：有无 + 定位器种类。
        expect(['none', 'provider-native']).toContain(catalog.resumeStrategy.kind)
        // 6. prompt delivery：首个 Prompt 如何随启动送达。
        expect(['positional-argv', 'hermes-query', 'flag-prompt-interactive']).toContain(catalog.promptDelivery)
        // 7. reply-correlation：能不能关联回 turn，凭什么关联。
        expect(['none', 'native-turn-id', 'acp-turn-id']).toContain(catalog.capabilities.replyCorrelation)
      }
    })

    it('声明与实际能力对齐：resume 定位器、permission 档位、hook 事件都不许空口宣称', () => {
      for (const provider of providers) {
        const { capabilities, hookStrategy, resumeStrategy } = provider.catalog

        // resume：声明 provider-native 就必须真能构出 argv；声明 none 就必须 fail closed。
        expect(capabilities.providerResume).toBe(resumeStrategy.kind === 'provider-native')
        if (resumeStrategy.kind === 'provider-native') {
          expect(['session-id', 'transcript-path']).toContain(resumeStrategy.locator)
        }

        // hook：没有 hook 的 Provider 不许声明 timeline/permission 能力——没有事件通路就没有证据来源。
        expect(capabilities.hookEvents).toBe(hookStrategy.kind === 'native')
        if (hookStrategy.kind === 'none') {
          expect(capabilities.timeline).toBe('unavailable')
          expect(capabilities.permission).toBe('none')
        }

        // permission: 'respond' 意味着能真的把答案送回去——必须有 interaction 协议兜底。
        // 用一个不存在的 optionId 探测：合法的失败是「找不到这个选项」，而不是「不支持交互」。
        if (capabilities.permission === 'respond') {
          expect(() => provider.planInteractionResponse(
            { kind: 'permission', id: 'probe', agentSessionId: 'probe', title: 'probe', options: [], evidence: { source: 'native-hook', observedAt: 1 } },
            { kind: 'permission', requestId: 'probe', decision: { outcome: 'selected', optionId: 'nope' } }
          )).not.toThrow(/does not support semantic terminal interactions/)
        }

        // usage 是可选轴，但一旦声明就必须是已知的 transcript 格式，不许是个含义未定的真值。
        if (capabilities.usage) {
          expect(capabilities.usage.kind).toBe('native-transcript')
          expect(['claude-jsonl', 'codex-rollout']).toContain(capabilities.usage.transcriptFormat)
        }
      }
    })

    it('整份合同是纯可序列化数据——没有函数或类实例能跨 IPC 丢失', () => {
      for (const entry of registry.catalog()) {
        // JSON 往返后逐字相等：任何函数/undefined/类实例都会在这一步现形。
        expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
        // argv 与键位这类 Provider 私有知识绝不出现在合同里，它们留在 Core 侧。
        const serialized = JSON.stringify(entry)
        expect(serialized).not.toContain('\\u001b')
        for (const value of Object.values(entry as unknown as Record<string, unknown>)) {
          expect(typeof value).not.toBe('function')
        }
      }
    })

    it('capability 轴的取值域由类型收口，registry 投影不丢字段', () => {
      // registry.catalog() 是跨 IPC 的那份投影：它必须带齐每个 Provider 声明的所有轴。
      const projected = registry.catalog()
      expect(projected).toHaveLength(providers.length)
      for (const provider of providers) {
        const entry = projected.find((candidate) => candidate.id === provider.id)
        expect(entry).toBeDefined()
        const axes: Array<keyof AgentCatalogEntry> = [
          'id', 'label', 'executable', 'expectedProcess', 'promptDelivery',
          'readySignal', 'hookStrategy', 'resumeStrategy', 'acpStrategy',
          'capabilities', 'launchOptions'
        ]
        for (const axis of axes) expect(entry).toHaveProperty(axis)
      }
    })
  })

  describe('Hook 事件名归一化', () => {
    it('三个拼法都到得了同一个 canonical 事件——没有一个拼法是二等公民', () => {
      // 这是本 task 的核心诉求之一：hookEventName / eventName / hook_event_name 同权。
      for (const key of HOOK_EVENT_NAME_PAYLOAD_KEYS) {
        expect(resolveHookEventName(undefined, { [key]: 'PostToolUse' })).toBe('PostToolUse')
        expect(canonicalHookLifecycleEvent(resolveHookEventName(undefined, { [key]: 'PostToolUse' })))
          .toBe('tool-use-end')
      }
      // 全部三个键都必须在清单里，缺一个就是回到「各读取点各认两个」的旧状态。
      expect([...HOOK_EVENT_NAME_PAYLOAD_KEYS].sort())
        .toEqual(['eventName', 'hookEventName', 'hook_event_name'])
    })

    it('信封上的显式事件名优先于负载——投递方明说的最权威', () => {
      expect(resolveHookEventName('Stop', { hook_event_name: 'PreToolUse' })).toBe('Stop')
      // 空白/非字符串的显式值不算「说了」，退回负载而不是让事件名变成空串。
      expect(resolveHookEventName('   ', { hook_event_name: 'PreToolUse' })).toBe('PreToolUse')
      expect(resolveHookEventName(undefined, {})).toBeUndefined()
      expect(resolveHookEventName(42, { hook_event_name: 'Stop' })).toBe('Stop')
    })

    it('snake_case 生命周期名按显式映射表归一化，不靠前缀形状去猜', () => {
      // Hermes 的方言。
      expect(canonicalHookLifecycleEvent('on_session_start')).toBe('session-start')
      expect(canonicalHookLifecycleEvent('pre_tool_call')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('post_tool_call')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('post_llm_call')).toBe('turn-end')
      expect(canonicalHookLifecycleEvent('on_session_end')).toBe('turn-end')
      // Pi 的方言。
      expect(canonicalHookLifecycleEvent('tool_execution_start')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('tool_execution_end')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('agent_end')).toBe('turn-end')
      expect(canonicalHookLifecycleEvent('agent_settled')).toBe('turn-end')
      // PascalCase 的方言照旧成立。
      expect(canonicalHookLifecycleEvent('PreToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('PostToolUse')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('Stop')).toBe('turn-end')
    })

    it('不按前缀猜：PostInvocation 不是工具结果，尽管它以 Post 开头', () => {
      // 这一条正是被取代的 `startsWith('Post')` 会答错的地方——Antigravity 的 PostInvocation 是
      // 一次调用的外层收尾，不是一次工具调用的结果。形状推理会把它误判成带结果的事件。
      expect(canonicalHookLifecycleEvent('PostInvocation')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('PreInvocation')).toBeUndefined()
    })

    it('turn 收尾集合由映射表派生，覆盖每一家的收尾方言而不是只有 PascalCase 两条', () => {
      // USAGE_FINALIZATION_EVENTS 此前硬编码 ['Stop','StopFailure']：Hermes 与 Pi 的收尾读不到用量。
      for (const raw of ['Stop', 'StopFailure', 'post_llm_call', 'on_session_end', 'agent_end', 'agent_settled']) {
        expect(USAGE_FINALIZATION_EVENTS.has(raw)).toBe(true)
        expect(canonicalHookLifecycleEvent(raw)).toBe('turn-end')
      }
      // 非收尾事件绝不在集合里——否则 mid-turn 事件会去读 transcript、还会误清上一 turn 的用量。
      for (const raw of ['PreToolUse', 'PostToolUse', 'pre_tool_call', 'post_tool_call', 'SessionStart']) {
        expect(USAGE_FINALIZATION_EVENTS.has(raw)).toBe(false)
      }
      // 集合与映射表是同一份真相的两种形状，不许 drift。
      expect([...USAGE_FINALIZATION_EVENTS].sort()).toEqual([...rawEventNamesForLifecycle('turn-end')].sort())
    })

    it('映射表的每个值都是词汇表成员，反查是它的忠实逆运算', () => {
      const vocabulary: readonly AgentHookLifecycleEvent[] = [
        'session-start', 'user-prompt-submit', 'permission-request',
        'tool-use-start', 'tool-use-end', 'subagent-start', 'subagent-stop', 'turn-end'
      ]
      for (const canonical of Object.values(AGENT_HOOK_LIFECYCLE_DIALECT)) {
        expect(vocabulary).toContain(canonical)
      }
      for (const canonical of vocabulary) {
        const raws = rawEventNamesForLifecycle(canonical)
        expect(raws.length).toBeGreaterThan(0)
        for (const raw of raws) expect(canonicalHookLifecycleEvent(raw)).toBe(canonical)
      }
    })
  })

  describe('未知事件保持可诊断，绝不伪造语义', () => {
    it('归一化不了的事件：lifecycleEvent 缺席，原始名留在诊断里', () => {
      const event = registry.get('traex').normalizeHook({
        receiptId: 'r-unknown',
        agentSessionId: 's-unknown',
        runId: 'run-unknown',
        providerId: 'traex',
        eventName: 'quantum_flux_observed'
      })
      // 缺席，而不是被塞一个「差不多」的 canonical 值。
      expect(event.lifecycleEvent).toBeUndefined()
      // 绝不伪造 working/done。
      expect(event.semanticState).toBe('unknown')
      expect(event.status.state).toBe('running')
      // 原始名逐字可诊断——这是排查「Core 为什么没认出来」的唯一线索。
      expect(event.eventName).toBe('quantum_flux_observed')
      expect(event.status.detail).toBe('quantum_flux_observed')
    })

    it('事件名压根读不出来时如实记 unknown，而不是猜一个', () => {
      const event = registry.get('traex').normalizeHook({
        receiptId: 'r-nameless',
        agentSessionId: 's-nameless',
        runId: 'run-nameless',
        providerId: 'traex',
        payload: { some_unrelated_field: 'x' }
      })
      expect(event.eventName).toBe('unknown')
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
    })

    it('canonical 事件在场时，原始名依然逐字保留——两者并存不互相取代', () => {
      const event = registry.get('hermes').normalizeHook({
        receiptId: 'r-both',
        agentSessionId: 's-both',
        runId: 'run-both',
        providerId: 'hermes',
        eventName: 'post_tool_call',
        payload: { tool_name: 'shell' }
      })
      expect(event.lifecycleEvent).toBe('tool-use-end')
      // 原始名没有被 canonical 值顶掉。
      expect(event.eventName).toBe('post_tool_call')
      expect(event.status.detail).toBe('post_tool_call')
    })

    it('未知事件不产生 handle，也不产生用量——缺席一路传导到底', () => {
      const event = registry.get('claude').normalizeHook({
        receiptId: 'r-unknown-2',
        agentSessionId: 's-unknown-2',
        runId: 'run-unknown-2',
        providerId: 'claude',
        eventName: 'TotallyMadeUpEvent',
        payload: {}
      })
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.nativeHandle).toBeUndefined()
      expect(event.turnUsage).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
    })
  })

  describe('native handle 仍由 Provider 自己解释', () => {
    it('Provider 声明的键名决定 handle 从哪读——Core 不认识「哪个键装着会话 id」', () => {
      // Antigravity 声明 conversationId 优先；Core 没有任何地方硬编码这个键名。
      const antigravity = registry.get('antigravity').normalizeHook({
        receiptId: 'r-agy',
        agentSessionId: 's-agy',
        runId: 'run-agy',
        providerId: 'antigravity',
        eventName: 'SessionStart',
        payload: { conversationId: 'agy-conversation-1' }
      })
      expect(antigravity.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'antigravity',
        sessionId: 'agy-conversation-1'
      })

      // Pi 声明 session_file 作为 transcript 且要求它在场——同一个 Core 代码路径，不同 Provider 声明。
      const pi = registry.get('pi').normalizeHook({
        receiptId: 'r-pi',
        agentSessionId: 's-pi',
        runId: 'run-pi',
        providerId: 'pi',
        eventName: 'agent_start',
        payload: { session_id: 'pi-1', session_file: '/tmp/pi-protocol.jsonl' }
      })
      expect(pi.nativeHandle).toMatchObject({ sessionId: 'pi-1', transcriptPath: '/tmp/pi-protocol.jsonl' })
    })

    it('camelCase 与 snake_case 的 handle 键在同一个 Provider 上都读得出', () => {
      for (const key of ['session_id', 'sessionId'] as const) {
        const event = registry.get('antigravity').normalizeHook({
          receiptId: `r-${key}`,
          agentSessionId: `s-${key}`,
          runId: `run-${key}`,
          providerId: 'antigravity',
          eventName: 'SessionStart',
          payload: { [key]: `agy-${key}` }
        })
        expect(event.nativeHandle).toMatchObject({ sessionId: `agy-${key}` })
      }
      for (const key of ['transcript_path', 'transcriptPath'] as const) {
        const event = registry.get('claude').normalizeHook({
          receiptId: `r-${key}`,
          agentSessionId: `s-${key}`,
          runId: `run-${key}`,
          providerId: 'claude',
          eventName: 'SessionStart',
          payload: { session_id: 'claude-1', [key]: '/tmp/claude-protocol.jsonl' }
        })
        expect(event.nativeHandle).toMatchObject({ transcriptPath: '/tmp/claude-protocol.jsonl' })
      }
    })

    it('未声明 handle 的 Provider 永远不产生 handle，哪怕负载里躺着一个 session_id', () => {
      // Hermes 没有 nativeHandle 声明，也没有 native resume。Core 绝不替它「顺手」认一个 handle：
      // 那会让一个不支持 resume 的 Provider 看起来可以 resume。
      const event = registry.get('hermes').normalizeHook({
        receiptId: 'r-hermes-handle',
        agentSessionId: 's-hermes-handle',
        runId: 'run-hermes-handle',
        providerId: 'hermes',
        eventName: 'on_session_start',
        payload: { session_id: 'hermes-looks-resumable', transcript_path: '/tmp/hermes.jsonl' }
      })
      expect(event.nativeHandle).toBeUndefined()
      expect(registry.get('hermes').catalog.resumeStrategy.kind).toBe('none')
    })
  })
})

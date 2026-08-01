import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOKS, createClaudeManagedHookPlan } from '../../src/providers/claude.js'
import { canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { USAGE_FINALIZATION_EVENTS } from '../../src/agent-hook-command.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-006 的 Provider 测试。
 *
 * 证据来自**读本机安装的 claude CLI**（`~/.local/share/claude/versions/2.1.252`，单文件 bun 打包）：
 * 事件全集取自它的 `_y` 数组（33 个），每个事件的负载形状取自同文件里的 zod schema，
 * matcher 归属取自它内嵌文档的 Hook Events 表。
 *
 * 这些断言证明「声明与本机 CLI 读出的合同相符」，**不**证明「跑过一次真实会话并收到了这些事件」。
 */
describe('Claude provider', () => {
  const providers = new AgentProviderRegistry()
  const claude = providers.get('claude')

  function hook(eventName: string, payload: Record<string, unknown> = {}) {
    return claude.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-claude',
      runId: 'run-claude',
      providerId: 'claude',
      eventName,
      payload: { hook_event_name: eventName, session_id: 'sess-1', ...payload }
    })
  }

  function toolMutation(event: ReturnType<typeof hook>) {
    const mutation = event.timeline.find(
      (candidate) => candidate.type !== 'update' && candidate.item.kind === 'tool_call'
    )
    if (!mutation || mutation.type === 'update') {
      throw new Error('expected a tool_call timeline item carrying a full item')
    }
    return mutation
  }

  /**
   * 本 task 的核心守卫：**rules 里引用的每个事件都必须真的被安装**。
   *
   * 这是一族真实存在过的缺陷，不是假想的：`CLAUDE_HOOKS.rules` 引用 `PostToolUseFailure`、
   * `StopFailure`、`PreCompact`，而 `CLAUDE_HOOK_EVENTS`（决定往 settings.json 写什么）三个都不含。
   * 于是 Claude 从不发它们，rules 里那三个名字永远命中不到——声明看着完整，运行时是死的。
   * 同族的 grok Provider 反倒把 `PostToolUseFailure`/`StopFailure` 装上了，说明这是 Claude 独有的遗漏。
   *
   * 守的是「两份清单的一致性」而不是「清单等于某个字面量列表」：后者只会在有人改清单时提醒改测试，
   * 前者才会在有人**只改一半**时报红。
   */
  describe('声明与安装必须一致：rules 引用的事件都得真装上', () => {
    it('rules 与 subagentTracking 引用的每个事件都在安装清单里', () => {
      const referenced = new Set<string>()
      for (const rule of CLAUDE_HOOKS.rules) for (const eventName of rule.events) referenced.add(eventName)
      const tracking = CLAUDE_HOOKS.subagentTracking
      for (const eventName of [
        ...(tracking?.startEvents ?? []), ...(tracking?.stopEvents ?? []), ...(tracking?.mainStopEvents ?? [])
      ]) referenced.add(eventName)

      const installed = new Set<string>(CLAUDE_HOOK_EVENTS)
      const declaredButNotInstalled = [...referenced].filter((eventName) => !installed.has(eventName))
      expect(declaredButNotInstalled).toEqual([])
    })

    it('三个补装的事件确实写进了 settings.json，而不只是进了常量清单', () => {
      // 常量清单绿了但计划没渲染出来，等于装了个假。这条读真实渲染结果。
      const plan = resolveManagedHookPlan('claude', '/tmp/work')
      const written = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
      }
      for (const eventName of ['PostToolUseFailure', 'StopFailure', 'PreCompact']) {
        expect(written.hooks[eventName]?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
      }
      // 安装的事件集恰好等于声明的清单——没有多写没有少写。
      expect(Object.keys(written.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
    })

    it('三个 tool 事件都带 matcher，其余生命周期事件都不带', () => {
      // 本机 bundle 内嵌文档的 Hook Events 表里，PreToolUse/PostToolUse/PostToolUseFailure 的
      // Matcher 列都是 "Tool name"。缺了 matcher，Claude 对 tool 事件不会分派到我们这条。
      const written = JSON.parse(createClaudeManagedHookPlan('/tmp/work').mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string }>>
      }
      const withMatcher = Object.entries(written.hooks)
        .filter(([, entries]) => entries[0]?.matcher !== undefined)
        .map(([eventName]) => eventName).sort()
      expect(withMatcher).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse'])
      expect(new Set(Object.values(written.hooks).map((entries) => entries[0]?.matcher)))
        .toEqual(new Set(['*', undefined]))
    })

    it('不装那些每次文件变动/每条通知都触发的高频与 UI 事件', () => {
      // 本机 CLI 的事件全集有 33 个。装这些等于把子进程挂到最热的路径上，而 Core 没有判断需要它们。
      for (const hot of [
        'FileChanged', 'CwdChanged', 'DirectoryAdded', 'MessageDisplay', 'StatusLine',
        'FileSuggestion', 'Notification', 'PostToolBatch'
      ]) {
        expect(CLAUDE_HOOK_EVENTS).not.toContain(hot)
      }
    })
  })

  describe('一次失败的工具调用：判红之外还要看得见原因', () => {
    it('PostToolUseFailure 判 failed 并把 error 当正文——它没有 tool_response', () => {
      // 本机 schema 逐字：{tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}。
      // **没有** tool_response——`PostToolUse` 只在成功时触发（内嵌文档："Run after successful tool"）。
      // 少了对 `error` 的正文回退，用户只看得见一个红标记，看不见 "exit status 1" 这句话。
      const failure = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9',
        error: 'exit status 1: 3 tests failed', is_interrupt: false, duration_ms: 900
      }))
      expect(failure.type).toBe('upsert')
      expect(failure.item.id).toBe('run-claude:tool:tu-9')
      expect(failure.item.status).toBe('failed')
      expect(failure.item.toolOutput).toBe('exit status 1: 3 tests failed')
    })

    it('PostToolUse 成功路径仍读 tool_response，不被失败回退抢走', () => {
      const success = toolMutation(hook('PostToolUse', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9',
        tool_response: { stdout: '12 passed' }
      }))
      expect(success.item.status).toBe('complete')
      expect(success.item.toolOutput).toBe('12 passed')
    })

    it('PostToolUseFailure 与 PreToolUse 收敛到同一条，而不是并排两行', () => {
      const pre = toolMutation(hook('PreToolUse', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9'
      }))
      expect(pre.item.status).toBe('streaming')
      const failure = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu-9', error: 'boom'
      }))
      expect(failure.item.id).toBe(pre.item.id)
    })

    it('只有 is_interrupt 没有 error 时不判失败——它证明不了这一步的成败', () => {
      const blank = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu-x', is_interrupt: true
      }))
      expect(blank.item.status).toBe('complete')
    })
  })

  describe('两条互斥的收尾：Stop 与 StopFailure', () => {
    it('StopFailure 判 done 并归入 turn-end——它取代 Stop，报错收尾不会有 Stop', () => {
      // 少了它，Agent 报错后会永远停在 working，且没有任何后续事件能把它救回来。
      const event = hook('StopFailure', { error: 'model overloaded', error_details: 'HTTP 529' })
      expect<AgentSemanticState>(event.semanticState).toBe('done')
      expect(event.lifecycleEvent).toBe('turn-end')
    })

    it('Stop 与 StopFailure 都是用量落定点，用量收口两侧共用同一份口径', () => {
      // USAGE_FINALIZATION_EVENTS 从 canonical 表派生。两条收尾都在里面，否则报错收尾的用量读不到。
      for (const eventName of ['Stop', 'StopFailure']) {
        expect(canonicalHookLifecycleEvent(eventName)).toBe('turn-end')
        expect(USAGE_FINALIZATION_EVENTS.has(eventName)).toBe(true)
      }
    })

    it('PreCompact 判 working：压缩期间没有工具事件，少了它长压缩看起来像卡死', () => {
      const event = hook('PreCompact', { trigger: 'auto', custom_instructions: null })
      expect(event.semanticState).toBe('working')
      // Core 今天没有判断需要「压缩」这一步，故刻意不给 canonical 生命周期。
      expect(event.lifecycleEvent).toBeUndefined()
    })

    it('未安装的事件到达时保持可诊断，绝不伪造状态', () => {
      // PostCompact/SessionEnd/TeammateIdle 都是本机 CLI 真实存在的事件，只是我们没装。万一从别处
      // 到达（用户自己在 settings.json 里加了同一条命令），必须如实说不认识而不是补一个 working。
      for (const eventName of ['PostCompact', 'SessionEnd', 'TeammateIdle', 'TaskCompleted']) {
        const event = hook(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.status.detail).toBe(eventName)
      }
    })
  })

  describe('nativeHandle 与 usage 的声明都有本机佐证', () => {
    it('从负载读出 session_id 与 transcript_path，两者都是 resume 与用量的前提', () => {
      const event = hook('Stop', {
        stop_hook_active: false, transcript_path: '/tmp/t.jsonl', last_assistant_message: 'done'
      })
      expect(event.nativeHandle).toEqual({
        kind: 'provider', providerId: 'claude', sessionId: 'sess-1', transcriptPath: '/tmp/t.jsonl'
      })
    })

    it('catalog 的 usage 声明与真实 transcript 格式一致', () => {
      expect(claude.catalog.capabilities.usage)
        .toEqual({ kind: 'native-transcript', transcriptFormat: 'claude-jsonl' })
      expect(claude.catalog.capabilities.permission).toBe('respond')
    })
  })
})

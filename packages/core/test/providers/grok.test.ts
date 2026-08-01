import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { resolveManagedHookPlan } from '../../src/agent-provider.js'
import { GROK_HOOK_EVENTS } from '../../src/providers/grok.js'
import { canonicalHookLifecycleEvent, GROK_HOOK_DIALECT } from '../../src/agent-hook-event.js'
import { USAGE_FINALIZATION_EVENTS, hookResponseFor } from '../../src/agent-hook-command.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-003 的 Provider 测试。每条断言背后都有一份可复验的真实 CLI 证据
 * （`grok --help`、`grok inspect`、grok 自带的 hooks 文档），见
 * docs/reviews/agentmux-provider-cli-evidence.md 的 Grok 小节。
 *
 * 这里守的是「声明与真实能力逐项相符」：能力声明、两种拼法各归其位、三种收尾都算 done、
 * 安装只落在受信目录、resume argv 精确，以及缺 handle 时 fail closed。
 */
describe('Grok provider', () => {
  const providers = new AgentProviderRegistry()
  const grok = providers.get('grok')

  /** 造一条 grok 形状的 hook 信封：负载键一律 camelCase，事件名走 `hookEventName`。 */
  function hook(eventName: string, payload: Record<string, unknown> = {}) {
    return grok.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-grok',
      runId: 'run-grok',
      providerId: 'grok',
      payload: { hookEventName: eventName, sessionId: 'grok-session-1', ...payload }
    })
  }

  /**
   * 取出这条事件产生的那条工具行，并把 mutation 联合类型**收窄**到带 `item` 的那两支。
   *
   * 收窄不是为了让 tsc 闭嘴：`update` 支压根没有 `item`（它只带 itemId + 若干可选字段），
   * 不收窄就写 `.item.status` 会在 update 支上恒为 undefined——而 vitest 只转译不做类型检查，
   * 于是断言会**静默退化成 `undefined === undefined` 式的假绿**。这里一次判断换来后面每条断言
   * 都真的落在实际字段上。
   */
  function toolMutation(event: ReturnType<typeof hook>) {
    const mutation = event.timeline.find(
      (candidate) => candidate.type !== 'update' && candidate.item.kind === 'tool_call'
    )
    if (!mutation || mutation.type === 'update') throw new Error('expected a tool_call timeline item carrying a full item')
    return mutation
  }

  describe('能力声明与真实 CLI 相符', () => {
    it('不再是 terminal-only：Hook 与 native resume 都按实测声明', () => {
      const { capabilities, hookStrategy, resumeStrategy } = grok.catalog
      // `grok inspect` 报 Hooks (18)，且 ~/.grok/hooks/*.json 是 always-trusted 的安装位。
      expect(hookStrategy).toEqual({ kind: 'native', installation: 'explicit-managed' })
      expect(capabilities.hookEvents).toBe(true)
      expect(capabilities.timeline).toBe('complete-events')
      // `grok --help`: -r, --resume [<SESSION_ID_OR_TITLE>]；--session-id 是给新会话指定 UUID。
      expect(resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(capabilities.providerResume).toBe(true)
      // observe 而非 respond：回 deny/ask 需要把 fire-and-forget 的 hook 变成阻塞 RPC，那条通路不存在。
      expect(capabilities.permission).toBe('observe')
      // grok 不报 transcript 路径，故不声明 usage——没有 transcript 就抽不到 token。
      expect(capabilities.usage).toBeUndefined()
    })
  })

  describe('配置侧 PascalCase 与投递侧 snake_case 各归其位', () => {
    it('装进配置的是 PascalCase，而 normalizer 认的是 snake_case——两份清单必须一一对应', () => {
      // 这是 grok 最容易接错的地方：任一边用错拼法都会静默失效（装了不触发／触发了认不出）。
      for (const configured of GROK_HOOK_EVENTS) expect(configured).toMatch(/^[A-Z]/)
      for (const wire of Object.keys(GROK_HOOK_DIALECT)) {
        expect(wire).toMatch(/^[a-z0-9_]+$/)
        expect(canonicalHookLifecycleEvent(wire)).toBeDefined()
      }
      // 真正的守门条：两份清单一一对应。装了却不认 → 事件白触发，状态丢；认了却没装 → 那条
      // 映射永远等不到事件。两种都是静默失效，只有逐项对上才能排除。
      const configuredAsWire = GROK_HOOK_EVENTS.map((name) =>
        name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
      ).sort()
      expect(configuredAsWire).toEqual(Object.keys(GROK_HOOK_DIALECT).sort())

      // 反过来不能断言「配置名一律认不出」——那是假的：`SessionStart`/`PreToolUse` 这些同时是
      // Claude 一族**真实的 wire 值**，它们本来就在合并表里（走 Claude 那块）。合并表按原始名索引、
      // 只答结构步骤，本就允许同名跨 Provider。能证明两个面确实分开的是 grok 配置侧独有的那个名字：
      expect(GROK_HOOK_EVENTS).toContain('StopCancelled')
      expect(canonicalHookLifecycleEvent('StopCancelled')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('stop_cancelled')).toBe('turn-end')
    })

    it('camelCase 的 hookEventName 能驱动 status 与 timeline', () => {
      const event = hook('pre_tool_use', { toolName: 'run_terminal_command', toolInput: { command: 'npm test' } })
      expect(event.lifecycleEvent).toBe('tool-use-start')
      expect(event.semanticState).toBe('working')
      expect(event.eventName).toBe('pre_tool_use')
      expect(event.timeline.length).toBeGreaterThan(0)
    })

    it('sessionId（camelCase）读得出 handle，而 snake_case 的 session_id 不是 grok 的拼法', () => {
      expect(hook('session_start').nativeHandle).toEqual({
        kind: 'provider', providerId: 'grok', sessionId: 'grok-session-1'
      })
      // 只给 snake_case：grok 从不这么发，不该凭空认出一个 handle。
      const snake = grok.normalizeHook({
        receiptId: 'r-snake', agentSessionId: 's-grok', runId: 'run-grok', providerId: 'grok',
        payload: { hookEventName: 'session_start', session_id: 'not-groks-spelling' }
      })
      expect(snake.nativeHandle).toBeUndefined()
    })
  })

  describe('三种收尾都算 done——少一种就会永远卡在 working', () => {
    it('stop / stop_failure / stop_cancelled 全部收敛为 done', () => {
      // stop_cancelled 最要紧：中断、拒绝授权、max-turns、无进展时它**取代** stop，
      // 也就是说这几种收尾根本不会有 stop。漏掉它，用户按下中断后 Agent 永远停在 working。
      for (const wire of ['stop', 'stop_failure', 'stop_cancelled']) {
        const event = hook(wire)
        expect<AgentSemanticState>(event.semanticState).toBe('done')
        expect(event.lifecycleEvent).toBe('turn-end')
        // 收尾事件必须进 turn-end 集合，否则用量读取与「清掉陈旧用量」两侧都会漏掉它。
        expect(USAGE_FINALIZATION_EVENTS.has(wire)).toBe(true)
      }
    })

    it('一次工具调用两端收敛到同一条：事前 streaming，事后按 toolResult 判成败', () => {
      // grok 的每条工具事件都带 `toolUseId`（其文档明说 payload always includes toolUseId），
      // 所以两端必须落到**同一条** item 上；工具输出字段是 `toolResult`（不是 Claude 的 tool_response）。
      const call = { toolName: 'run_terminal_command', toolUseId: 'tu-1', toolInput: { command: 'npm test' } }

      const before = toolMutation(hook('pre_tool_use', call))
      // 事前谈不上成败，只能是在途——盖 complete/failed 都是编造。
      expect(before.item.status).toBe('streaming')
      expect(before.type).toBe('append')

      const failed = toolMutation(hook('post_tool_use_failure', { ...call, toolResult: { stdout: 'boom', exit_code: 2 } }))
      expect(failed.item.status).toBe('failed')
      expect(failed.item.toolOutput).toContain('boom')
      // 事后走 upsert 并复用事前那条 id：时间轴上一次调用就是一行。
      expect(failed.type).toBe('upsert')
      expect(failed.item.id).toBe(before.item.id)

      // 成功与失败必须长得不一样——这正是「失败的命令和成功的长得一模一样」那个缺陷的守卫。
      const ok = toolMutation(hook('post_tool_use', { ...call, toolResult: { stdout: 'all good', exit_code: 0 } }))
      expect(ok.item.status).toBe('complete')
      expect(ok.item.status).not.toBe(failed.item.status)
    })

    it('等用户回答的工具判 waiting——grok 自动放行它，于是它在阻塞时仍发 pre_tool_use', () => {
      expect(hook('pre_tool_use', { toolName: 'ask_user_question' }).semanticState).toBe('waiting')
    })

    it('未知事件保持可诊断，绝不伪造状态', () => {
      const event = hook('quantum_flux')
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
      expect(event.status.detail).toBe('quantum_flux')
    })
  })

  describe('grok 的 Stop 只能以「报告」身份到达，绝不能变成 gate', () => {
    it('hook 子进程对 grok 一律回不带 decision 的 {}，因此 Stop 不会变成续跑 gate', () => {
      // grok 文档 :328 的陷阱：`Stop` 一旦被当作**阻断式 gate** 并 block，会在每一轮续跑时重复
      // 触发，而被动观察者分不清「续跑那次」和「最终那次」（两者 stopHookActive 都为 true），于是
      // "a UI gated on Stop alone shows a false idle"。AgentMux 躲开它靠的不是运气，而是这条：
      // 子进程从不应答 decision，grok 的 Stop 因此只会以报告身份触发一次。
      for (const eventName of ['Stop', 'PreToolUse', 'SubagentStop', 'StopCancelled']) {
        const response = hookResponseFor('grok', eventName)
        expect(JSON.parse(response)).toEqual({})
        // 不是空 stdout：grok 的 Stop 在「stdout 无可用 JSON」时会让 exit code 说话（文档 :291），
        // 一个合法的空对象把决定权明确交还给它自己的权限流程。
        expect(response.trim()).toBe('{}')
      }
      // 反面对照：只有 Antigravity 把这个 hook 当 gate（空 stdout 读作硬拒绝），它才拿到 decision。
      // 这条同时守住「别把 Antigravity 的形状喷给别家」——grok 收到 `{"decision":"ask"}` 会被判成
      // unrecognized decision 并留下告警。
      expect(hookResponseFor('antigravity', 'PreToolUse')).toContain('"decision"')
      expect(hookResponseFor('grok', 'PreToolUse')).not.toContain('decision')
    })
  })

  describe('managed install 只落在受信目录，且不污染别家配置', () => {
    const plan = resolveManagedHookPlan('grok', '/repo')

    it('装到 ~/.grok/hooks/ 下自有文件，绝不写 Claude 或 Cursor 的配置', () => {
      expect(plan).not.toBeNull()
      expect(plan?.mutations).toHaveLength(1)
      const target = plan!.mutations[0]!.path
      // grok 文档：~/.grok/hooks/*.json 是 always-trusted，无需 folder-trust 授权。
      expect(target).toContain('/.grok/hooks/')
      expect(target.endsWith('agentmux-status.json')).toBe(true)
      // grok 会主动扫这两处做兼容——往里写会让一次 grok 安装改掉用户 Claude/Cursor 的行为。
      expect(target).not.toContain('.claude')
      expect(target).not.toContain('.cursor')
      // 只按自有 marker 合并，保留用户其他 hooks。
      expect(plan!.mutations[0]!.merge).toEqual({ kind: 'json-managed-events', marker: 'agentmux-hook.js' })
      expect(plan!.mutations[0]!.mode).toBe(0o600)
    })

    it('装的事件恰好是声明的那些，且 matcher 只出现在工具类事件上', () => {
      const written = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string }>>
      }
      expect(Object.keys(written.hooks).sort()).toEqual([...GROK_HOOK_EVENTS].sort())
      for (const [eventName, groups] of Object.entries(written.hooks)) {
        const isToolEvent = eventName.includes('ToolUse')
        // grok 明说 Stop/UserPromptSubmit 上的 matcher 会被忽略并告警——写了只留噪音。
        expect(Object.hasOwn(groups[0]!, 'matcher')).toBe(isToolEvent)
      }
    })
  })

  describe('resume argv 精确，缺 handle 时 fail closed', () => {
    it('argv 恰为 grok --resume <session-id>，prompt 走 `--` 分隔', () => {
      expect(grok.buildResumeLaunch({
        workspacePath: '/repo',
        nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'abc-123' },
        prompt: 'continue now',
        args: ['--model', 'grok-4'],
        env: {}
      })).toEqual({
        command: 'grok',
        args: ['--resume', 'abc-123', '--model', 'grok-4', '--', 'continue now'],
        env: {}
      })
    })

    it('handle 属于别家时拒绝，并说清卡在哪', () => {
      let error: AgentMuxError | undefined
      try {
        grok.buildResumeLaunch({
          workspacePath: '/repo',
          nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'not-grok' },
          args: [], env: {}
        })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(error?.detail).toContain('expectedProviderId=grok')
      // 会话 id 是用户可定位内容，不许进跨边界的诊断。
      expect(error?.detail).not.toContain('not-grok')
    })
  })
})

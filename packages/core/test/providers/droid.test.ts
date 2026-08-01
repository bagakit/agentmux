import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { DROID_HOOK_EVENTS, DROID_HOOKS, createDroidManagedHookPlan } from '../../src/providers/droid.js'
import { canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { renderMergedHookContent } from '../../src/hook-config-merge.js'
import { USAGE_FINALIZATION_EVENTS } from '../../src/agent-hook-command.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-011 的 Provider 测试。
 *
 * 证据来自**读本机下载的第一方发行物**（`@factory/cli-darwin-arm64@0.208.2` 里的 `bin/droid`，
 * 一个 264MB 的 bun 单文件可执行）。决定性的一段是它内嵌的 zod schema：事件枚举、hooks 配置的
 * 顶层结构、每条 hook 条目的形状，三者都在同一处逐字可读；每个事件的负载键取自各自的派发点
 * （`SZ("<Event>", {...})`）。
 *
 * 这些断言证明「声明与发行物里读出的合同相符」，**不**证明「跑过一次真实会话」——本机没装这个
 * CLI，不冒充。
 */
describe('Droid provider', () => {
  const providers = new AgentProviderRegistry()
  const droid = providers.get('droid')

  /**
   * 造一条 droid 形状的信封：事件名 PascalCase，负载键 snake_case。
   *
   * `runId` **必须**逐个用例区分：子代理花名册是 normalizer 里按 runId 索引的模块级可变状态，
   * 共用一个 runId 会让某个用例记下的在途子代理压住另一个用例的 Stop。
   */
  function hookIn(runId: string) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      droid.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-droid',
        runId,
        providerId: 'droid',
        eventName,
        payload: {
          hook_event_name: eventName,
          session_id: 'droid-session-1',
          transcript_path: '/tmp/droid/transcript.jsonl',
          cwd: '/repo',
          permission_mode: 'off',
          ...payload
        }
      })
  }

  function toolMutation(event: ReturnType<ReturnType<typeof hookIn>>) {
    const mutation = event.timeline.find(
      (candidate) => candidate.type !== 'update' && candidate.item.kind === 'tool_call'
    )
    if (!mutation || mutation.type === 'update') {
      throw new Error('expected a tool_call timeline item carrying a full item')
    }
    return mutation
  }

  describe('hooks.json 的顶层结构比 Claude 少一层', () => {
    it('顶层键就是事件名，不套 hooks:——套了整份配置会被判无效', () => {
      // zod：`object({ PreToolUse: array(...).optional(), …, hooksDisabled: boolean().optional() })`。
      // 照 Claude 的形状多包一层 `hooks` 不是"少响几个事件"，是一个都不响（整份配置被 schema 拒掉）。
      const plan = resolveManagedHookPlan('droid', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as Record<string, unknown>
      expect(Object.keys(config).sort()).toEqual([...DROID_HOOK_EVENTS].sort())
      expect(config).not.toHaveProperty('hooks')
    })

    it('每条 hook 条目是 {type:command, command, timeout}，包在事件的数组里', () => {
      const plan = resolveManagedHookPlan('droid', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>
      >
      for (const eventName of DROID_HOOK_EVENTS) {
        const entry = config[eventName]![0]!
        expect(entry.hooks[0]!.type).toBe('command')
        expect(entry.hooks[0]!.command).toContain('agentmux-hook.js')
        expect(entry.hooks[0]!.timeout).toBe(10)
      }
    })

    it('只有两个工具事件带 matcher——别处写 matcher 是噪音', () => {
      const plan = resolveManagedHookPlan('droid', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as Record<
        string, Array<{ matcher?: string }>
      >
      const withMatcher = Object.entries(config)
        .filter(([, entries]) => entries[0]!.matcher !== undefined)
        .map(([eventName]) => eventName)
        .sort()
      expect(withMatcher).toEqual(['PostToolUse', 'PreToolUse'])
    })

    it('合并策略是根层那一支——用 hooks 包装那支会抹掉用户自己的桶', () => {
      // 这条守的是一次真实的数据丢失，不是命名洁癖：`json-managed-events` 去 `hooks` 下找桶，
      // 在这份根层结构的文件里一个都找不到，于是既不清扫、又把我们的根级事件键直接盖在用户同名的
      // 桶上，最后追加一个这个 CLI 不认的 `hooks: {}`。
      //
      // **先验行为、再验策略名**：反过来写的话，策略名那条会先抛，后面几条行为断言就成了死代码——
      // 换错策略时它们一条都跑不到，于是"这份配置具体怎么坏"根本没人守。
      const plan = resolveManagedHookPlan('droid', '/repo/app')
      const mutation = plan!.mutations[0]!
      const existing = JSON.stringify({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/me/audit.sh' }] }],
        hooksDisabled: false
      })
      const merged = JSON.parse(renderMergedHookContent(existing, mutation.content, mutation.merge!))
      expect(merged.PreToolUse[0].hooks[0].command).toBe('/home/me/audit.sh')
      expect(merged.hooksDisabled).toBe(false)
      expect(merged).not.toHaveProperty('hooks')
      expect(merged.Stop[0].hooks[0].command).toContain('agentmux-hook.js')
      expect(mutation.merge).toEqual({ kind: 'json-root-managed-events', marker: 'agentmux-hook.js' })
    })

    it('FACTORY_HOME_OVERRIDE 被尊重——忽略它会写出一份该 CLI 永远不读的配置', () => {
      // 本机发行物逐字：`process.env.FACTORY_HOME_OVERRIDE ?? HOME ?? USERPROFILE`，目录名 `.factory`。
      const overridden = createDroidManagedHookPlan({ FACTORY_HOME_OVERRIDE: '/tmp/fh' })
      expect(overridden.mutations.map((mutation) => mutation.path)).toEqual(['/tmp/fh/.factory/hooks.json'])
    })

    it('装的位置与 workspace 无关——resolver 不该拿 workspacePath 派生路径', () => {
      // 这条守 index.ts 的接线：droid 是 user 层安装，两个不同 workspace 必须解析到同一份文件。
      const a = resolveManagedHookPlan('droid', '/repo/one')
      const b = resolveManagedHookPlan('droid', '/repo/two')
      expect(a!.mutations[0]!.path).toBe(b!.mutations[0]!.path)
      expect(a!.mutations[0]!.path).toContain('/.factory/hooks.json')
    })
  })

  describe('工具调用的两端与正文', () => {
    it('PostToolUse 从 tool_response 读出正文', () => {
      const post = toolMutation(hookIn('run-tool')('PostToolUse', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: '12 passed'
      }))
      expect(post.item.toolOutput).toBe('12 passed')
      expect(post.item.toolName).toBe('Bash')
    })

    it('hook 负载里没有工具关联 id，所以 pre/post 如实退回 append-only', () => {
      // 上游事实：`PostToolUse` 的负载只有 `tool_name`/`tool_input`/`tool_response`，关联 id
      // （`toolCallId`）走的是派发函数的**第四个内部 context 参数**，不进 hook 负载；二进制里的
      // `tool_call_id`/`tool_use_id` 分别属于 LLM 消息格式与 OTEL 属性，不是 hook 负载键。
      //
      // 因此一次调用在时间轴上是两行而不是一行。这条断言把这个已知损失钉住：哪天上游把 id 加进负载，
      // 或有人给这个 Provider 编造一个 id 键，它都会报红。
      const hook = hookIn('run-append')
      const pre = toolMutation(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
      const post = toolMutation(hook('PostToolUse', {
        tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a\nb'
      }))
      expect(post.item.id).not.toBe(pre.item.id)
      // append-only 通路仍带上结果（靠渲染层折叠让带结果的那行胜出）。
      expect(post.item.toolOutput).toBe('a\nb')
      expect(pre.item.toolOutput).toBeUndefined()
    })

    it('PreToolUse/PostToolUse 的 canonical 步骤分别是事前与事后', () => {
      // 这两行是 `startsWith('Post')` 这类形状推理的替代品：结构由表回答，不由拼写猜。
      // 它也是「事后才采集成败与正文」的唯一判据——认错这一步，失败的调用会和成功的长得一样。
      expect(canonicalHookLifecycleEvent('PreToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('PostToolUse')).toBe('tool-use-end')
    })
  })

  describe('收尾只有一种，且没有 SessionEnd', () => {
    it('Stop 判 done、是 turn-end、也是用量落定点', () => {
      const event = hookIn('run-stop')('Stop', {
        stop_hook_active: false, tool_execution_count: 3, elapsed_time: 4200
      })
      expect<AgentSemanticState>(event.semanticState).toBe('done')
      expect(canonicalHookLifecycleEvent('Stop')).toBe('turn-end')
      expect(USAGE_FINALIZATION_EVENTS.has('Stop')).toBe(true)
    })

    it('没有 StopFailure/StopCancelled——别照抄 Claude 与 grok 的多条收尾', () => {
      // zod 枚举里就九个事件，那两个不存在。装一个上游从不发的事件，是在配置里留一条死规则。
      for (const absent of ['StopFailure', 'StopCancelled', 'PostToolUseFailure']) {
        expect(DROID_HOOK_EVENTS).not.toContain(absent)
      }
    })

    it('SessionEnd 既不装也不判 done——会话终结不是轮次事实', () => {
      // 它在上游是真实事件（带 reason/session_duration_ms/message_count），我们刻意不装：判「这一轮
      // 结束」靠 Stop，会话终结由 PTY 事实回答。与 Gemini 对它自己的 SessionEnd 是同一个既定判断。
      // 装了并判 done 会让「一轮结束」和「会话结束」混成一件事。
      expect(DROID_HOOK_EVENTS).not.toContain('SessionEnd')
      expect(canonicalHookLifecycleEvent('SessionEnd')).toBeUndefined()
      expect(hookIn('run-sessionend')('SessionEnd', { reason: 'user_exit' }).semanticState).toBe('unknown')
    })
  })

  describe('子代理只有 stop 没有 start，所以不记账', () => {
    it('不声明 subagentTracking——只装 stop 会让计数变成负数', () => {
      // 事件全集里只有 SubagentStop。在途记账要求 start/stop 成对（花名册加一才能减一）；
      // 只装 stop 还会压制主 Agent 的收尾——它会一直等一个永远等不到的减一。与 Hermes 同一判断。
      expect(DROID_HOOKS.subagentTracking).toBeUndefined()
      expect(DROID_HOOK_EVENTS).not.toContain('SubagentStart')
    })

    it('SubagentStop 判 working，且不压制紧随其后的 Stop', () => {
      const hook = hookIn('run-subagent')
      expect(hook('SubagentStop').semanticState).toBe('working')
      // 没有记账，收尾就该立刻兑现。这条守「不记账」这个决定的实际后果。
      expect(hook('Stop', { stop_hook_active: false }).semanticState).toBe('done')
    })
  })

  describe('压缩与通知：装了才能不被看成卡死', () => {
    it('PreCompact 判 working，且不冒称 canonical 生命周期', () => {
      // 压缩期间 Agent 仍在干活，而这段时间没有任何工具事件——少了它长压缩看起来像卡死。
      // 但它不是结构上的某一步，故不进 canonical 表（与 Claude 的 PreCompact 同一处理）。
      const event = hookIn('run-compact')('PreCompact', { trigger: 'auto', message_count: 40 })
      expect(event.semanticState).toBe('working')
      expect(canonicalHookLifecycleEvent('PreCompact')).toBeUndefined()
    })

    it('Notification 判 working——它不是收尾也不是等待', () => {
      const event = hookIn('run-notify')('Notification', {
        notification_type: 'permission', message: 'needs approval'
      })
      expect(event.semanticState).toBe('working')
    })
  })

  describe('声明与安装必须一致', () => {
    it('rules 引用的每个事件都在安装清单里', () => {
      // 守「两份清单一致」而不是「清单等于某个字面量」：后者只在有人改清单时提醒改测试，
      // 前者才会在有人只改一半时报红。rules 里写了却没装的事件，CLI 压根不触发。
      const referenced = new Set<string>()
      for (const rule of DROID_HOOKS.rules) for (const eventName of rule.events) referenced.add(eventName)
      const tracking = DROID_HOOKS.subagentTracking
      for (const eventName of [
        ...(tracking?.startEvents ?? []), ...(tracking?.stopEvents ?? []), ...(tracking?.mainStopEvents ?? [])
      ]) referenced.add(eventName)
      const installed = new Set<string>(DROID_HOOK_EVENTS)
      expect([...referenced].filter((eventName) => !installed.has(eventName))).toEqual([])
    })

    it('装的每个事件都被某条 rule 判过——装了不判等于白起一个子进程', () => {
      const judged = new Set<string>()
      for (const rule of DROID_HOOKS.rules) for (const eventName of rule.events) judged.add(eventName)
      expect([...DROID_HOOK_EVENTS].filter((eventName) => !judged.has(eventName))).toEqual([])
    })

    it('未装的事件到达时保持可诊断，绝不伪造状态', () => {
      const hook = hookIn('run-unknown')
      for (const eventName of ['SessionEnd', 'SubagentStart', 'PostToolUseFailure']) {
        const event = hook(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.status.detail).toBe(eventName)
      }
    })
  })

  describe('catalog 如实声明它有的和没有的', () => {
    it('native handle 读 snake_case 的 session_id 与 transcript_path', () => {
      const event = hookIn('run-handle')('SessionStart', { source: 'startup' })
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'droid',
        sessionId: 'droid-session-1',
        transcriptPath: '/tmp/droid/transcript.jsonl'
      })
    })

    it('resume 走 --resume，不走 --session-id', () => {
      // `--help` 逐字：`-s, --session-id <id>  Existing session to continue (requires a prompt)`。
      // 它要求同时给 prompt；恢复一个已有会话（可能没有新 prompt）必须走 --resume。
      expect(droid.catalog.resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(droid.catalog.capabilities.providerResume).toBe(true)
      const launch = droid.buildResumeLaunch({
        nativeHandle: {
          kind: 'provider', providerId: 'droid',
          sessionId: 'sess-9', transcriptPath: '/tmp/t.jsonl'
        },
        args: ['--auto', 'low'],
        workspacePath: '/repo/app',
        env: {}
      })
      expect(launch.command).toBe('droid')
      expect(launch.args).toEqual(['--resume', 'sess-9', '--auto', 'low'])
      expect(launch.args).not.toContain('--session-id')
    })

    it('别家的 native handle 恢复不了——两类失败必须可区分', () => {
      // 验收要求「Provider unavailable 与 native handle missing 两类恢复失败可区分」。这里守后者：
      // 拿着别家的 handle 来恢复，错误码必须是 handle 不属于本 Provider，而不是"不支持恢复"。
      expect(() => droid.buildResumeLaunch({
        nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 's-1' },
        args: [], workspacePath: '/repo/app', env: {}
      })).toThrowError(/does not belong to this provider/)
    })

    it('只观察授权，不应答；也不声明 usage', () => {
      // PreToolUse 确实能拦（stdout 回 continue:false，或退出码 2/3 中止），但那要求这个
      // fire-and-forget 的 hook 变成一条阻塞 RPC。那条通路今天不存在。
      expect(droid.catalog.capabilities.permission).toBe('observe')
      // 收尾负载里只有 tool_execution_count/elapsed_time，没有任何 token 字段；transcript 格式未核实。
      expect(droid.catalog.capabilities.usage).toBeUndefined()
      expect(droid.catalog.acpStrategy).toEqual({ kind: 'none' })
    })

    it('prompt 走位置参数，且 resume 时也带得上', () => {
      const ws = { workspacePath: '/repo/app', env: {} }
      expect(droid.buildLaunch({ prompt: 'do it', args: ['--auto', 'low'], ...ws }).args)
        .toEqual(['--auto', 'low', 'do it'])
      expect(droid.buildLaunch({ prompt: '', args: ['--auto', 'low'], ...ws }).args)
        .toEqual(['--auto', 'low'])
      expect(droid.buildResumeLaunch({
        nativeHandle: { kind: 'provider', providerId: 'droid', sessionId: 's-1' },
        prompt: 'keep going', args: [], ...ws
      }).args).toEqual(['--resume', 's-1', 'keep going'])
    })
  })
})

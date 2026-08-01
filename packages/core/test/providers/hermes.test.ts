import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { HERMES_HOOK_EVENTS, HERMES_HOOKS, createHermesManagedHookPlan } from '../../src/providers/hermes.js'
import { canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { USAGE_FINALIZATION_EVENTS } from '../../src/agent-hook-command.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-007 的 Provider 测试。
 *
 * 证据来自**读本机安装的 hermes 0.18.0 源码**（`~/.hermes/hermes-agent/`，editable install）：
 * 事件全集取自 `hermes_cli/plugins.py` 的 `VALID_HOOKS`，wire 协议与每个事件的 `extra` 键取自
 * `agent/shell_hooks.py` 的模块 docstring 与 `_serialize_payload`，`status: 'blocked'` 的语义取自
 * `model_tools.py` 的 `_emit_post_tool_call_hook(status="blocked", error_type="plugin_block", ...)`。
 *
 * 这些断言证明「声明与本机源码读出的合同相符」，**不**证明「跑过一次真实会话」。
 */
describe('Hermes provider', () => {
  const providers = new AgentProviderRegistry()
  const hermes = providers.get('hermes')

  /**
   * 造一条 Hermes 形状的负载。
   *
   * **两层结构是本 task 的关键**：顶层只有五个固定键，事件专属字段全在 `extra` 里
   * （`_serialize_payload`：`extras = {k: v for k, v in kwargs.items() if k not in
   * _TOP_LEVEL_PAYLOAD_KEYS}`）。测试必须照这个形状造，否则会验一个 Hermes 从不发出的负载。
   */
  function hook(eventName: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
    return hermes.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-hermes',
      runId: 'run-hermes',
      providerId: 'hermes',
      eventName,
      payload: {
        hook_event_name: eventName,
        tool_name: null,
        tool_input: null,
        session_id: 'sess-h',
        cwd: '/repo',
        ...top,
        extra
      }
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

  describe('两层 wire 协议：事件专属字段全在 extra 里', () => {
    it('post_tool_call 的成败、正文与关联 id 都从 extra 读出来', () => {
      // 不解包 extra 的后果实测有三条且同时发生：失败被画成成功（status 读不到）、输出全丢
      // （result 读不到）、pre/post 在时间轴上并排两行而不收敛（tool_call_id 读不到，id 退化成
      // 按 receipt 序号编）。这条一次守住三样。
      const failure = toolMutation(hook('post_tool_call', {
        result: 'FAILED 3 tests', status: 'error', error_type: 'CalledProcessError',
        error_message: 'exit 1', duration_ms: 900, tool_call_id: 'tc-5'
      }, { tool_name: 'terminal', tool_input: { command: 'npm test' } }))
      expect(failure.item.status).toBe('failed')
      expect(failure.item.id).toBe('run-hermes:tool:tc-5')
      expect(failure.item.toolOutput).toBe('FAILED 3 tests')
      expect(failure.item.toolName).toBe('terminal')
    })

    it('pre_tool_call 与 post_tool_call 收敛成同一条，而不是并排两行', () => {
      const pre = toolMutation(hook('pre_tool_call',
        { tool_call_id: 'tc-7', turn_id: 't-1' },
        { tool_name: 'terminal', tool_input: { command: 'ls' } }
      ))
      expect(pre.item.status).toBe('streaming')
      const post = toolMutation(hook('post_tool_call',
        { tool_call_id: 'tc-7', status: 'ok', result: 'a\nb' },
        { tool_name: 'terminal', tool_input: { command: 'ls' } }
      ))
      expect(post.item.id).toBe(pre.item.id)
      expect(post.item.status).toBe('complete')
      expect(post.item.toolOutput).toBe('a\nb')
    })

    it("status 'blocked' 本身就足以判失败——不靠同一条负载里的 error_message 兜着", () => {
      // pre_tool_call 拦下一次调用时，Hermes 仍发 post_tool_call，带 status='blocked' +
      // error_type='plugin_block'。判 complete 会把「被挡住」画成「成功」。
      //
      // 这里**刻意不给** error_message：给了它，FAILURE_ONLY_KEYS 会独立把这条判红，于是
      // `blocked` 这半判据从没被验证过——去掉它测试照旧全绿（实测确认过这个假绿）。
      const blocked = toolMutation(hook('post_tool_call', {
        result: 'blocked by hook', status: 'blocked', tool_call_id: 'tc-9'
      }, { tool_name: 'terminal', tool_input: { command: 'rm -rf /' } }))
      expect(blocked.item.status).toBe('failed')
      expect(blocked.item.toolOutput).toBe('blocked by hook')
    })

    it('真实的 blocked 负载（带 error_type/error_message）同样判红并保留正文', () => {
      // 上一条验判据、这一条验真实形状——Hermes 实际发的是带 error_type='plugin_block' 的那份。
      const blocked = toolMutation(hook('post_tool_call', {
        result: 'blocked by hook', status: 'blocked', error_type: 'plugin_block',
        error_message: 'Forbidden command', tool_call_id: 'tc-10'
      }, { tool_name: 'terminal', tool_input: { command: 'rm -rf /' } }))
      expect(blocked.item.status).toBe('failed')
      // 正文优先取 result（工具真正返回的东西），而不是那句 block 理由。
      expect(blocked.item.toolOutput).toBe('blocked by hook')
    })

    it('顶层同名键优先于 extra——顶层是 Hermes 自己声明的固定位', () => {
      const event = toolMutation(hook('post_tool_call',
        { tool_name: 'from-extra', status: 'ok', result: 'x', tool_call_id: 'tc-1' },
        { tool_name: 'from-top', tool_input: {} }
      ))
      expect(event.item.toolName).toBe('from-top')
    })

    it('没有 extra 的负载照旧工作——解包不能要求它必须存在', () => {
      const event = hermes.normalizeHook({
        receiptId: 'r-flat', agentSessionId: 's-hermes', runId: 'run-hermes', providerId: 'hermes',
        eventName: 'post_tool_call',
        payload: { hook_event_name: 'post_tool_call', tool_name: 'terminal', tool_input: {}, status: 'ok' }
      })
      expect(event.semanticState).toBe('working')
    })
  })

  describe('授权门的两端：本 task 的核心 parity', () => {
    it('pre_approval_request 判 waiting——不论用户在 TUI 还是 IM 上决定', () => {
      // 本机源码逐字："fires BOTH for CLI-interactive prompts and for gateway/ACP approvals"。
      // 判 working 会让「等我点一下」和「正在干活」在界面上长得一模一样。
      const event = hook('pre_approval_request', {
        command: 'rm -rf build', description: 'Delete build output',
        pattern_key: 'rm', pattern_keys: ['rm'], session_key: 'sk-1', surface: 'cli'
      })
      expect<AgentSemanticState>(event.semanticState).toBe('waiting')
    })

    it('post_approval_response 让 Agent 从等待里出来——五种 choice 都是「决定已给」', () => {
      // deny 与 timeout 同样是「不再等了」。少了这条，一次拒绝之后 Agent 会永远显示在等授权。
      for (const choice of ['once', 'session', 'always', 'deny', 'timeout']) {
        const event = hook('post_approval_response', {
          command: 'rm -rf build', description: 'd', pattern_key: 'rm', pattern_keys: ['rm'],
          session_key: 'sk-1', surface: 'gateway', choice
        })
        expect(event.semanticState).toBe('working')
      }
    })

    it('两个 approval 事件真的被装进了两份文件，而不只是 rules 里认得', () => {
      // 上面两条行为断言直接调 normalizeHook，绕过了「这个事件会不会到达」。撤掉安装后它们照旧
      // 全绿（实测确认过）——所以必须单独钉住接线：config.yaml 让 Hermes 触发它，allowlist 让这次
      // 触发不卡在同意提示上。少任何一份，上面验的行为在产品里永远走不到。
      const plan = resolveManagedHookPlan('hermes', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ command: string }>>
      }
      const allowlist = JSON.parse(plan!.mutations[1]!.content) as {
        approvals: Array<{ event: string }>
      }
      for (const eventName of ['pre_approval_request', 'post_approval_response']) {
        expect(config.hooks[eventName]?.[0]?.command).toContain('agentmux-hook.js')
        expect(allowlist.approvals.some((entry) => entry.event === eventName)).toBe(true)
      }
    })

    it('两个 approval 事件刻意不进 canonical 生命周期表', () => {
      // 它们是授权门而非工具事前/事后：同一条危险命令会先过门、再走 pre_tool_call，
      // 都算 tool-use-start 会让一次执行落两条。与 Cursor 的 beforeShellExecution 同一个判断。
      expect(canonicalHookLifecycleEvent('pre_approval_request')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('post_approval_response')).toBeUndefined()
    })
  })

  describe('会话收尾与子代理', () => {
    it('on_session_end 与 post_llm_call 都判 done，且都是用量落定点', () => {
      for (const eventName of ['post_llm_call', 'on_session_end']) {
        expect(hook(eventName, { completed: true, interrupted: false }).semanticState).toBe('done')
        expect(canonicalHookLifecycleEvent(eventName)).toBe('turn-end')
        expect(USAGE_FINALIZATION_EVENTS.has(eventName)).toBe(true)
      }
    })

    it('subagent_stop 判 working——主 Agent 还在干活，且不冒称按 id 记账', () => {
      const event = hook('subagent_stop', {
        parent_turn_id: 't-1', child_session_id: 'child-1', child_role: 'reviewer',
        child_summary: 'looked at 3 files', child_status: 'success', duration_ms: 4200
      })
      expect(event.semanticState).toBe('working')
      // canonical 层答的是「这是结构上的哪一步」，与哪家有记账无关——`subagent_stop` 这个名字已由
      // grok 的方言块贡献（同名同结构，合并表允许重复），所以它有 canonical 值。
      expect(canonicalHookLifecycleEvent('subagent_stop')).toBe('subagent-stop')
      expect(event.lifecycleEvent).toBe('subagent-stop')
      // 真正该守的是**记账层**：Hermes 侧的 `subagent_start` 的 id 键未被证据佐证，故这个 Provider
      // 不声明 subagentTracking。少了 start，花名册永不加一，只装 stop 会让计数变成负数。
      expect(HERMES_HOOKS.subagentTracking).toBeUndefined()
      expect(HERMES_HOOK_EVENTS).not.toContain('subagent_start')
      // 没有记账，收尾就不该被压制：主 Agent 报 done 时立刻兑现，而不是等一个永远等不到的减一。
      expect(hook('on_session_end', { completed: true }).semanticState).toBe('done')
    })

    it('未装的事件到达时保持可诊断，绝不伪造状态', () => {
      for (const eventName of ['transform_llm_output', 'pre_verify', 'kanban_task_claimed', 'subagent_start']) {
        const event = hook(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.status.detail).toBe(eventName)
      }
    })
  })

  describe('声明与安装必须一致', () => {
    it('rules 引用的每个事件都在安装清单里', () => {
      const referenced = new Set<string>()
      for (const rule of HERMES_HOOKS.rules) for (const eventName of rule.events) referenced.add(eventName)
      const declaredButNotInstalled = [...referenced].filter(
        (eventName) => !(HERMES_HOOK_EVENTS as readonly string[]).includes(eventName)
      )
      expect(declaredButNotInstalled).toEqual([])
    })

    it('两个 mutation 的事件集都恰好等于声明的清单', () => {
      // config.yaml 装事件，allowlist 授权同一批 (event, command) 对。两份少任何一边，
      // 事件要么不触发、要么触发时卡在一个交互式同意提示上（非 TTY 下直接注册失败）。
      const plan = resolveManagedHookPlan('hermes', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as { hooks: Record<string, unknown> }
      expect(Object.keys(config.hooks).sort()).toEqual([...HERMES_HOOK_EVENTS].sort())
      const allowlist = JSON.parse(plan!.mutations[1]!.content) as {
        approvals: Array<{ event: string; command: string }>
      }
      expect(allowlist.approvals.map((entry) => entry.event).sort()).toEqual([...HERMES_HOOK_EVENTS].sort())
      // 同意记录按 (event, command) 对匹配，所以两边的 command 必须逐字相同。
      const configCommands = new Set(
        Object.values(config.hooks as Record<string, Array<{ command: string }>>)
          .map((entries) => entries[0]!.command)
      )
      expect(configCommands.size).toBe(1)
      expect(new Set(allowlist.approvals.map((entry) => entry.command))).toEqual(configCommands)
    })

    it('不装那些会改写内容或跑在别的进程里的事件', () => {
      for (const excluded of [
        'transform_terminal_output', 'transform_tool_result', 'transform_llm_output',
        'pre_verify', 'pre_gateway_dispatch', 'kanban_task_claimed', 'pre_api_request'
      ]) {
        expect(HERMES_HOOK_EVENTS).not.toContain(excluded)
      }
    })

    it('HERMES_HOME 覆盖被尊重——忽略它会写出一份 Hermes 永远不读的配置', () => {
      const overridden = createHermesManagedHookPlan({ HERMES_HOME: '/tmp/hh' })
      expect(overridden.mutations.map((mutation) => mutation.path))
        .toEqual(['/tmp/hh/config.yaml', '/tmp/hh/shell-hooks-allowlist.json'])
    })
  })

  describe('catalog 如实声明它没有的东西', () => {
    it('没有 native resume，也不声明 usage', () => {
      // 本机 `hermes chat --help` 里没有任何恢复旗标。
      expect(hermes.catalog.resumeStrategy).toEqual({ kind: 'none' })
      expect(hermes.catalog.capabilities.providerResume).toBe(false)
      // approval 事件是 observers only（Hermes 明说返回值被忽略），故只观察不应答。
      expect(hermes.catalog.capabilities.permission).toBe('observe')
      expect(hermes.catalog.capabilities.usage).toBeUndefined()
    })
  })
})

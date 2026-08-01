import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { GEMINI_HOOK_EVENTS, createGeminiManagedHookPlan } from '../../src/providers/gemini.js'
import { createAntigravityManagedHookPlan } from '../../src/providers/antigravity.js'
import { GEMINI_HOOK_DIALECT, canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { renderMergedHookContent } from '../../src/hook-config-merge.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-004 的 Provider 测试。
 *
 * Gemini 有一处特殊：本机这份 CLI **已无法认证**（`--list-sessions` 报
 * `IneligibleTierError: This client is no longer supported`，官方指向 Antigravity），所以
 * 端到端的真实会话恢复无法在本机跑通。证据因此来自**读实现**——`npm pack
 * @google/gemini-cli@0.57.0` 后在 bundle 里读 `findSession`/`resolveSession`/`createBaseInput`/
 * `processHooksConfiguration`，并核对本机 0.55.1 逐字一致。见
 * docs/reviews/agentmux-provider-cli-evidence.md 的 Gemini 小节。
 *
 * 这些断言证明的是「声明与合同相符」，**不**证明「做过一次真实恢复」——后者本机做不到，不冒充。
 */
describe('Gemini provider', () => {
  const providers = new AgentProviderRegistry()
  const gemini = providers.get('gemini')

  /** 造一条 Gemini 形状的 hook 信封：事件名 PascalCase，负载键 Claude 同族的 snake_case。 */
  function hook(eventName: string, payload: Record<string, unknown> = {}) {
    return gemini.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-gemini',
      runId: 'run-gemini',
      providerId: 'gemini',
      payload: {
        hook_event_name: eventName,
        session_id: 'gem-session-1',
        transcript_path: '/tmp/chats/session.json',
        ...payload
      }
    })
  }

  describe('能力声明与实现读出的合同相符', () => {
    it('不再是 terminal-only：Hook 与 native resume 都按实现声明', () => {
      const { capabilities, hookStrategy, resumeStrategy } = gemini.catalog
      expect(hookStrategy).toEqual({ kind: 'native', installation: 'explicit-managed' })
      expect(capabilities.hookEvents).toBe(true)
      expect(capabilities.timeline).toBe('complete-events')
      // findSession 是 UUID 优先，所以 locator 是 session-id 而不是位置性的序号。
      expect(resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(capabilities.providerResume).toBe(true)
      expect(capabilities.permission).toBe('observe')
      // `--acp` 在 CLI 上真实存在，但 AgentMux 侧没接，故如实声明未支持——这条守「宁缺毋滥」。
      expect(gemini.catalog.acpStrategy).toEqual({ kind: 'none' })
      expect(capabilities.acp).toBe(false)
      // transcript_path 拿得到，但那份 transcript 是整文件 JSON，两个既有 reader 都读不了，
      // 所以 usage 保持未声明。声明了就等于承诺能抽 token。
      expect(capabilities.usage).toBeUndefined()
    })
  })

  describe('事件名是 Gemini 自己的，负载键才与 Claude 同族', () => {
    it('装的清单与方言一一对应，且用的是 BeforeTool 而非 Claude 的 PreToolUse', () => {
      expect([...GEMINI_HOOK_EVENTS].sort()).toEqual(Object.keys(GEMINI_HOOK_DIALECT).sort())
      // 最容易犯的错：把 Claude 的事件名照抄过来。Gemini 压根不发这些。
      for (const claudeOnly of ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']) {
        expect(GEMINI_HOOK_EVENTS).not.toContain(claudeOnly)
      }
      expect(canonicalHookLifecycleEvent('BeforeTool')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('AfterTool')).toBe('tool-use-end')
    })

    it('snake_case 负载键真的被读出来：状态、时间轴、native handle 三处都要成立', () => {
      const event = hook('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } })
      expect(event.lifecycleEvent).toBe('tool-use-start')
      expect(event.semanticState).toBe('working')
      expect(event.timeline.length).toBeGreaterThan(0)
      // session_id 与 transcript_path 都进 handle——transcript 路径是 resume 之外的另一半事实。
      expect(hook('SessionStart').nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'gemini',
        sessionId: 'gem-session-1',
        transcriptPath: '/tmp/chats/session.json'
      })
    })

    it('工具失败与成功在时间轴上分得开（tool_response 是 Claude 拼法）', () => {
      const call = { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } }
      const failed = gemini.normalizeHook({
        receiptId: 'r-fail', agentSessionId: 's-gemini', runId: 'run-gemini', providerId: 'gemini',
        payload: { hook_event_name: 'AfterTool', session_id: 'g', ...call, tool_response: { output: 'boom', is_error: true } }
      })
      const failedItem = failed.timeline.find((m) => m.type !== 'update' && m.item.kind === 'tool_call')
      expect(failedItem && failedItem.type !== 'update' && failedItem.item.status).toBe('failed')

      const ok = gemini.normalizeHook({
        receiptId: 'r-ok', agentSessionId: 's-gemini', runId: 'run-gemini', providerId: 'gemini',
        payload: { hook_event_name: 'AfterTool', session_id: 'g', ...call, tool_response: { output: 'fine' } }
      })
      const okItem = ok.timeline.find((m) => m.type !== 'update' && m.item.kind === 'tool_call')
      expect(okItem && okItem.type !== 'update' && okItem.item.status).toBe('complete')
    })
  })

  describe('AfterAgent 是一轮收尾，不是会话收尾', () => {
    it('AfterAgent 判 done 并归入 turn-end', () => {
      const event = hook('AfterAgent', { prompt: 'hi', prompt_response: 'done', stop_hook_active: false })
      expect<AgentSemanticState>(event.semanticState).toBe('done')
      expect(event.lifecycleEvent).toBe('turn-end')
    })

    it('SessionEnd 既不装也不映射——会话终结是 PTY 事实，不是轮次事实', () => {
      // 这条守边界：拿 SessionEnd 当 done 会把「一轮结束」和「会话结束」混成一件事，
      // 而后者的所有权在 ctxmux 的进程事实那边。
      expect(GEMINI_HOOK_EVENTS).not.toContain('SessionEnd')
      expect(canonicalHookLifecycleEvent('SessionEnd')).toBeUndefined()
      // 未装的高频事件也不该被误判成生命周期（AfterModel 是一次模型往返的收尾，不是工具结果）。
      expect(canonicalHookLifecycleEvent('AfterModel')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('BeforeToolSelection')).toBeUndefined()
    })

    it('未知事件保持可诊断，绝不伪造状态', () => {
      const event = hook('QuantumFlux')
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
      expect(event.status.detail).toBe('QuantumFlux')
    })
  })

  describe('装到 settings.json，且不碰 Antigravity 在同一目录下的配置', () => {
    const plan = resolveManagedHookPlan('gemini', '/repo')

    it('写的是 ~/.gemini/settings.json，与 Antigravity 的 config/hooks.json 是不同文件', () => {
      expect(plan?.mutations).toHaveLength(1)
      const target = plan!.mutations[0]!.path
      expect(target.endsWith('/.gemini/settings.json')).toBe(true)
      // 关键的邻接风险：两个 Provider 同住 ~/.gemini。路径必须真的不同，否则装 Gemini 会改掉
      // 用户 Antigravity 的行为。这里直接拿两个 plan 对比，而不是只断言字符串长相。
      const antigravity = createAntigravityManagedHookPlan()
      expect(antigravity.mutations[0]!.path).not.toBe(target)
      expect(antigravity.mutations[0]!.path).toContain('/.gemini/config/hooks.json')
    })

    it('装的事件恰好是声明的那些，matcher 只出现在工具类事件上', () => {
      const written = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string }>>
      }
      expect(Object.keys(written.hooks).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort())
      for (const [eventName, definitions] of Object.entries(written.hooks)) {
        expect(Object.hasOwn(definitions[0]!, 'matcher')).toBe(eventName.endsWith('Tool'))
      }
    })

    it('合并保留用户的 security/mcpServers 与 foreign hook 定义', () => {
      // settings.json 是用户主配置（本机实测同时含 security 与 mcpServers）。整文件覆盖会毁掉它，
      // 所以这条断言的是真实合并结果，而不只是 merge 策略的名字。
      const existing = JSON.stringify({
        security: { folderTrust: { enabled: true } },
        mcpServers: { linear: { command: 'linear-mcp' } },
        hooks: {
          AfterAgent: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-own-notify.sh' }] }],
          PreCompress: [{ hooks: [{ type: 'command', command: '/usr/local/bin/archive.sh' }] }]
        }
      })
      const merged = JSON.parse(renderMergedHookContent(
        existing,
        plan!.mutations[0]!.content,
        plan!.mutations[0]!.merge!
      )) as Record<string, any>

      expect(merged.security).toEqual({ folderTrust: { enabled: true } })
      expect(merged.mcpServers).toEqual({ linear: { command: 'linear-mcp' } })
      // 用户自己在同一事件上的 hook 必须留着，且排在我们前面。
      const afterAgent = merged.hooks.AfterAgent as Array<{ hooks: Array<{ command: string }> }>
      expect(afterAgent[0]!.hooks[0]!.command).toBe('/usr/local/bin/my-own-notify.sh')
      expect(afterAgent.some((d) => d.hooks.some((h) => h.command.includes('agentmux-hook.js')))).toBe(true)
      // 我们没接的事件桶原样保留。
      expect(merged.hooks.PreCompress[0].hooks[0].command).toBe('/usr/local/bin/archive.sh')
    })

    it('重装不累积：自有条目按 marker 清扫后只剩一份', () => {
      const once = renderMergedHookContent(null, plan!.mutations[0]!.content, plan!.mutations[0]!.merge!)
      const twice = renderMergedHookContent(once, plan!.mutations[0]!.content, plan!.mutations[0]!.merge!)
      expect(twice).toBe(once)
    })
  })

  describe('resume argv 精确，缺 handle 时 fail closed', () => {
    it('argv 恰为 gemini --resume <session-id>，prompt 走 --prompt-interactive', () => {
      expect(gemini.buildResumeLaunch({
        workspacePath: '/repo',
        nativeHandle: { kind: 'provider', providerId: 'gemini', sessionId: 'uuid-abc' },
        prompt: 'continue now',
        args: ['--approval-mode', 'plan'],
        env: {}
      })).toEqual({
        command: 'gemini',
        args: ['--resume', 'uuid-abc', '--prompt-interactive', 'continue now', '--approval-mode', 'plan'],
        env: {}
      })
    })

    it('handle 属于别家时拒绝，并说清卡在哪且不泄露会话 id', () => {
      let error: AgentMuxError | undefined
      try {
        gemini.buildResumeLaunch({
          workspacePath: '/repo',
          nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'not-gemini' },
          args: [], env: {}
        })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(error?.detail).toContain('expectedProviderId=gemini')
      expect(error?.detail).not.toContain('not-gemini')
    })

    it('home 可注入，便于在测试里不碰真实 home', () => {
      expect(createGeminiManagedHookPlan('/tmp/fake-home').mutations[0]!.path)
        .toBe('/tmp/fake-home/.gemini/settings.json')
    })
  })
})

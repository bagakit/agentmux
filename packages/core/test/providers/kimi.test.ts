import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { KIMI_HOOK_EVENTS, KIMI_HOOKS } from '../../src/providers/kimi.js'
import { canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-016 的 Provider 测试。
 *
 * 证据来自**读第一方源码** `~/proj/github/kimi-cli`（`1.49.0`），主要是
 * `src/kimi_cli/hooks/{config,events}.py`、`src/kimi_cli/cli/__init__.py`、
 * `src/kimi_cli/ui/shell/__init__.py` 与它自带的 `docs/en/`。见
 * docs/reviews/agentmux-provider-cli-evidence.md 的《T-009…T-016 的证据面盘查》。
 *
 * 这些断言证明「声明与源码里读出的合同相符」，**不**证明「跑过一次真实的 Kimi 会话」——
 * 本机没装这个 CLI（`command -v kimi` 失败），不冒充。
 */
describe('Kimi provider', () => {
  const providers = new AgentProviderRegistry()
  const kimi = providers.get('kimi')

  /**
   * 造一条 Kimi 形状的信封：事件名 PascalCase 走 `hook_event_name`，负载键 snake_case。
   *
   * `runId` **必须**逐个用例区分：子代理花名册是 normalizer 里按 runId 索引的模块级可变状态
   * （hook-normalizer.ts:76），共用一个 runId 会让某个用例记下的在途子代理压住另一个用例的 Stop。
   */
  function hookIn(runId: string) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      kimi.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-kimi',
        runId,
        providerId: 'kimi',
        eventName,
        payload: { hook_event_name: eventName, session_id: 'kimi-session-1', cwd: '/tmp/w', ...payload }
      })
  }

  describe('进程名不是可执行文件名——这条错了会让「就绪」永远等不到', () => {
    it('expectedProcess 是 CLI 自己改成的进程名，不是 executable', () => {
      // cli/__init__.py:373 调 init_process_name("Kimi Code")，proctitle.py 走 setproctitle，
      // 且 setproctitle 是硬依赖（pyproject.toml:38）。readySignal 按 expectedProcess 比对，
      // 写成 'kimi' 就永远匹配不上。这两个字段**必须不同**，相等即回归。
      expect(kimi.catalog.executable).toBe('kimi')
      expect(kimi.catalog.expectedProcess).toBe('Kimi Code')
      expect(kimi.catalog.expectedProcess).not.toBe(kimi.catalog.executable)
      // readySignal 由 catalog() 从 expectedProcess 派生，两者不许 drift。
      expect(kimi.catalog.readySignal).toEqual({
        kind: 'foreground-process',
        expectedProcess: 'Kimi Code'
      })
    })
  })

  describe('首个 prompt 不进 argv——进了会让会话跑完一条就退出', () => {
    it('launch 的 argv 里没有 prompt，只有解析出的旗标', () => {
      // ui/shell/__init__.py:391-399：shell UI 拿到 command 就 "run single command and exit"。
      // 所以 prompt 绝不能进 argv，否则每个 Agent 会话都会在第一条之后消失。
      // 断言整个 plan 而非 args 片段：命令名写错、env 被污染同样该红。
      expect(kimi.buildLaunch({
        workspacePath: '/repo', prompt: 'review this', args: ['--foo'], env: {}
      })).toEqual({ command: 'kimi', args: ['--foo'], env: {} })
      // 反面：prompt 非空且 args 为空时 argv 必须仍是空的——这条才真正钉住"prompt 不进 argv"。
      expect(kimi.buildLaunch({
        workspacePath: '/repo', prompt: 'review this', args: [], env: {}
      }).args).toEqual([])
    })

    it('prompt 改由 PTY 键入，且多行走 bracketed paste', () => {
      expect(kimi.planPromptInput('hello')).toEqual({ kind: 'single-phase', data: 'hello\r' })
    })
  })

  describe('能力按源码读出的合同声明', () => {
    it('Hook 与 native resume 都声明，acp/usage 保持未声明', () => {
      const { capabilities, hookStrategy, resumeStrategy, acpStrategy } = kimi.catalog
      // unmanaged 而非 explicit-managed：配置面是 config.toml（TOML），本仓四种 merge 策略
      // 没有一种能编辑 TOML，且那是用户主配置。声明成 managed 就是「声明装了实际没装」。
      expect(hookStrategy).toEqual({ kind: 'native', installation: 'unmanaged' })
      expect(capabilities.hookEvents).toBe(true)
      expect(capabilities.timeline).toBe('complete-events')
      expect(resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(capabilities.providerResume).toBe(true)
      // hook 引擎 fail-open（runner.py:30,44-55），本就当不了安全边界，故只观察。
      expect(capabilities.permission).toBe('observe')
      // ACP 真实存在（`kimi acp` + agent-client-protocol 硬依赖），但 AgentMux 侧未接。
      expect(acpStrategy).toEqual({ kind: 'none' })
      expect(capabilities.acp).toBe(false)
      expect(capabilities.replyCorrelation).toBe('none')
      // 收尾负载（events.py:73-96）里没有任何 token 字段，也不报 transcript 路径。
      expect(capabilities.usage).toBeUndefined()
    })

    it('unmanaged 意味着 Core 不为它解析任何安装计划', () => {
      // 这条是上面 unmanaged 声明的**行为**面：只断言字段相等，改成 explicit-managed 后
      // 字段断言会红，但「到底会不会去装」没人守。
      expect(resolveManagedHookPlan('kimi', '/tmp/agentmux-kimi', {})).toBeNull()
    })
  })

  describe('事件名与 Claude 一族逐字同形，故复用既有方言', () => {
    it('九个声明的事件名都能被 canonical 层认出来', () => {
      // 若哪天有人把 KIMI_HOOK_EVENTS 写成 snake_case（照抄 grok 的拼法），这条会红。
      const canonical = KIMI_HOOK_EVENTS.map((name) => [name, canonicalHookLifecycleEvent(name)])
      expect(canonical).toEqual([
        ['SessionStart', 'session-start'],
        ['UserPromptSubmit', 'user-prompt-submit'],
        ['PreToolUse', 'tool-use-start'],
        ['PostToolUse', 'tool-use-end'],
        ['PostToolUseFailure', 'tool-use-end'],
        ['SubagentStart', 'subagent-start'],
        ['SubagentStop', 'subagent-stop'],
        ['Stop', 'turn-end'],
        ['StopFailure', 'turn-end']
      ])
    })
  })

  describe('两种收尾都算 done，缺一条就卡在 working', () => {
    it.each(['Stop', 'StopFailure'])('%s 收尾', (eventName) => {
      const event = hookIn(`run-stop-${eventName}`)(eventName)
      expect<AgentSemanticState>(event.semanticState).toBe('done')
      expect(event.lifecycleEvent).toBe('turn-end')
    })

    it('工作中的事件不误报 done', () => {
      const hook = hookIn('run-working')
      for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
        expect(hook(eventName).semanticState).toBe('working')
      }
    })

    it('失败收尾也是收尾：PostToolUseFailure 只是工具失败，不是这一轮结束', () => {
      // 两个"Failure"分属不同层：工具那次失败了，回合还在继续。混为一谈会让 Agent 提前显示完成。
      const hook = hookIn('run-tool-failure')
      expect(hook('PostToolUseFailure').semanticState).toBe('working')
      expect(hook('StopFailure').semanticState).toBe('done')
    })

    it('未声明的事件保持可诊断，绝不伪造状态', () => {
      // Kimi 另有 SessionEnd/PreCompact/PostCompact/Notification（config.py:5-19）本 Provider 不列。
      // 它们必须落在 unknown 而不是被猜成 working/done。
      const event = hookIn('run-unknown')('PreCompact')
      expect(event.semanticState).toBe('unknown')
      expect(event.eventName).toBe('PreCompact')
    })
  })

  describe('native handle 只认 session_id，不认 transcript 路径', () => {
    it('从 snake_case 负载里取出 session id', () => {
      expect(hookIn('run-handle')('Stop').nativeHandle).toMatchObject({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
    })

    it('不声明 transcriptPathKeys，故不要求也不产出 transcript 路径', () => {
      expect(KIMI_HOOKS.nativeHandle?.transcriptPathKeys).toBeUndefined()
      expect(KIMI_HOOKS.nativeHandle?.requireTranscriptPath).toBeFalsy()
      // 反面：没有 transcript 路径时 resume 仍必须成立（与 pi 相反）。断言整个 plan：
      // 旗标拼错、prompt 混进 argv、多带一个参数都该红。
      expect(kimi.buildResumeLaunch({
        workspacePath: '/tmp/agentmux-kimi',
        nativeHandle: { kind: 'provider', providerId: 'kimi', sessionId: 'kimi-session-1' },
        prompt: 'keep going',
        args: ['--foo'],
        env: {}
      })).toEqual({
        command: 'kimi',
        args: ['--session', 'kimi-session-1', '--foo'],
        env: {}
      })
    })

    it('别家的 handle 不许拿来恢复，且要说清卡在哪、不泄露会话 id', () => {
      // 只断言"抛了"远不够：这个码此前同时承载两种相反的失败（handle 属于别家 / 缺 transcript
      // 路径），而两者该做的事相反。分类与细节都得对上，否则界面只能笼统说一句恢复不了。
      let error: AgentMuxError | undefined
      try {
        kimi.buildResumeLaunch({
          workspacePath: '/tmp/agentmux-kimi',
          nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'not-kimi' },
          args: [],
          env: {}
        })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(error?.detail).toContain('expectedProviderId=kimi')
      // 会话 id 是用户内容，绝不进错误细节。
      expect(error?.detail).not.toContain('not-kimi')
    })
  })

  describe('子代理按名字记账——因为负载里根本没有 id', () => {
    it('idKeys 只有 agent_name', () => {
      // events.py:117-142：SubagentStart/Stop 都只带 agent_name + prompt/response，无任何 id 键。
      // 声明 subagentType/agentId 之类（照抄 grok）会让记账永远匹配不上。
      expect(KIMI_HOOKS.subagentTracking).toEqual({
        startEvents: ['SubagentStart'],
        stopEvents: ['SubagentStop'],
        mainStopEvents: ['Stop', 'StopFailure'],
        idKeys: ['agent_name']
      })
    })

    it.each(['Stop', 'StopFailure'])('子代理在途时压住主 %s，落地后才兑现 done', (mainStop) => {
      // 这条才是 idKeys 的**行为**面：normalizer 只按 idKeys 取到的 id 记账
      // （hook-normalizer.ts:117-126），键名写错就一个子代理都记不下，于是主 Stop 直接放行——
      // 上面那条 toEqual 会红，但"到底压不压得住"要靠这里守。
      //
      // 两个收尾各跑一遍：mainStopEvents 是**两条**，只测 Stop 会让漏掉 StopFailure 的实现全绿，
      // 而那个洞的后果最重——失败收尾时子代理还在跑，mainStopPending 没被置上，等最后一个
      // SubagentStop 落地时它只会返回 working，这个 Agent 就永久停在运行中，再没有事件能救回来。
      const hook = hookIn(`run-subagent-${mainStop}`)
      expect(hook('SubagentStart', { agent_name: 'reviewer' }).semanticState).toBe('working')
      // 主 Agent 说收尾了，但子代理还在跑——必须压住，否则界面提前翻完成、还会误发完成通知。
      expect(hook(mainStop).semanticState).toBe('working')
      expect(hook('SubagentStop', { agent_name: 'reviewer' }).semanticState).toBe('done')
    })

    it.each(['Stop', 'StopFailure'])('没有在途子代理时主 %s 不被压住', (mainStop) => {
      // 反面，防止上一条被"永远返回 working"的实现骗过。
      expect(hookIn(`run-no-subagent-${mainStop}`)(mainStop).semanticState).toBe('done')
    })
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AgentProviderRegistry, splitLaunchPromptByDelivery } from '../../src/agent-provider.js'
import { composeAgentLaunchPrompt } from '../../src/agent-outbound-message.js'
import { KIMI_HOOKS } from '../../src/providers/kimi.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/** Contract fixtures follow the pinned MoonshotAI/kimi-code TypeScript 2.1.1 source.
 * Hook payloads, veto semantics and CLI arguments are verified from that source;
 * these tests do not certify a real CLI session or its foreground process name.
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
      }, {})
  }

  describe('可执行文件名与预期进程名一致——无改名证据时不按品牌名猜测', () => {
    it('expectedProcess 保持成熟可执行名 kimi，不预设 Kimi Code 品牌改名', () => {
      // 第一方 TS 2.1.1 (apps/kimi-code) 并无 setproctitle / proctitle 依据；
      // bin 为 kimi (dist/main.mjs)，故 expectedProcess 保持原成熟可执行名 kimi。
      expect(kimi.catalog.executable).toBe('kimi')
      expect(kimi.catalog.expectedProcess).toBe('kimi')
      expect(kimi.catalog.readySignal).toEqual({
        kind: 'foreground-process',
        expectedProcess: 'kimi'
      })
    })
  })

  describe('首个 prompt 送不到，于是当场拒绝——绝不静静吞掉用户的原话', () => {
    it('声明为 post-launch-only，而不是「声明 argv 再丢掉」', () => {
      // 这条轴是"送得到吗"的唯一事实来源。改回 positional-argv 会让下面那条拒绝断言失效，
      // 于是 prompt 重新被静静丢弃——所以这个取值本身要钉住。
      expect(kimi.catalog.promptDelivery).toBe('post-launch-only')
    })

    it('带 prompt 启动被拒，且说清是哪个 Provider、不泄露原话', () => {
      // 这是本次修复的核心：此前 buildArgs 把 prompt 丢掉且**测试把丢掉钉成了正确行为**，
      // 于是用户的原话只落进 timeline、永不进入 Kimi 进程，界面上却一切正常。
      let error: AgentMuxError | undefined
      try {
        kimi.buildLaunch({ workspacePath: '/repo', prompt: 'review this', args: ['--foo'], env: {} })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('AGENT_LAUNCH_PROMPT_UNSUPPORTED')
      expect(error?.detail).toContain('providerId=kimi')
      expect(error?.detail).toContain('promptDelivery=post-launch-only')
      // prompt 是用户内容：只报长度，正文绝不进错误细节。
      expect(error?.detail).toContain('promptLength=11')
      expect(error?.detail).not.toContain('review this')
    })

    it('恢复路径判得一样——两条路给不同答案就是下一个只在一条路上出现的丢失', () => {
      let error: AgentMuxError | undefined
      try {
        kimi.buildResumeLaunch({
          workspacePath: '/repo',
          nativeHandle: { kind: 'provider', providerId: 'kimi', sessionId: 'kimi-session-1' },
          prompt: 'keep going',
          args: [],
          env: {}
        })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('AGENT_LAUNCH_PROMPT_UNSUPPORTED')
      expect(error?.detail).not.toContain('keep going')
    })

    it('不带 prompt 启动照常可用：Kimi 空手起来完全能跑', () => {
      // 拒绝只针对"带 prompt 启动"这一件事。空 prompt 必须照常启动，否则这个 Provider
      // 就整个不可用了——而 launchPrompt 在注入运行时引导时几乎总是非空，所以这条很重要：
      // 它钉住"拒绝的边界是 prompt 而不是启动本身"。
      expect(kimi.buildLaunch({
        workspacePath: '/repo', prompt: '', args: ['--foo'], env: {}
      })).toEqual({ command: 'kimi', args: ['--foo'], env: {} })
      // 只有空白也算空——不该因为一个空格就拒绝启动。
      expect(kimi.buildLaunch({
        workspacePath: '/repo', prompt: '   ', args: [], env: {}
      })).toEqual({ command: 'kimi', args: [], env: {} })
    })

    it('默认配置（运行时引导开着）真的能起来——组装出的启动 prompt 不许交给它', () => {
      // 这条守的是本轮**我自己制造过的**回归：起初的分流写成「按 composed prompt 判，非空就拒」，
      // 而 injectAgentMuxGuide 默认为真、composeAgentLaunchPrompt 因此几乎总是非空（实测 528 字符），
      // 于是每一次默认启动都抛 AGENT_LAUNCH_PROMPT_UNSUPPORTED——把一次静默丢失换成了一个根本
      // 起不来的 Provider。而当时的用例用手写的 `prompt: ''` 绕过了组装器，所以全绿。
      //
      // 所以这里必须走**真的组装器**：先确认它非空（否则下面在对空串取胜），再确认分流把它整份
      // 划给 deferred、启动侧拿到空串，且这个空串真的能起来。
      const composed = composeAgentLaunchPrompt('review this', true)
      expect(composed.length).toBeGreaterThan(100)
      const split = splitLaunchPromptByDelivery(kimi.catalog, composed)
      expect(split.atLaunch).toBe('')
      // 补送的那一半必须是**整份**原文，一个字节都不许丢——包括用户原话和运行时引导。
      expect(split.deferred).toBe(composed)
      expect(split.deferred).toContain('review this')
      expect(kimi.buildLaunch({
        workspacePath: '/repo', prompt: split.atLaunch, args: ['--foo'], env: {}
      })).toEqual({ command: 'kimi', args: ['--foo'], env: {} })
    })

    it('送得到的 Provider 分流后整份随启动走，没有要补送的', () => {
      // 反面锚点。没有它，把 splitLaunchPromptByDelivery 写成「永远划给 deferred」会全绿，
      // 而那会让另外十个 Provider 的启动 prompt 全部退化成起来之后再键入。
      const composed = composeAgentLaunchPrompt('review this', true)
      expect(splitLaunchPromptByDelivery(providers.get('claude').catalog, composed))
        .toEqual({ atLaunch: composed, deferred: '' })
    })

    it('起来之后提交 prompt 走默认 single-phase，这才是 Kimi 真正的送达路径', () => {
      // **不是** bracketed paste：Kimi 没有声明 planPromptInput，于是继承 agent-provider.ts
      // 的默认实现——原样加一个回车。全仓只有 codex 声明了 render-then-submit 的 bracketed paste
      // 形态，claude / cursor / grok / gemini 与 Kimi 一样走这条默认路。
      //
      // 这条路对 Kimi 是通的（single-phase 不要求 composer readiness 纪元，
      // prompt-submission.ts:95-116），所以"启动期送不到"并不等于"这个 Provider 收不到 prompt"。
      expect(kimi.planPromptInput('hello')).toEqual({ kind: 'single-phase', data: 'hello\r' })
      // 多行如实记：换行原样进 PTY，没有 paste 包裹。这是这条默认路的既有行为而非 Kimi 独有，
      // 钉在这里是为了让"以后谁给 Kimi 声明了 paste 形态"这件事必须显式改掉这条断言。
      expect(kimi.planPromptInput('a\nb')).toEqual({ kind: 'single-phase', data: 'a\nb\r' })
    })
  })

  describe('能力按源码读出的合同声明', () => {
    it('Hook 与 native resume 都声明，acp/usage 保持未声明', () => {
      const { capabilities, hookStrategy, resumeStrategy, acpStrategy } = kimi.catalog
      // unmanaged 而非 explicit-managed：配置面是 config.toml（TOML），本仓四种 merge 策略
      // 没有一种能编辑 TOML，且那是用户主配置。声明成 managed 就是「声明装了实际没装」。
      expect(hookStrategy).toEqual({ kind: 'native', installation: 'unmanaged' })
      expect(capabilities.timeline).toBe('complete-events')
      expect(resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(capabilities.providerResume).toBe(true)
      // hook 引擎 fail-open（runner.py:30,44-55），本就当不了安全边界，故只观察。
      expect(capabilities.permission).toBe('observe')
      // ACP 真实存在（`kimi acp` + agent-client-protocol 硬依赖），但 AgentMux 侧未接。
      expect(acpStrategy).toEqual({ kind: 'none' })
      expect(capabilities.replyCorrelation).toBe('none')
      // 收尾负载（events.py:73-96）里没有任何 token 字段，也不报 transcript 路径。
      expect(capabilities.usage).toBeUndefined()
    })

    it('unmanaged 意味着 Core 不为它解析任何安装计划', () => {
      // 这条是上面 unmanaged 声明的**行为**面：只断言字段相等，改成 explicit-managed 后
      // 字段断言会红，但「到底会不会去装」没人守。
      expect((new AgentProviderRegistry().get('kimi').planManagedHooks?.({ workspacePath: '/tmp/agentmux-kimi', env: {} }) ?? null)).toBeNull()
    })

    it('暴露原生会话历史读取接口', () => {
      expect(kimi.readSessionHistoryPage).toBeTypeOf('function')
    })
  })

  describe('Stop 是 afterStep 上的可 veto 探测，不当 main done 或 turn-end', () => {
    it('Stop 是在步结束后的 vetoable 探测，返回 working 且无 turn-end 生命周期', () => {
      // loopService.ts onDidFinishStep 调 runStop(ctx)；外部 hook block 会注入 system_trigger
      // stop_hook 继续运行，即使放行也是步级探测而非 turn 结束；绝不能当作 main done 或 turn-end。
      const event = hookIn('run-stop')('Stop')
      expect<AgentSemanticState>(event.semanticState).toBe('working')
      expect(event.lifecycleEvent).toBeNull()
    })

    it('进行中的事件（TurnStarted, UserPromptSubmit, PreToolUse, PostToolUse）报告 working', () => {
      const hook = hookIn('run-working')
      expect(hook('TurnStarted').semanticState).toBe('working')
      expect(hook('TurnStarted').lifecycleEvent).toBe('turn-start')
      expect(hook('UserPromptSubmit').semanticState).toBe('working')
      expect(hook('UserPromptSubmit').lifecycleEvent).toBe('user-prompt-submit')
      expect(hook('PreToolUse').semanticState).toBe('working')
      expect(hook('PreToolUse').lifecycleEvent).toBe('tool-use-start')
      expect(hook('PostToolUse').semanticState).toBe('working')
      expect(hook('PostToolUse').lifecycleEvent).toBe('tool-use-end')
    })

    it('PostToolUseFailure 只是工具失败，保持 working', () => {
      const hook = hookIn('run-tool-failure')
      const event = hook('PostToolUseFailure')
      expect(event.semanticState).toBe('working')
      expect(event.lifecycleEvent).toBe('tool-use-end')
    })

    it('PermissionRequest 处于 waiting 态', () => {
      const event = hookIn('run-perm')('PermissionRequest', { tool_name: 'bash' })
      expect(event.semanticState).toBe('waiting')
      expect(event.lifecycleEvent).toBe('permission-request')
    })

    it('未映射生命周期的事件保持可诊断，不伪造状态', () => {
      for (const eventName of ['PreCompact', 'PostCompact', 'TaskStarted', 'Notification']) {
        const event = hookIn('run-diag')(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.eventName).toBe(eventName)
      }
    })
  })

  describe('StopFailure 与 Interrupt 的作用域真实性与错误判定', () => {
    it('StopFailure 未给 agent 作用域时诚实 unknown/null，不猜 main，不填 transcriptPath', () => {
      // TS 2.1.1 agentExternalHooksService.ts notifyStopFailure 仅带 errorType 与 errorMessage，
      // 未带 agentId/agent_name。未给作用域时不能凭名字猜 main 或成功。
      const event = hookIn('run-stop-failure')('StopFailure', {
        error_type: 'RuntimeError',
        error_message: 'Process crashed'
      })
      expect(event.semanticState).toBe('unknown')
      expect(event.lifecycleEvent).toBeNull()
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
      expect(event.nativeHandle).not.toHaveProperty('transcriptPath')
    })

    it('Interrupt 未给 agent 作用域时诚实 unknown/null，不猜 main，不填 transcriptPath', () => {
      // TS 2.1.1 notifyTurnEnded 中 cancelled 仅发 { turnId, reason: 'cancelled' }。
      const event = hookIn('run-interrupt')('Interrupt', {
        turn_id: 42,
        reason: 'cancelled'
      })
      expect(event.semanticState).toBe('unknown')
      expect(event.lifecycleEvent).toBeNull()
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
      expect(event.nativeHandle).not.toHaveProperty('transcriptPath')
    })

    it('未证 extra data (如 agent_name: main) 不得使 classifier 猜成 error/turn-end', () => {
      // 第一方 TS 2.1.1 并不发 agent_name/agentName。若随意根据 extra 字段猜 main 作用域，
      // 会导致 StopFailure 被误当成主轮终局 turn-end。
      const event = hookIn('run-extra-main')('StopFailure', {
        agent_name: 'main',
        error_type: 'TimeoutError',
        error_message: 'Step timed out'
      })
      expect(event.semanticState).toBe('unknown')
      expect(event.lifecycleEvent).toBeNull()
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
    })

    it('未证 extra data (如 agent_name: unknown-display-name) 不得导致真实 nativeHandle 被抹除', () => {
      // 反例：若将未证 extra 字段当作 child subject 判定，会抹除 nativeHandle 导致 public 页 IDENTITY_UNAVAILABLE。
      // 必须保留真实 session_id。
      const event = hookIn('run-extra-child')('StopFailure', {
        agent_name: 'unknown-display-name',
        error_type: 'SubagentError'
      })
      expect(event.semanticState).toBe('unknown')
      expect(event.lifecycleEvent).toBeNull()
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
    })

    it('未证 extra 字段即使携带 agent_id 也不得将 Interrupt 猜成 turn-end', () => {
      const event = hookIn('run-extra-int')('Interrupt', {
        agent_id: 'main',
        turn_id: 10,
        reason: 'cancelled'
      })
      expect(event.semanticState).toBe('unknown')
      expect(event.lifecycleEvent).toBeNull()
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'kimi',
        sessionId: 'kimi-session-1'
      })
    })

    it('TS 2.1.1 第一方并无 SubagentStart/Stop hook，subagentTracking 保持未声明', () => {
      expect(KIMI_HOOKS.subagentTracking).toBeUndefined()
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
      // 不带 prompt——带了会依 post-launch-only 被拒（那条边界另有专门用例守）。
      expect(kimi.buildResumeLaunch({
        workspacePath: '/tmp/agentmux-kimi',
        nativeHandle: { kind: 'provider', providerId: 'kimi', sessionId: 'kimi-session-1' },
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
})

// ---------------------------------------------------------------------------
// 两条生命周期路径的接线守护。
//
// 上面的纯函数断言证明分流本身正确，但**不**证明 client 真的照它走：本仓没有能构造完整
// AgentMuxClient 的测试装置（kernel/daemon 都是真的），所以这一组读源码断言形状。剥掉注释再断言——
// 本仓踩过「标识符只出现在注释里，删掉真代码测试依然绿」的假绿。
//
// 承重的是「补送真的发生」这一半：只做分流而不补送，等于把静默丢失从 argv 挪到调用点，
// 用户的原话仍旧只落进时间轴、永不进入进程。那正是这整条轴要消灭的东西。
// ---------------------------------------------------------------------------
const clientCode = readFileSync(new URL('../../src/client.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/u, ''))
  .join('\n')

describe('post-launch-only 的补送在 launch 与 resume 两条路上都真的发生', () => {
  it('剥注释后仍能看到被测代码——否则下面的断言在对空字符串取胜', () => {
    expect(clientCode).toContain('private async deliverPostLaunchPrompt(')
    expect(clientCode.length).toBeGreaterThan(10_000)
  })

  it('两条路都经同一个分流函数，没有任何就地重判 promptDelivery 的残留', () => {
    // 两处各判一次迟早有一处判反——那正是「两条路对同一个『送得到吗』给不同答案」的形状。
    expect(clientCode.match(/splitLaunchPromptByDelivery\(/gu) ?? []).toHaveLength(2)
    expect(clientCode).not.toContain("promptDelivery !== 'post-launch-only'")
    expect(clientCode).not.toContain("promptDelivery === 'post-launch-only'")
  })

  it('两条路都把 deferred 那一半交给补送——只分流不补送就是把丢失挪了个地方', () => {
    expect(clientCode.match(/this\.deliverPostLaunchPrompt\(/gu) ?? []).toHaveLength(2)
    for (const [from, to] of [
      ['async createAgent(', 'private async ensureManagedHooks('],
      ['private async resumeAgentRun(', 'private async performAgentContinuity(']
    ] as const) {
      const start = clientCode.indexOf(from)
      const end = clientCode.indexOf(to, start)
      expect(end).toBeGreaterThan(start)
      const body = clientCode.slice(start, end)
      expect(body).toContain('splitLaunchPromptByDelivery(')
      // 分流出的 deferred 必须真的被送出去，而不是只被算出来然后扔掉。
      const deferredName = body.includes('deferred: deferredResumePrompt')
        ? 'deferredResumePrompt'
        : 'deferredPrompt'
      expect(body).toContain(`deferred: ${deferredName}`)
      expect(body).toContain(`this.deliverPostLaunchPrompt(`)
      expect(body.slice(body.indexOf('this.deliverPostLaunchPrompt(')))
        .toContain(deferredName)
    }
  })

  it('补送失败要说出来而不是吞掉，也不许把已经起来的 Run 抛崩', () => {
    const start = clientCode.indexOf('private async deliverPostLaunchPrompt(')
    const body = clientCode.slice(start, clientCode.indexOf('\n  private async ', start + 10))
    // 真的调用送达通路——只 publish 一条"已送达"而不 submit 是这条轴上最坏的假象。
    expect(body).toContain('this.promptSubmission.submitInputPlan(')
    expect(body).toContain('provider.planPromptInput(text)')
    // 失败必须发出去：静默失败会让界面看起来一切正常而 prompt 从未送达。
    expect(body).toContain('this.publisher.publish(')
    expect(body).toContain("type: 'agent-error'")
    // 且不许改成 throw：进程已经起来了，抛出去会让调用方以为整次启动失败并回滚一个健康的 Run。
    expect(body).not.toContain('throw')
  })
})

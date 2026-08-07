import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import { COPILOT_HOOK_EVENTS, COPILOT_HOOKS, createCopilotManagedHookPlan } from '../../src/providers/copilot.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from '../../src/providers/shared.js'
import { canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { hookToolOutcome } from '../../src/hook-tool-outcome.js'
import { USAGE_FINALIZATION_EVENTS } from '../../src/agent-hook-command.js'
import { releaseSubagentRoster } from '../../src/hook-normalizer.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-015 的 Provider 测试。
 *
 * 证据来自**执行这个 CLI 自己的 hook 解析器**：它的原生 runtime（`prebuilds/darwin-arm64/runtime.node`）
 * 能被 node 直接加载，于是本轮不是读二进制字符串猜形状，而是真的把配置喂进去、真的让它 spawn 一个捕获
 * 脚本、真的读回每个事件的 stdin 负载。下面每一条标「实测」的断言，其期望值都逐字来自那次捕获。
 *
 * 这些断言证明「声明与真实解析器/真实负载相符」。它**不**证明跑过一次完整的真实会话——事件是由
 * runtime 的派发入口触发的，不是由一个真在干活的 Agent 触发的，不冒充。
 */
describe('Copilot provider', () => {
  const providers = new AgentProviderRegistry()
  const copilot = providers.get('copilot')

  /**
   * 造一条 Copilot 形状的信封：事件名 camelCase，**负载键也 camelCase**。
   *
   * 三个基础键每个事件都有（实测）：`sessionId`/`timestamp`/`cwd`。注意是 `cwd` 而不是 SDK 那侧的
   * `workingDirectory`——同一个 CLI 的两条 hook 通道负载拼法不同。
   *
   * `runId` 必须逐个用例区分：子代理花名册是 normalizer 里按 runId 索引的模块级可变状态。
   */
  function hookIn(runId: string) {
    return (eventName: string, payload: Record<string, unknown> = {}) =>
      copilot.normalizeHook({
        receiptId: `r-${runId}-${eventName}`,
        agentSessionId: 's-copilot',
        runId,
        providerId: 'copilot',
        eventName,
        payload: {
          sessionId: 'copilot-session-1',
          timestamp: 1_788_214_226_179,
          cwd: '/repo',
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

  describe('事件名一个字都不能猜——写错了没有任何信号', () => {
    it('装的十个逐字如此，且不含任何一个 Claude 一族的拼法', () => {
      // 这条守的是一次真实的踩坑：这个解析器对**不认识的事件名静默丢弃**——不报错、不告警，配置照样
      // 加载成功，只是那个桶永远不响。先写的 `userPromptSubmit`（Claude 一族拼法，也是最自然的猜法）
      // 就是这样被吃掉的，真名是 `userPromptSubmitted`。所以这里逐字钉住，而不是断言"包含某个前缀"。
      expect([...COPILOT_HOOK_EVENTS]).toEqual([
        'sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure',
        'permissionRequest', 'subagentStart', 'subagentStop', 'preCompact', 'agentStop'
      ])
      for (const wrong of ['UserPromptSubmit', 'userPromptSubmit', 'Stop', 'stop', 'PreToolUse', 'SessionStart']) {
        expect(COPILOT_HOOK_EVENTS).not.toContain(wrong)
      }
    })

    it('配置形状：version 是字面量 1、条目在 hooks 下、每条带 timeoutSec', () => {
      // 实测 schema：`version: Invalid literal value, expected 1`；字段名是 `timeoutSec` 而不是
      // `timeout`——写 `timeout` 会被剥掉然后静默用它自己的默认超时（不是报错，是换了行为）。
      const plan = resolveManagedHookPlan('copilot', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as {
        version: number
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeoutSec: number }> }>>
      }
      expect(config.version).toBe(1)
      expect(Object.keys(config.hooks).sort()).toEqual([...COPILOT_HOOK_EVENTS].sort())
      for (const eventName of COPILOT_HOOK_EVENTS) {
        const entry = config.hooks[eventName]![0]!
        expect(entry.hooks[0]!.type).toBe('command')
        expect(entry.hooks[0]!.command).toContain('agentmux-hook.js')
        // 从 SSOT 常量派生，不再手抄 `10`——bump 常量不该把这条无辜打红。值仍流经 provider→JSON→parse，
        // 故 provider 里写死错值或丢 timeoutSec 照样红。字段名仍断言是 timeoutSec（下一行守它不被抄成 timeout）。
        expect(entry.hooks[0]!.timeoutSec).toBe(HOOK_COMMAND_TIMEOUT_SECONDS)
        // `timeout` 是别家的拼法，这里出现就说明有人照抄了 droid/grok。
        expect(entry.hooks[0]).not.toHaveProperty('timeout')
      }
    })

    it('matcher 是正则不是 glob——写 * 会让整个桶失效', () => {
      // 实测：`matcher: '*'` 被当作**无效正则**拒掉（那个桶一个事件都不响），`'.*'` 正常。这与 droid
      // 恰好相反（droid 的 `'*'` 是合法 glob），所以两家不能互抄这个字面量。
      const plan = resolveManagedHookPlan('copilot', '/repo/app')
      const config = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string }>>
      }
      const withMatcher = Object.entries(config.hooks)
        .filter(([, entries]) => entries[0]!.matcher !== undefined)
        .map(([eventName]) => eventName)
        .sort()
      expect(withMatcher).toEqual(['postToolUse', 'preToolUse'])
      for (const eventName of withMatcher) {
        expect(config.hooks[eventName]![0]!.matcher).toBe('.*')
      }
    })

    it('装到自己独占的一份文件，绝不碰用户的 config.json 也不碰仓库', () => {
      // 那个目录下**任意文件名**都会被加载（实测），所以 AgentMux 可以整文件拥有——于是不需要合并
      // 策略。这条同时守住两个绝不能碰的位置：用户级 `config.json`（装着模型/授权规则等全部设置）
      // 与仓库级 `.github/hooks/`（会被提交进用户仓库）。
      const plan = resolveManagedHookPlan('copilot', '/repo/app')
      expect(plan!.mutations).toHaveLength(1)
      const [mutation] = plan!.mutations
      expect(mutation!.path).toContain('/.copilot/hooks/agentmux.json')
      expect(mutation!.path).not.toContain('config.json')
      expect(mutation!.path).not.toContain('.github')
      // 独占文件 => 无合并策略。有了它反而说明有人以为这份文件是共享的。
      expect(mutation!.merge).toBeUndefined()
    })

    it('COPILOT_HOME 被尊重，空串等于没设', () => {
      // 逐字实现它自己的解析：`configDir ?? COPILOT_HOME ?? join(homedir(), '.copilot')`，
      // 且它自己的判断是 `if (t === undefined || t === "")`——空串必须回落，否则会往 `/hooks/...` 写。
      expect(createCopilotManagedHookPlan({ COPILOT_HOME: '/tmp/ch' }).mutations[0]!.path)
        .toBe('/tmp/ch/hooks/agentmux.json')
      expect(createCopilotManagedHookPlan({ COPILOT_HOME: '   ' }).mutations[0]!.path)
        .toContain('/.copilot/hooks/agentmux.json')
    })

    it('装的位置与 workspace 无关——resolver 不该拿 workspacePath 派生路径', () => {
      const a = resolveManagedHookPlan('copilot', '/repo/one')
      const b = resolveManagedHookPlan('copilot', '/repo/two')
      expect(a!.mutations[0]!.path).toBe(b!.mutations[0]!.path)
    })
  })

  describe('负载键两侧都是 camelCase——与 Cursor 恰好相反', () => {
    it('postToolUse 的正文在 toolResult.textResultForLlm，不是整体序列化', () => {
      // 实测负载逐字：`{"toolName":"bash","toolArgs":{"command":"ls"},
      // "toolResult":{"resultType":"success","textResultForLlm":"…"}}`。
      // 少了嵌套正文键，用户看到的是一段带引号转义的机器噪音而不是命令输出。
      const post = toolMutation(hookIn('run-tool')('postToolUse', {
        toolName: 'bash',
        toolArgs: { command: 'npm test' },
        toolResult: { resultType: 'success', textResultForLlm: '12 passed' }
      }))
      expect(post.item.toolOutput).toBe('12 passed')
      expect(post.item.toolName).toBe('bash')
    })

    it('rejected/denied/timeout 走的是成功那条事件，只有 resultType 说出真相', () => {
      // 上游类型注释逐字：`"rejected"`、`"denied"`、`"timeout"` **都不触发** postToolUseFailure，
      // 只有 `"failure"` 触发。于是那三类失败会照常走 postToolUse——不读 resultType，它们在时间轴上
      // 和成功长得一模一样。这正是 Provider parity 验收明令禁止的缺陷。
      for (const resultType of ['rejected', 'denied', 'timeout', 'failure']) {
        const outcome = hookToolOutcome({
          toolName: 'bash', toolResult: { resultType, textResultForLlm: 'nope' }
        })
        expect(outcome.failed, resultType).toBe(true)
        expect(outcome.output, resultType).toBe('nope')
      }
      // success 必须仍判成功——否则上面四条会因为"一律报红"而假绿。
      const ok = hookToolOutcome({ toolResult: { resultType: 'success', textResultForLlm: 'fine' } })
      expect(ok.failed).toBe(false)
      expect(ok.output).toBe('fine')
    })

    it('postToolUseFailure 的正文在 error，且负载里没有 toolResult', () => {
      // 实测：失败事件的负载是 `{toolName, toolArgs, error}`——上游**不**把完整的结果对象转发给失败
      // hook（它自己的类型注释写明了这点）。所以正文只能从 `error` 读。
      const failed = toolMutation(hookIn('run-fail')('postToolUseFailure', {
        toolName: 'bash', toolArgs: { command: 'exit 1' }, error: 'command failed with exit 1'
      }))
      expect(failed.item.toolOutput).toBe('command failed with exit 1')
      expect(failed.item.status).toBe('failed')
    })

    it('preToolUse/postToolUse 的 canonical 步骤分别是事前与事后', () => {
      // 结构由表回答，不由拼写猜。也是「事后才采集成败与正文」的唯一判据。
      expect(canonicalHookLifecycleEvent('preToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('postToolUse')).toBe('tool-use-end')
      // 失败事后也必须是 tool-use-end，否则那次调用会永远停在 streaming 徽标上。
      expect(canonicalHookLifecycleEvent('postToolUseFailure')).toBe('tool-use-end')
    })

    it('负载里没有工具关联 id，所以 pre/post 如实退回 append-only', () => {
      // 实测：两端负载都只有 `toolName`/`toolArgs`（post 另带 `toolResult`），没有任何关联 id。
      // 它的 SDK 类型里只有 `PreMcpToolCallHookInput` 有 `toolCallId`——那是 MCP 那条路、且只有事前
      // 一侧。所以一次调用在时间轴上是两行而不是一行。哪天上游把 id 加进负载、或有人给这个 Provider
      // 编造一个 id 键，这条都会报红。
      const hook = hookIn('run-append')
      const pre = toolMutation(hook('preToolUse', { toolName: 'bash', toolArgs: { command: 'ls' } }))
      const post = toolMutation(hook('postToolUse', {
        toolName: 'bash', toolArgs: { command: 'ls' },
        toolResult: { resultType: 'success', textResultForLlm: 'a\nb' }
      }))
      expect(post.item.id).not.toBe(pre.item.id)
      expect(post.item.toolOutput).toBe('a\nb')
      expect(pre.item.toolOutput).toBeUndefined()
      expect(copilot.catalog.capabilities.replyCorrelation).toBe('none')
    })
  })

  describe('收尾只有 agentStop 一种，且不是 sessionEnd', () => {
    it('agentStop 判 done、是 turn-end、也是用量落定点', () => {
      const event = hookIn('run-stop')('agentStop', {
        stopReason: 'end_turn', transcriptPath: '/tmp/copilot/t.jsonl'
      })
      expect<AgentSemanticState>(event.semanticState).toBe('done')
      expect(canonicalHookLifecycleEvent('agentStop')).toBe('turn-end')
      expect(USAGE_FINALIZATION_EVENTS.has('agentStop')).toBe(true)
    })

    it('没有第二种收尾事件——别照抄 Claude 与 grok 的多条 done', () => {
      // 十五个 `hooks.*` 键里没有 StopFailure/stop_cancelled 这类东西。装一个上游从不发的事件，
      // 是在配置里留一条死规则。
      for (const absent of ['StopFailure', 'stopFailure', 'agentStopFailure', 'stop_cancelled']) {
        expect(COPILOT_HOOK_EVENTS).not.toContain(absent)
      }
    })

    it('sessionEnd 既不装也不判 done——会话终结不是轮次事实', () => {
      // 它在上游是真实事件（实测带 `reason`），我们刻意不装：判「这一轮结束」靠 agentStop，会话终结
      // 由 PTY 事实回答。与 droid/Gemini 对它们各自的 SessionEnd 是同一个既定判断。
      expect(COPILOT_HOOK_EVENTS).not.toContain('sessionEnd')
      expect(canonicalHookLifecycleEvent('sessionEnd')).toBeUndefined()
      expect(hookIn('run-sessionend')('sessionEnd', { reason: 'user_exit' }).semanticState).toBe('unknown')
    })
  })

  describe('子代理成对，但只能按名字记账', () => {
    it('按 agentName 记账——按 agentId 会让每个 start 都记不上', () => {
      // 实测的不对称：`subagentStart` 只有 `transcriptPath` + `agentName`，**没有** `agentId`；
      // `subagentStop` 两个都有。记账要求 start 与 stop 认同一个键，于是唯一两端都在的是 agentName。
      // 后果是同名子代理并发时记成一个——上游负载的事实，不是这里能补的。
      expect(COPILOT_HOOKS.subagentTracking).toEqual({
        startEvents: ['subagentStart'],
        stopEvents: ['subagentStop'],
        mainStopEvents: ['agentStop'],
        idKeys: ['agentName']
      })
    })

    it('在途子代理压住主 agentStop，最后一个落地时才兑现 done', () => {
      // 这条守「记账真的起作用」而不只是「字段填对了」：主 Agent 说完成、子代理还在跑时必须压成
      // working，否则界面提前翻完成、还会误报完成通知。
      const runId = 'run-subagent'
      releaseSubagentRoster(runId)
      const hook = hookIn(runId)
      expect(hook('subagentStart', { agentName: 'reviewer' }).semanticState).toBe('working')
      expect(hook('agentStop', { stopReason: 'end_turn' }).semanticState).toBe('working')
      expect(hook('subagentStop', { agentName: 'reviewer', agentId: 'ag-1' }).semanticState).toBe('done')
      releaseSubagentRoster(runId)
    })
  })

  describe('授权门与压缩', () => {
    it('permissionRequest 判 waiting 而非 working', () => {
      // 这一刻 Copilot 正把调用按住等一个决定，而我们不回决定（permission: 'observe'），于是它落到
      // Copilot 自己的 TUI 提示上等用户——那正是 waiting。判 working 会让「等我点一下」和「正在干活」
      // 在界面上长得一模一样。
      const event = hookIn('run-perm')('permissionRequest', { toolName: 'bash' })
      expect<AgentSemanticState>(event.semanticState).toBe('waiting')
      expect(canonicalHookLifecycleEvent('permissionRequest')).toBe('permission-request')
      expect(copilot.catalog.capabilities.permission).toBe('observe')
    })

    it('preCompact 判 working，且不冒称 canonical 生命周期', () => {
      // 压缩期间 Agent 仍在干活，而这段时间没有任何工具事件——少了它长压缩看起来像卡死。
      // 但它不是结构上的某一步，故不进 canonical 表（与 Claude/droid 的 PreCompact 同一处理）。
      const event = hookIn('run-compact')('preCompact', { trigger: 'auto' })
      expect(event.semanticState).toBe('working')
      expect(canonicalHookLifecycleEvent('preCompact')).toBeUndefined()
    })
  })

  describe('声明与安装必须一致', () => {
    it('rules 引用的每个事件都在安装清单里', () => {
      // 守「两份清单一致」而不是「清单等于某个字面量」：后者只在有人改清单时提醒改测试，
      // 前者才会在有人只改一半时报红。rules 里写了却没装的事件，CLI 压根不触发。
      const referenced = new Set<string>()
      for (const rule of COPILOT_HOOKS.rules) for (const eventName of rule.events) referenced.add(eventName)
      const tracking = COPILOT_HOOKS.subagentTracking
      for (const eventName of [
        ...(tracking?.startEvents ?? []), ...(tracking?.stopEvents ?? []), ...(tracking?.mainStopEvents ?? [])
      ]) referenced.add(eventName)
      const installed = new Set<string>(COPILOT_HOOK_EVENTS)
      expect([...referenced].filter((eventName) => !installed.has(eventName))).toEqual([])
    })

    it('装的每个事件都被某条 rule 判过——装了不判等于白起一个子进程', () => {
      const judged = new Set<string>()
      for (const rule of COPILOT_HOOKS.rules) for (const eventName of rule.events) judged.add(eventName)
      for (const eventName of COPILOT_HOOKS.subagentTracking?.stopEvents ?? []) judged.add(eventName)
      expect([...COPILOT_HOOK_EVENTS].filter((eventName) => !judged.has(eventName))).toEqual([])
    })

    it('未装的事件到达时保持可诊断，绝不伪造状态', () => {
      const hook = hookIn('run-unknown')
      for (const eventName of ['sessionEnd', 'userPromptTransformed', 'errorOccurred', 'notification']) {
        const event = hook(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.status.detail).toBe(eventName)
      }
    })
  })

  describe('catalog 如实声明它有的和没有的', () => {
    it('native handle 读 camelCase 的 sessionId 与 transcriptPath', () => {
      const event = hookIn('run-handle')('agentStop', {
        stopReason: 'end_turn', transcriptPath: '/tmp/copilot/t.jsonl'
      })
      expect(event.nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'copilot',
        sessionId: 'copilot-session-1',
        transcriptPath: '/tmp/copilot/t.jsonl'
      })
    })

    it('sessionStart 没有 transcriptPath 也仍能给出 handle', () => {
      // 实测：`transcriptPath` 只在 stop 一族事件上出现，`sessionStart` 那条只有 `source`/
      // `initialPrompt`。声明 requireTranscriptPath 会让会话开头拿不到 handle。
      const event = hookIn('run-start')('sessionStart', { source: 'startup', initialPrompt: 'hi' })
      expect(event.nativeHandle).toEqual({
        kind: 'provider', providerId: 'copilot', sessionId: 'copilot-session-1'
      })
    })

    it('resume 走 --resume，不走 --session-id', () => {
      // `--help` 逐字：`-r, --resume [value]`、`--continue`、`--session-id <id>`。后者是**给新会话
      // 指定 id**，不是恢复（与 grok 同一区分）。
      expect(copilot.catalog.resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(copilot.catalog.capabilities.providerResume).toBe(true)
      const launch = copilot.buildResumeLaunch({
        nativeHandle: {
          kind: 'provider', providerId: 'copilot',
          sessionId: 'sess-9', transcriptPath: '/tmp/t.jsonl'
        },
        args: ['--banner'],
        workspacePath: '/repo/app',
        env: {}
      })
      expect(launch.command).toBe('copilot')
      expect(launch.args).toEqual(['--resume', 'sess-9', '--banner'])
      expect(launch.args).not.toContain('--session-id')
    })

    it('别家的 native handle 恢复不了——两类失败必须可区分', () => {
      // 验收要求「Provider unavailable 与 native handle missing 两类恢复失败可区分」。这里守后者。
      expect(() => copilot.buildResumeLaunch({
        nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 's-1' },
        args: [], workspacePath: '/repo/app', env: {}
      })).toThrowError(/does not belong to this provider/)
    })

    it('acp 与 usage 都不声明——两条真实存在但今天接不上的通路', () => {
      // `--acp`（"Start as Agent Client Protocol server"）在这个 CLI 里真的存在，但 AgentMux 今天
      // 没有任何 Provider 声明 adapter 策略，那条通路一端还没有。声明一个接不上的能力比不声明更坏。
      // 判据落在 `acpStrategy`——它是真正被消费的那个字段（capabilities 上那份同名布尔是零消费者的
      // 副本，已随 AgentCapabilities 的收敛一并删掉）。
      expect(copilot.catalog.acpStrategy).toEqual({ kind: 'none' })
      // 收尾负载里只有 stopReason/transcriptPath，没有任何 token 字段；transcript 格式未核实。
      expect(copilot.catalog.capabilities.usage).toBeUndefined()
    })

    it('prompt 走位置参数，且 resume 时也带得上', () => {
      const ws = { workspacePath: '/repo/app', env: {} }
      expect(copilot.buildLaunch({ prompt: 'do it', args: ['--banner'], ...ws }).args)
        .toEqual(['--banner', 'do it'])
      expect(copilot.buildLaunch({ prompt: '', args: ['--banner'], ...ws }).args)
        .toEqual(['--banner'])
      expect(copilot.buildResumeLaunch({
        nativeHandle: { kind: 'provider', providerId: 'copilot', sessionId: 's-1' },
        prompt: 'keep going', args: [], ...ws
      }).args).toEqual(['--resume', 's-1', 'keep going'])
    })
  })
})

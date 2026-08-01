import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../../src/agent-provider.js'
import {
  CURSOR_HOOK_EVENTS,
  createCursorManagedHookPlan,
  cursorTrustMarkerPath
} from '../../src/providers/cursor.js'
import { CURSOR_HOOK_DIALECT, canonicalHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { hookResponseFor } from '../../src/agent-hook-command.js'
import { renderMergedHookContent } from '../../src/hook-config-merge.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentSemanticState } from '../../src/types.js'

/**
 * T-008 的 Provider 测试。
 *
 * 证据来自**读本机安装的 cursor-agent bundle**
 * （`~/.local/share/cursor-agent/versions/2026.08.11-e8db854/`，主要是 `index.js` 与
 * `6260.index.js`），核对本机既有的 `~/.cursor/hooks.json` 与一份真实的
 * `.workspace-trusted` marker。见 docs/reviews/agentmux-provider-cli-evidence.md 的 Cursor 小节。
 *
 * 这些断言证明「声明与 bundle 里读出的合同相符」，**不**证明「跑过一次真实的 Cursor 会话」——
 * `cursor-agent ls`/`resume` 都是交互式 TUI，本机脚本化跑不了，不冒充。
 */
describe('Cursor provider', () => {
  const providers = new AgentProviderRegistry()
  const cursor = providers.get('cursor')

  /** 造一条 Cursor 形状的信封：事件名 camelCase 走 `--event`（负载里没有事件名键），负载键 snake_case。 */
  function hook(eventName: string, payload: Record<string, unknown> = {}) {
    return cursor.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-cursor',
      runId: 'run-cursor',
      providerId: 'cursor',
      eventName,
      payload: {
        conversation_id: 'conv-1',
        generation_id: 'gen-1',
        model: 'gpt-5',
        ...payload
      }
    })
  }

  /** 取出那条携带完整 item 的工具轨迹，narrow 掉 `update` 变体（否则 `.item` 在类型上不存在）。 */
  function toolMutation(event: ReturnType<typeof hook>) {
    const mutation = event.timeline.find(
      (candidate) => candidate.type !== 'update' && candidate.item.kind === 'tool_call'
    )
    if (!mutation || mutation.type === 'update') {
      throw new Error('expected a tool_call timeline item carrying a full item')
    }
    return mutation
  }

  describe('不再是 terminal-only：能力按 bundle 读出的合同声明', () => {
    it('Hook 与 native resume 都声明，且 acp/usage 保持未声明', () => {
      const { capabilities, hookStrategy, resumeStrategy, acpStrategy } = cursor.catalog
      expect(hookStrategy).toEqual({ kind: 'native', installation: 'explicit-managed' })
      expect(capabilities.timeline).toBe('complete-events')
      // `--resume [chatId]` 直传 chat id（bundle: `else fe=o.resume`），故 locator 是 session-id。
      expect(resumeStrategy).toEqual({ kind: 'provider-native', locator: 'session-id' })
      expect(capabilities.providerResume).toBe(true)
      // 三个门读 stdout 的 permission，但我们只观察不应答。
      expect(capabilities.permission).toBe('observe')
      expect(acpStrategy).toEqual({ kind: 'none' })
      // stop 负载直接带 input_tokens/output_tokens，但今天的 usage 通路只有 native-transcript
      // 一种形状——声明它等于承诺解析一个 Cursor 从不产出的 transcript 文件。
      expect(capabilities.usage).toBeUndefined()
    })
  })

  describe('事件名 camelCase，负载键却是 Claude 同族的 snake_case', () => {
    it('方言只映射结构上答得了的那几条，门与「一段回复」刻意不映射', () => {
      expect(canonicalHookLifecycleEvent('beforeSubmitPrompt')).toBe('user-prompt-submit')
      expect(canonicalHookLifecycleEvent('preToolUse')).toBe('tool-use-start')
      expect(canonicalHookLifecycleEvent('postToolUse')).toBe('tool-use-end')
      // 失败也是一次调用的**事后**：少了这条，失败的调用会永远停在 streaming 徽标上。
      expect(canonicalHookLifecycleEvent('postToolUseFailure')).toBe('tool-use-end')
      expect(canonicalHookLifecycleEvent('stop')).toBe('turn-end')
      // 授权门不是工具事前：同一条命令会先过门再走 preToolUse，都算 tool-use-start 会落两条。
      expect(canonicalHookLifecycleEvent('beforeShellExecution')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('beforeMCPExecution')).toBeUndefined()
      // 一段回复的收尾不是一轮的收尾——一轮里可以有多段回复，turn-end 由 stop 独占。
      expect(canonicalHookLifecycleEvent('afterAgentResponse')).toBeUndefined()
      // 装的事件是方言的超集（门与 afterAgentResponse 有 rules 无 canonical 映射）。
      for (const mapped of Object.keys(CURSOR_HOOK_DIALECT)) {
        expect(CURSOR_HOOK_EVENTS).toContain(mapped)
      }
    })

    it('不照抄 Claude 的 PascalCase：那些名字 Cursor 压根不发', () => {
      for (const claudeOnly of ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']) {
        expect(CURSOR_HOOK_EVENTS).not.toContain(claudeOnly)
      }
      // 大小写没有被折叠：`stop` 有映射，`Stop` 也有（Claude 的），但 `STOP` 两家都没有。
      expect(canonicalHookLifecycleEvent('STOP')).toBeUndefined()
      expect(canonicalHookLifecycleEvent('pretooluse')).toBeUndefined()
    })

    it('不装 Cursor 那些每次读文件/每次编辑都触发的高频事件', () => {
      // 装了它们等于把一个子进程挂到 Agent 最热的路径上，而 Core 没有任何判断需要它们。
      for (const hot of ['beforeReadFile', 'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit']) {
        expect(CURSOR_HOOK_EVENTS).not.toContain(hot)
        expect(canonicalHookLifecycleEvent(hot)).toBeUndefined()
      }
    })
  })

  describe('一次工具调用在时间轴上收敛成一条，且失败与成功分得开', () => {
    const call = { tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 'tu-77', cwd: '/repo' }

    it('preToolUse 落在途态并按 tool_use_id 关联', () => {
      const pre = toolMutation(hook('preToolUse', call))
      expect(pre.type).toBe('append')
      expect(pre.item.status).toBe('streaming')
      expect(pre.item.id).toBe('run-cursor:tool:tu-77')
      expect(pre.item.toolName).toBe('Shell')
      expect(hook('preToolUse', call).semanticState).toBe('working')
    })

    it('postToolUse 用同一个 id upsert 成 complete 并带上 tool_output', () => {
      const post = toolMutation(hook('postToolUse', {
        ...call, tool_output: 'ok, 12 passed', duration: 1200
      }))
      expect(post.type).toBe('upsert')
      expect(post.item.id).toBe('run-cursor:tool:tu-77')
      expect(post.item.status).toBe('complete')
      expect(post.item.toolOutput).toBe('ok, 12 passed')
    })

    it('postToolUseFailure 判 failed 并把 error_message 当正文——它没有 tool_output 也没有 is_error', () => {
      // 这是本 task 最要紧的一条。Cursor 的失败负载**只**有 error_message/failure_type/is_interrupt：
      // 既没有 tool_output、也没有 is_error/exit_code/status。少了对这几个键的判据，一次失败的调用
      // 会被收敛成 complete，和成功的长得一模一样——那正是验收明令禁止的「失败画成成功」。
      const failure = toolMutation(hook('postToolUseFailure', {
        tool_name: 'Shell',
        tool_input: { command: 'npm test' },
        tool_use_id: 'tu-77',
        error_message: 'exit status 1: 3 tests failed',
        failure_type: 'tool_error',
        is_interrupt: false,
        duration: 900
      }))
      expect(failure.type).toBe('upsert')
      expect(failure.item.id).toBe('run-cursor:tool:tu-77')
      expect(failure.item.status).toBe('failed')
      // 红标记之外还得看得见原因，否则用户只知道「炸了」不知道炸在哪。
      expect(failure.item.toolOutput).toBe('exit status 1: 3 tests failed')
    })

    it('空的 error_message 不算失败——证明不了任何事的字段不该翻红', () => {
      const blank = toolMutation(hook('postToolUseFailure', {
        tool_name: 'Shell', tool_input: {}, tool_use_id: 'tu-88', error_message: '   '
      }))
      expect(blank.item.status).toBe('complete')
    })
  })

  describe('stop 是唯一的收尾；两个门是「在等用户」而不是「在干活」', () => {
    it('stop 判 done 并归入 turn-end，三种非正常收尾同样是收尾', () => {
      for (const status of ['completed', 'aborted', 'cancelled', 'error']) {
        const event = hook('stop', { status, loop_count: 3, input_tokens: 120, output_tokens: 45 })
        expect<AgentSemanticState>(event.semanticState).toBe('done')
        expect(event.lifecycleEvent).toBe('turn-end')
      }
    })

    it('shell/MCP 门判 waiting：Cursor 正把这次执行按住等一个决定', () => {
      // 判 working 会让「等我点一下」和「正在干活」在界面上长得一模一样。
      expect(hook('beforeShellExecution', { command: 'rm -rf build' }).semanticState).toBe('waiting')
      expect(hook('beforeMCPExecution', { tool_name: 'linear__create_issue' }).semanticState).toBe('waiting')
    })

    it('afterAgentResponse 把助手正文落进时间轴，但不收尾这一轮', () => {
      const event = hook('afterAgentResponse', { text: 'Done — tests pass.', input_tokens: 10, output_tokens: 4 })
      expect(event.semanticState).toBe('working')
      expect(event.lifecycleEvent).toBeUndefined()
      const assistant = event.timeline.find(
        (candidate) => candidate.type !== 'update' && candidate.item.kind === 'assistant_message'
      )
      expect(assistant && assistant.type !== 'update' && assistant.item.content).toBe('Done — tests pass.')
    })

    it('未知事件保持可诊断，绝不伪造状态', () => {
      const event = hook('afterAgentThought')
      expect(event.lifecycleEvent).toBeUndefined()
      expect(event.semanticState).toBe('unknown')
      expect(event.status.detail).toBe('afterAgentThought')
    })

    it('不声明 nativeHandle：conversation_id 不是 --resume 吃的 chat id', () => {
      // 拿 conversation_id 当 handle 存下来，会让 UI 显示一个恢复必失败的 Resume。
      expect(hook('stop', { status: 'completed' }).nativeHandle).toBeUndefined()
      expect(hook('preToolUse', { tool_name: 'Read', tool_use_id: 'x' }).nativeHandle).toBeUndefined()
    })
  })

  describe('我们回的 {} 既合法又不改变 Cursor 的行为', () => {
    it('对每个装了的事件都回裸 {}，绝不泄漏 Antigravity 的 decision 形状', () => {
      // Cursor 的校验器写明 permission 可为 undefined；提交门只在**显式** `continue === false`
      // 时才拦。所以 {} 是「不表态」，不是「拒绝」。回 Antigravity 那套 {"decision":...} 会让
      // Cursor 的校验器判成 Invalid permission value。
      for (const eventName of CURSOR_HOOK_EVENTS) {
        expect(hookResponseFor('cursor', eventName)).toBe('{}\n')
      }
    })
  })

  describe('装到 user 层的 hooks.json，并预置 workspace trust marker', () => {
    const plan = resolveManagedHookPlan('cursor', '/repo/app')

    it('两个 mutation 同时下发：hooks 配置 + trust marker', () => {
      // 缺了 marker，Cursor 会用一个交互式 trust 提示吃掉第一个 prompt——用户看到的是
      // 「AgentMux 把我的第一句话弄丢了」。两者必须在同一时刻成立。
      expect(plan?.mutations).toHaveLength(2)
      expect(plan!.mutations[0]!.path.endsWith('/.cursor/hooks.json')).toBe(true)
      expect(plan!.mutations[1]!.path.endsWith('/.workspace-trusted')).toBe(true)
    })

    it('计划真的能被启动路径那道门取到，而不只是一个导出的函数', () => {
      // client.ts 的 ensureManagedHooks 先判 `hookStrategy.installation === 'explicit-managed'`，
      // 再调 resolveManagedHookPlan。两者少任何一半，安装器就永远拿不到 cursor 的计划——那时
      // 上面所有断言依然全绿，因为它们直接调的是工厂函数。这条把接线本身钉住。
      expect(cursor.catalog.hookStrategy).toEqual({ kind: 'native', installation: 'explicit-managed' })
      expect(resolveManagedHookPlan('cursor', '/repo/app')).not.toBeNull()
      // env 也必须真的一路穿到解析器，否则 CURSOR_DATA_DIR 只在直调工厂时生效、在启动路径上失效。
      expect(resolveManagedHookPlan('cursor', '/repo/app', { CURSOR_DATA_DIR: '/tmp/cd' })!.mutations[0]!.path)
        .toBe('/tmp/cd/hooks.json')
    })

    it('绝不写 project 层的 .cursor/hooks.json，也不碰 Cursor 兼容读取的 ~/.claude/settings.json', () => {
      // project 层会被提交进用户仓库；~/.claude/settings.json 是用户为 Claude 维护的配置
      // （Cursor 为兼容也读它）。两处都不是 AgentMux 该写的地方。
      for (const mutation of plan!.mutations) {
        expect(mutation.path.startsWith('/repo/app')).toBe(false)
        expect(mutation.path).not.toContain('/.claude/')
      }
    })

    it('装的事件恰好是声明的八个，且每条都用 --event 传事件名', () => {
      const written = JSON.parse(plan!.mutations[0]!.content) as {
        version: number
        hooks: Record<string, Array<{ command: string; timeout: number }>>
      }
      expect(written.version).toBe(1)
      expect(Object.keys(written.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort())
      for (const [eventName, definitions] of Object.entries(written.hooks)) {
        // Cursor 的负载里**没有** hook_event_name（那个键只在它自己的遥测标签里）。少了这个旗标，
        // 每条事件到 Core 都会读成 'unknown'——状态与时间轴双双失效。
        expect(definitions[0]!.command).toContain(`--event ${eventName}`)
        expect(definitions[0]!.command).toContain('agentmux-hook.js')
      }
    })

    it('trust marker 路径按 workspace 派生，slug 与 Cursor 的三步变换逐字一致', () => {
      // 差一步就写到另一个目录，marker 形同不存在。
      expect(cursorTrustMarkerPath('/Users/me/proj/priv/my-app', {}))
        .toContain('/projects/Users-me-proj-priv-my-app/.workspace-trusted')
      // 连续的非字母数字折叠成一个 `-`，首尾的 `-` 去掉。
      expect(cursorTrustMarkerPath('/a//b__c.d/', {}))
        .toContain('/projects/a-b-c-d/.workspace-trusted')
    })

    it('CURSOR_DATA_DIR 覆盖被尊重——忽略它会写出一个 Cursor 永远不读的 marker', () => {
      const overridden = createCursorManagedHookPlan('/repo/app', { CURSOR_DATA_DIR: '/tmp/cursor-data' })
      expect(overridden.mutations[0]!.path).toBe('/tmp/cursor-data/hooks.json')
      expect(overridden.mutations[1]!.path).toBe('/tmp/cursor-data/projects/repo-app/.workspace-trusted')
    })

    it('marker 内容对同一个 workspace 恒定——真实时钟会让每次启动都重写它', () => {
      // installer 靠「内容 hash 未变」判定无需重写；`new Date()` 会让 preview 与 install 两次渲染
      // 结果不同，直接撞上 HOOK_TARGET_CHANGED。
      const once = createCursorManagedHookPlan('/repo/app', {}).mutations[1]!.content
      const twice = createCursorManagedHookPlan('/repo/app', {}).mutations[1]!.content
      expect(twice).toBe(once)
      const marker = JSON.parse(once) as { trustedAt: string; workspacePath: string }
      expect(marker.workspacePath).toBe('/repo/app')
      // 是一个真实可解析的 ISO 时间戳，而不是占位字符串。
      expect(Number.isFinite(Date.parse(marker.trustedAt))).toBe(true)
      // 不冒用 Cursor 自己那两种来源标签（cli-flag / inherited）——AgentMux 走的是第三条路。
      expect(Object.keys(marker).sort()).toEqual(['trustedAt', 'workspacePath'])
      // 不同 workspace 得到不同的值，否则这个字段就只是个常量。
      const other = JSON.parse(createCursorManagedHookPlan('/repo/other', {}).mutations[1]!.content) as {
        trustedAt: string
      }
      expect(other.trustedAt).not.toBe(marker.trustedAt)
    })

    it('合并保留用户在 hooks.json 里的既有条目与其他顶层键', () => {
      // ~/.cursor/hooks.json 是用户自己的文件（本机实测已被另一个工具写满八个事件）。整文件覆盖
      // 会毁掉它，所以断言的是真实合并结果，而不只是 merge 策略的名字。
      const existing = JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: '/usr/local/bin/my-own-notify.sh', timeout: 5 }],
          afterFileEdit: [{ command: '/usr/local/bin/format.sh' }]
        }
      })
      const merged = JSON.parse(renderMergedHookContent(
        existing,
        plan!.mutations[0]!.content,
        plan!.mutations[0]!.merge!
      )) as { version: number; hooks: Record<string, Array<{ command: string }>> }

      expect(merged.version).toBe(1)
      // 用户自己在同一事件上的 hook 留着，且排在我们前面。
      expect(merged.hooks.stop![0]!.command).toBe('/usr/local/bin/my-own-notify.sh')
      expect(merged.hooks.stop!.some((entry) => entry.command.includes('agentmux-hook.js'))).toBe(true)
      // 我们没接的事件桶原样保留。
      expect(merged.hooks.afterFileEdit![0]!.command).toBe('/usr/local/bin/format.sh')
    })

    it('重装不累积：自有条目按 marker 清扫后只剩一份', () => {
      const once = renderMergedHookContent(null, plan!.mutations[0]!.content, plan!.mutations[0]!.merge!)
      const twice = renderMergedHookContent(once, plan!.mutations[0]!.content, plan!.mutations[0]!.merge!)
      expect(twice).toBe(once)
    })
  })

  describe('launch 与 resume 的 argv 精确', () => {
    it('prompt 仍是位置参数，排在解析出的旗标之后', () => {
      expect(cursor.buildLaunch({
        workspacePath: '/repo', prompt: 'review this', args: ['--force'], env: {}
      })).toEqual({ command: 'cursor-agent', args: ['--force', 'review this'], env: {} })
    })

    it('argv 恰为 cursor-agent --resume <chat-id>，prompt 仍在位置上', () => {
      expect(cursor.buildResumeLaunch({
        workspacePath: '/repo',
        nativeHandle: {
          kind: 'provider', providerId: 'cursor', sessionId: '1e4a82bfaa200bac535ca351cd388615'
        },
        prompt: 'keep going',
        args: ['--mode', 'plan'],
        env: {}
      })).toEqual({
        command: 'cursor-agent',
        args: ['--resume', '1e4a82bfaa200bac535ca351cd388615', '--mode', 'plan', 'keep going'],
        env: {}
      })
    })

    it('handle 属于别家时拒绝，并说清卡在哪且不泄露会话 id', () => {
      let error: AgentMuxError | undefined
      try {
        cursor.buildResumeLaunch({
          workspacePath: '/repo',
          nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'not-cursor' },
          args: [], env: {}
        })
      } catch (thrown) { error = thrown as AgentMuxError }
      expect(error?.code).toBe('INVALID_NATIVE_SESSION_HANDLE')
      expect(error?.detail).toContain('expectedProviderId=cursor')
      expect(error?.detail).not.toContain('not-cursor')
    })
  })
})

import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { applyAgentTimelineMutation } from '../src/session-timeline.js'
import type { AgentTimelineMutation } from '../src/types.js'

function itemOf(mutation: AgentTimelineMutation | undefined) {
  if (!mutation || mutation.type === 'update') throw new Error('expected a landed item')
  return mutation.item
}

afterEach(() => {
  vi.useRealTimers()
})

describe('native hook normalization', () => {
  const providers = new AgentProviderRegistry()

  it('maps Codex request_user_input to waiting with native provenance', () => {
    const event = providers.get('codex').normalizeHook({
      receiptId: 'receipt-1',
      agentSessionId: 'semantic-1',
      runId: 'daemon-1',
      providerId: 'codex',
      eventName: 'PreToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: { question: 'Ship it?' },
        session_id: 'codex-native-1'
      }
    }, {})
    expect(event.status).toMatchObject({ state: 'waiting', source: 'native-hook' })
    expect(event.timeline[0]).toMatchObject({
      type: 'append',
      item: { id: 'daemon-1:receipt-1:0', kind: 'permission', toolName: 'request_user_input' }
    })
    expect(event.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'codex-native-1'
    })
  })

  it('Pi 没有等待用户的工具——ask_user_question 判 working，不是 blocked', () => {
    // 这条以前断言 blocked。那条规则押的工具在 Pi 里**根本不存在**：内置工具就是
    // bash/edit/find/grep/ls/powershell/read/write 八个（上游 `core/tools/` 目录），仓库里
    // `AskUserQuestion` 的出现全在一张 **Claude Code** 的工具名映射表里
    // （`packages/ai/src/api/anthropic-messages.ts:89`），与 Pi 自己的工具集无关。
    //
    // 旧测试自己构造了一个 Pi 永远不会发的负载，所以它证明的是"规则能匹配"，不是"Pi 会发"——
    // 一条恒真的自证。规则删掉后这里改成守反向：即使收到这样一个负载，也按普通工具调用判 working。
    const event = providers.get('pi').normalizeHook({
      receiptId: 'receipt-2',
      agentSessionId: 'semantic-2',
      runId: 'daemon-2',
      providerId: 'pi',
      eventName: 'tool_call',
      payload: {
        tool_name: 'ask_user_question',
        session_id: 'pi-native-1',
        session_file: fixturePath("tmp/pi-session.jsonl")
      }
    }, {})
    expect(event.semanticState).toBe('working')
    // handle 的两个字段仍照常抽出来——删规则不该影响 native handle 这条正交的路。
    expect(event.nativeHandle).toMatchObject({ transcriptPath: fixturePath("tmp/pi-session.jsonl") })
  })

  it('rejects unsafe ids and preserves valid identity without promoting a relative transcript path', () => {
    const codex = providers.get('codex').normalizeHook({
      receiptId: 'unsafe-id',
      agentSessionId: 'semantic-unsafe',
      runId: 'run-unsafe-id',
      providerId: 'codex',
      eventName: 'SessionStart',
      payload: { session_id: '-resume-me' }
    }, {})
    expect(codex.nativeHandle).toBeUndefined()

    const pi = providers.get('pi').normalizeHook({
      receiptId: 'relative-path',
      agentSessionId: 'semantic-relative',
      runId: 'run-relative-path',
      providerId: 'pi',
      eventName: 'agent_start',
      payload: {
        session_id: 'pi-native-relative',
        session_file: 'sessions/current.jsonl'
      }
    }, {})
    expect(pi.nativeHandle).toEqual({ kind: 'provider', providerId: 'pi', sessionId: 'pi-native-relative' })
  })

  it('treats a Hook retry with only a later observation time as idempotent', () => {
    vi.useFakeTimers()
    const envelope = {
      receiptId: 'reused-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex' as const,
      eventName: 'Stop',
      payload: { last_assistant_message: 'Finished the task.' }
    }
    vi.setSystemTime(10)
    const first = providers.get('codex').normalizeHook(envelope, {})
    vi.setSystemTime(20)
    const retry = providers.get('codex').normalizeHook(envelope, {})
    const resumed = providers.get('codex').normalizeHook({ ...envelope, runId: 'run-2' }, {})

    expect(first.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-1:reused-receipt:0' } })
    expect(retry.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-1:reused-receipt:0' } })
    expect(resumed.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-2:reused-receipt:0' } })
    expect(first.timeline[0]).not.toEqual(retry.timeline[0])

    const once = applyAgentTimelineMutation([], first.timeline[0]!)
    expect(applyAgentTimelineMutation(once, retry.timeline[0]!)).toEqual(once)
  })

  it('rejects a reused Hook identity with different semantic content', () => {
    vi.useFakeTimers()
    const envelope = {
      receiptId: 'conflicting-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex' as const,
      eventName: 'Stop',
      payload: { last_assistant_message: 'First result' }
    }
    const first = providers.get('codex').normalizeHook(envelope, {})
    const conflicting = providers.get('codex').normalizeHook({
      ...envelope,
      payload: { last_assistant_message: 'Different result' }
    }, {})

    const once = applyAgentTimelineMutation([], first.timeline[0]!)
    expect(() => applyAgentTimelineMutation(once, conflicting.timeline[0]!))
      .toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_ID_CONFLICT' }))
  })

  it('leaves user Prompt ownership to the Core launch and send paths', () => {
    const event = providers.get('codex').normalizeHook({
      receiptId: 'prompt-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'UserPromptSubmit',
      payload: { prompt: 'Do not duplicate this Prompt.' }
    }, {})

    // `event.timeline` 空了的话，下面那条 `some(...)===false` 照样绿——而 normalizeHook
    // 对 UserPromptSubmit 什么都不产出，比「多产出了一条 user_message」更值得红：这条测试名说的是
    // 「Prompt 的归属留给 Core」，不是「这个事件不进 timeline」。所以先把产出钉死：一条 lifecycle。
    expect(event.timeline, 'normalizeHook 对 UserPromptSubmit 的产出变了').toHaveLength(1)
    expect(event.timeline[0]).toMatchObject({ type: 'append', item: { kind: 'lifecycle' } })
    expect(event.timeline.some(
      (mutation) => mutation.type === 'append' && mutation.item.kind === 'user_message'
    )).toBe(false)
  })

  it('does not invent semantic work from an unknown event', () => {
    const event = providers.get('traex').normalizeHook({
      receiptId: 'receipt-3',
      agentSessionId: 'semantic-3',
      runId: 'daemon-3',
      providerId: 'traex',
      eventName: 'tick'
    }, {})
    expect(event.semanticState).toBe('unknown')
    expect(event.status).toMatchObject({ state: 'running', source: 'native-hook' })
  })

  /**
   * 接线层。采集规则再对，normalizer 不去调它、或调了不把结果放进 item，整个功能就是死的——
   * 而只测 Provider 结果贡献的用例仍会全绿。本仓库这一季反复栽在这个位置，所以这几条专守接线。
   */
  describe('工具结果进时间轴', () => {
    const post = (payload: Record<string, unknown>, eventName = 'PostToolUse') =>
      providers.get('claude').normalizeHook({
        receiptId: 'receipt-out',
        agentSessionId: 'semantic-out',
        runId: 'run-out',
        providerId: 'claude',
        eventName,
        payload
      }, {})

    const item = (event: ReturnType<typeof post>) => {
      const mutation = event.timeline[0]
      if (!mutation || mutation.type !== 'append') throw new Error('expected an appended item')
      return mutation.item
    }

    it('把 PostToolUse 的输出带进 item，而不只是入参', () => {
      const appended = item(post({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'total 24'
      }))
      expect(appended.toolOutput).toBe('total 24')
      expect(appended.toolInput).toContain('ls')
    })

    it('失败的命令和成功的命令在 item 上就不一样——这是本 task 的全部理由', () => {
      const failed = item(post({
        tool_name: 'Bash',
        tool_input: { command: 'exit 1' },
        error: 'command failed'
      }, 'PostToolUseFailure'))
      const succeeded = item(post({
        tool_name: 'Bash',
        tool_input: { command: 'exit 0' },
        tool_response: 'ok'
      }))
      expect(failed.status).toBe('failed')
      expect(succeeded.status).toBe('complete')
      // 状态相同即等于没做——这条不许被"两边都 complete"糊弄过去。
      expect(failed.status).not.toBe(succeeded.status)
    })

    it('PreToolUse 不带结果——那时候还没有成败可言，盖任何结论都是编造', () => {
      const appended = item(post({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        // 就算负载里混进了结果字段，事前事件也不该采信。
        tool_response: { is_error: true }
      }, 'PreToolUse'))
      expect(appended.toolOutput).toBeUndefined()
      expect(appended.status).toBe('complete')
    })

    it('没有结果的历史条目照常成立，不因为新字段缺席就报错或塞空壳', () => {
      const appended = item(post({ tool_name: 'Read', tool_input: { file_path: fixturePath("a.ts") } }))
      expect(appended.status).toBe('complete')
      expect(Object.hasOwn(appended, 'toolOutput')).toBe(false)
    })

    it('结果穿得过时间轴校验，不是只在 normalizer 内部成立', () => {
      // Core 合同的另一半：normalizer 造得出，`applyAgentTimelineMutation` 却认不得，就等于没接上。
      const event = post({
        tool_name: 'Bash',
        tool_input: { command: 'exit 1' },
        error: 'boom'
      }, 'PostToolUseFailure')
      const items = applyAgentTimelineMutation([], event.timeline[0]!)
      expect(items[0]).toMatchObject({ toolOutput: 'boom', status: 'failed' })
    })

    // Canonical end enables the originating Provider's own outcome. Hermes
    // emits result/status in raw.extra; Pi's generated end emits neither.
    it('Hermes 的 post_tool_call 带得出结果与失败态，不再因命名法被判成事前', () => {
      const hermes = (payload: Record<string, unknown>, eventName: string) =>
        providers.get('hermes').normalizeHook({
          receiptId: `receipt-hermes-${eventName}`,
          agentSessionId: 'semantic-hermes',
          runId: 'run-hermes',
          providerId: 'hermes',
          eventName,
          payload
        }, {})

      const failed = hermes({
        tool_name: 'shell',
        tool_input: { command: 'exit 1' },
        extra: { status: 'error', result: 'boom', error_message: 'tool failed' }
      }, 'post_tool_call')
      const succeeded = hermes({
        tool_name: 'shell',
        tool_input: { command: 'exit 0' },
        extra: { status: 'ok', result: 'ok' }
      }, 'post_tool_call')

      expect(failed.lifecycleEvent).toBe('tool-use-end')
      const failedItem = item(failed as ReturnType<typeof post>)
      const okItem = item(succeeded as ReturnType<typeof post>)
      expect(failedItem.status).toBe('failed')
      expect(okItem.status).toBe('complete')
      expect(failedItem.status).not.toBe(okItem.status)
      expect(okItem.toolOutput).toBe('ok')

      // 事前那条照旧不采结果：归一化没有把「所有 snake_case 都当事后」。
      const before = hermes({
        tool_name: 'shell',
        tool_input: { command: 'ls' },
        extra: { status: 'error', result: 'must not be sampled before execution' }
      }, 'pre_tool_call')
      expect(before.lifecycleEvent).toBe('tool-use-start')
      expect(item(before as ReturnType<typeof post>).toolOutput).toBeUndefined()
    })

    // Hermes sends result/status/call ID in raw.extra. Results are Provider-owned;
    // the existing global nesting/ID behavior remains separately protected here.
    it('Hermes 的事件专属字段藏在 extra 子对象里也读得出——这才是它真实的两层形状', () => {
      // `update` 那一支不带 item，故必须显式收窄：不收窄时 vitest 照旧全绿而 tsc 退 2。
      const landed = (event: { timeline: readonly AgentTimelineMutation[] }) => {
        const mutation = event.timeline[0]
        if (!mutation || (mutation.type !== 'append' && mutation.type !== 'upsert')) {
          throw new Error('expected an appended or upserted item')
        }
        return mutation.item
      }

      const hermesNested = (eventName: string, extra: Record<string, unknown>, receiptId = `receipt-hermes-nested-${eventName}`) =>
        providers.get('hermes').normalizeHook({
          receiptId,
          agentSessionId: 'semantic-hermes-nested',
          runId: 'run-hermes-nested',
          providerId: 'hermes',
          eventName,
          // 顶层只放 Hermes 真的会放在顶层的那几个键。成败/正文/关联 id 一律只在 extra 里——
          // 任何一个也摊到顶层，这条就退化成上面那几条已有的用例，判不出解包有没有发生。
          payload: {
            session_id: 'sess-hermes-nested',
            tool_name: 'shell',
            tool_input: { command: 'exit 1' },
            extra
          }
        }, {})

      const failed = hermesNested('post_tool_call', {
        status: 'error', result: 'boom',
        tool_call_id: 'call_NESTED'
      })
      const failedItem = landed(failed)

      // 1. 失败读得出来。不读取原 extra.status 时失败事实不可见，这一步会收敛成 complete——
      //    一条挂了的命令和一条跑成的命令在时间轴上逐字相同。
      expect(failedItem.status).toBe('failed')
      // 2. 输出带得出来。原 result 也只在 extra 里，正文整段丢失。
      expect(failedItem.toolOutput).toBe('boom')
      // Hermes 尚未声明原生身份资格；调用 ID 不能单独晋升为跨事件关联。
      expect(failed.timeline[0]!.type).toBe('append')
      expect(failedItem.id).toBe('run-hermes-nested:receipt-hermes-nested-post_tool_call:0')

      // 成功那侧独立承重：只钉失败时，把解包改成「无论如何都判 failed」也能全绿。
      const succeeded = hermesNested('post_tool_call', {
        status: 'ok', result: 'ok',
        tool_call_id: 'call_NESTED_OK'
      }, 'receipt-hermes-success')
      const okItem = landed(succeeded)
      expect(okItem.status).toBe('complete')
      expect(okItem.toolOutput).toBe('ok')
      expect(okItem.id).toBe('run-hermes-nested:receipt-hermes-success:0')
      expect(okItem.id).not.toBe(failedItem.id)

      // 顶层优先：`extra` 只补顶层没说的那些，不许反过来盖掉 Hermes 自己声明的固定位。
      const topLevelWins = providers.get('hermes').normalizeHook({
        receiptId: 'receipt-hermes-precedence',
        agentSessionId: 'semantic-hermes-nested',
        runId: 'run-hermes-nested',
        providerId: 'hermes',
        eventName: 'post_tool_call',
        payload: {
          tool_name: 'shell',
          tool_input: { command: 'ls' },
          extra: { tool_name: 'from-extra', status: 'ok', result: 'ok' }
        }
      }, {})
      expect(landed(topLevelWins).toolName).toBe('shell')
    })

    it('Pi 的原 extension end 没有结果与失败，仍由 canonical end 进入完成条目', () => {
      const pi = (eventName: string, values: Record<string, unknown> = {}) => providers.get('pi').normalizeHook({
        receiptId: `receipt-pi-${eventName}`, agentSessionId: 'semantic-pi', runId: 'run-pi-tool',
        providerId: 'pi', eventName, payload: { session_id: 'pi-tool-native', tool_name: 'bash', ...values }
      }, {})
      const ended = pi('tool_execution_end')
      expect(ended.lifecycleEvent).toBe('tool-use-end')
      expect(item(ended)).toMatchObject({ status: 'complete', toolName: 'bash' })
      expect(item(ended).toolOutput).toBeUndefined()
      expect(item(pi('tool_execution_end', { tool_response: { is_error: true, stderr: 'foreign' } })).status).toBe('complete')
      expect(pi('tool_execution_start', { tool_input: { command: 'ls' } }).lifecycleEvent).toBe('tool-use-start')
    })

    it('Antigravity 的 PostInvocation 不是工具结果，尽管它以 Post 开头', () => {
      // 形状推理在这里答错：PostInvocation 是一次调用的外层收尾，不是一次工具调用的结果。
      const event = providers.get('antigravity').normalizeHook({
        receiptId: 'receipt-agy-postinv',
        agentSessionId: 'semantic-agy',
        runId: 'run-agy-postinv',
        providerId: 'antigravity',
        eventName: 'PostInvocation',
        payload: { tool_name: 'browser', tool_input: { url: 'x' }, tool_response: { is_error: true } }
      }, {})
      expect(event.lifecycleEvent).toBeUndefined()
      // 没有 canonical 依据就不宣称「已经有结果了」——结果字段不被采信。
      expect(item(event as ReturnType<typeof post>).toolOutput).toBeUndefined()
    })
  })

  /**
   * 一次工具调用就是一行：`tool_use_id` 把 Pre/Post 关联成同一条 item。
   *
   * 这是本 task 的承重接线：Pre 落在途态（streaming）、Post 发 `update` 翻成终态并挂结果，
   * 两端用 `runId:tool:<id>` 命中同一条。只测采集或只测折叠都够不到这里——normalizer 不把
   * id 绑对、或事后不发 update 而是又 append 一条，整个功能就是死的，而那些用例照样全绿。
   */
  describe('Pre/Post 关联成一条', () => {
    const claude = (payload: Record<string, unknown>, eventName: string, receiptId: string) =>
      providers.get('claude').normalizeHook({
        receiptId,
        agentSessionId: 'semantic-corr',
        runId: 'run-corr',
        providerId: 'claude',
        eventName,
        payload: {
          session_id: 'sess-corr',
          ...payload
        }
      }, {})

    it('PreToolUse 带 tool_use_id 时落在途态，item id 绑调用 id 而不是 receiptId', () => {
      const event = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC' },
        'PreToolUse',
        'receipt-pre'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('append')
      if (mutation?.type !== 'append') throw new Error('expected append')
      // id 必须来自调用 id——绑 receiptId（receipt-pre）就永远关联不上 Post，功能即死。
      expect(mutation.item.id).not.toContain('receipt-pre')
      // 在途态：hook 驱动的 Agent 由此第一次点亮 Streaming 徽标。
      expect(mutation.item.status).toBe('streaming')
    })

    it('PostToolUse 带同一 tool_use_id 时发 upsert 命中 Pre 那条，不再 append 第二条', () => {
      const pre = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC' },
        'PreToolUse',
        'receipt-pre'
      )
      const event = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC', tool_response: 'total 24' },
        'PostToolUse',
        'receipt-post'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('upsert')
      if (mutation?.type !== 'upsert') throw new Error('expected upsert')
      expect(mutation.item.id).toBe(itemOf(pre.timeline[0]).id)
      expect(mutation.item.status).toBe('complete')
      expect(mutation.item.toolOutput).toBe('total 24')
    })

    it('端到端：一次调用在时间轴上是一条，经历 streaming → complete', () => {
      const pre = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_END' },
        'PreToolUse',
        'receipt-pre'
      )
      const post = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_END', tool_response: 'ok' },
        'PostToolUse',
        'receipt-post'
      )
      const afterPre = applyAgentTimelineMutation([], pre.timeline[0]!)
      expect(afterPre).toHaveLength(1)
      expect(afterPre[0]).toMatchObject({ status: 'streaming' })
      const afterPost = applyAgentTimelineMutation(afterPre, post.timeline[0]!)
      // 一条，不是两条——这是本 task 的全部理由。
      expect(afterPost).toHaveLength(1)
      expect(afterPost[0]).toMatchObject({ status: 'complete', toolOutput: 'ok' })
    })

    it('端到端：失败的 Post 把那一条翻成 failed，而不是新增一条', () => {
      const pre = claude(
        { tool_name: 'Bash', tool_input: { command: 'exit 1' }, tool_use_id: 'toolu_FAIL' },
        'PreToolUse',
        'receipt-pre'
      )
      const post = claude(
        {
          tool_name: 'Bash',
          tool_input: { command: 'exit 1' },
          tool_use_id: 'toolu_FAIL',
          error: 'boom'
        },
        'PostToolUseFailure',
        'receipt-post'
      )
      const items = applyAgentTimelineMutation(
        applyAgentTimelineMutation([], pre.timeline[0]!),
        post.timeline[0]!
      )
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ status: 'failed', toolOutput: 'boom' })
    })

    it('丢了 Pre：Post 的 upsert 目标不存在时补落一条终态行，不抛错吞掉整条 hook 事件', () => {
      // major 复现路径之一：PreToolUse 的两次 fetch 都失败（binding 短暂 503/超时），Pre 永不落库。
      // 稍后 Post 成功到达——它的 upsert 命不中目标。修复前用 update 会抛 UNKNOWN_AGENT_TIMELINE_ITEM，
      // 冒泡出 client 的 timeline 循环、跳过 publishHook、这一步的结果与完成态永久丢失（503）。
      // 现在：只喂 Post（模拟 Pre 从未落库），直接对空时间轴 apply，必须不抛且如实补落。
      const post = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_LOSTPRE', tool_response: 'recovered' },
        'PostToolUse',
        'receipt-post-only'
      )
      const mutation = post.timeline[0]
      expect(mutation?.type).toBe('upsert')
      // 承重断言：对**空**时间轴 apply 这条 Post，绝不抛。变异守卫：把实现里 upsert 的 index<0 分支
      // 改回 `throw UNKNOWN_AGENT_TIMELINE_ITEM`，这条立即变红。
      expect(() => applyAgentTimelineMutation([], mutation!)).not.toThrow()
      const items = applyAgentTimelineMutation([], mutation!)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        kind: 'tool_call',
        status: 'complete',
        toolOutput: 'recovered'
      })
      expect(items[0]!.id).not.toContain('receipt-post-only')
    })

    it('Pre 被 200 上限逐出：Post 的 upsert 命不中时补落，而不是把子代理场景打成 503', () => {
      // major 复现路径之二：父 Task 的 Pre 落一条 streaming 后，子代理在 Pre/Post 之间于同一时间轴上
      // 发 ≥200 条工具事件，把父 Pre 挤出 200 上限。父 Post 到达时目标已被逐出——upsert 补落即可，
      // update 会抛。这里用真正的 applyAgentTimelineMutation 造出「Pre 被逐出」的真实状态。
      const parentPre = claude(
        { tool_name: 'Task', tool_input: { subagent_type: 'Explore' }, tool_use_id: 'toolu_PARENT' },
        'PreToolUse',
        'receipt-parent-pre'
      )
      const parentId = itemOf(parentPre.timeline[0]).id
      let items = applyAgentTimelineMutation([], parentPre.timeline[0]!)
      expect(items).toHaveLength(1)
      expect(items.some((item) => item.id === parentId)).toBe(true)
      // 子代理灌满 200 条，把父 Pre 挤出去。
      for (let index = 0; index < 200; index += 1) {
        const child = claude(
          { tool_name: 'Bash', tool_input: { command: `echo ${index}` }, tool_use_id: `toolu_CHILD_${index}` },
          'PreToolUse',
          `receipt-child-${index}`
        )
        items = applyAgentTimelineMutation(items, child.timeline[0]!)
      }
      expect(items).toHaveLength(200)
      expect(items.some((item) => item.id === parentId)).toBe(false)
      // 父 Post 到达：目标已被逐出。upsert 必须补落而不抛。
      const parentPost = claude(
        { tool_name: 'Task', tool_input: { subagent_type: 'Explore' }, tool_use_id: 'toolu_PARENT', tool_response: 'subagent done' },
        'PostToolUse',
        'receipt-parent-post'
      )
      expect(() => applyAgentTimelineMutation(items, parentPost.timeline[0]!)).not.toThrow()
      const after = applyAgentTimelineMutation(items, parentPost.timeline[0]!)
      expect(after.find((item) => item.id === parentId)).toMatchObject({
        status: 'complete',
        toolOutput: 'subagent done'
      })
    })

    it('Provider 不给调用 id 时如实退回 append-only，Post 是 append 不是 update，不伪造关联', () => {
      const post = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' },
        'PostToolUse',
        'receipt-noid'
      )
      const mutation = post.timeline[0]
      expect(mutation?.type).toBe('append')
      if (mutation?.type !== 'append') throw new Error('expected append')
      // 退回旧的 receiptId 派生 id——没有关联依据就不造关联。
      expect(mutation.item.id).toBe('run-corr:receipt-noid:0')
      // 无关联时结果仍带上，靠渲染层折叠让带结果的那行胜出。
      expect(mutation.item).toMatchObject({ status: 'complete', toolOutput: 'ok' })
    })

    it('等待用户的 permission 行即使带 id 也不走 update 通路——它不是一次会收敛的工具执行', () => {
      // Claude 的 askuserquestion 在 PreToolUse 上判 waiting，落 permission 行。它等的是用户，
      // 不是一次有 Post 收尾的执行，所以必须留在 append-only，不能被当作在途工具压成 streaming。
      const event = claude(
        { tool_name: 'askuserquestion', tool_input: { question: 'ok?' }, tool_use_id: 'toolu_ASK' },
        'PreToolUse',
        'receipt-ask'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('append')
      if (mutation?.type !== 'append') throw new Error('expected append')
      expect(mutation.item.kind).toBe('permission')
      expect(mutation.item.status).toBe('complete')
      expect(mutation.item.id).toBe('run-corr:receipt-ask:0')
    })

    it('askuserquestion 的 PostToolUse 也是 append 不是 update——kind 认工具身份而非当前事件 state', () => {
      // 回归守卫：Post 的当前 state 是 working，若按 state 定 kind 会被判成 tool_call，去 update 一条
      // `run:tool:toolu_ASK`——而 Pre 落的是 permission 行、id 是 receiptId 派生的，从没按 tool 关联过。
      // 那样 applyTimelineMutation 会抛 UNKNOWN_AGENT_TIMELINE_ITEM，把用户每次答题都变成 503+丢答复。
      const event = claude(
        { tool_name: 'askuserquestion', tool_input: { question: 'ok?' }, tool_use_id: 'toolu_ASK', tool_response: 'answered' },
        'PostToolUse',
        'receipt-ask-post'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('append')
      if (mutation?.type !== 'append') throw new Error('expected append')
      expect(mutation.item.kind).toBe('permission')
      // 关键：绝不能是 `run-corr:tool:toolu_ASK`——那是 Pre 从没落过的关联 id。
      expect(mutation.item.id).toBe('run-corr:receipt-ask-post:0')
    })

    it('端到端：askuserquestion 的 Pre→Post 都能落进时间轴，不抛 UNKNOWN_AGENT_TIMELINE_ITEM', () => {
      // 这条是 blocker 的直接复现：把 Pre、Post 依次喂给真正的时间轴校验器。修复前 Post 会走 update
      // 命中不存在的 item 抛错；修复后两条都是 append，各自成行、互不冲突。
      const pre = claude(
        { tool_name: 'askuserquestion', tool_input: { question: 'ship?' }, tool_use_id: 'toolu_ASK' },
        'PreToolUse',
        'receipt-ask-pre'
      )
      const post = claude(
        { tool_name: 'askuserquestion', tool_input: { question: 'ship?' }, tool_use_id: 'toolu_ASK', tool_response: 'yes' },
        'PostToolUse',
        'receipt-ask-post'
      )
      const afterPre = applyAgentTimelineMutation([], pre.timeline[0]!)
      expect(() => applyAgentTimelineMutation(afterPre, post.timeline[0]!)).not.toThrow()
    })
  })

})

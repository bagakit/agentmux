import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { releaseSubagentRoster } from '../src/hook-normalizer.js'
import { applyAgentTimelineMutation } from '../src/session-timeline.js'

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
    })
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

  it('maps Pi ask_user_question to blocked', () => {
    const event = providers.get('pi').normalizeHook({
      receiptId: 'receipt-2',
      agentSessionId: 'semantic-2',
      runId: 'daemon-2',
      providerId: 'pi',
      eventName: 'tool_call',
      payload: {
        tool_name: 'ask_user_question',
        session_id: 'pi-native-1',
        session_file: '/tmp/pi-session.jsonl'
      }
    })
    expect(event.semanticState).toBe('blocked')
    expect(event.nativeHandle).toMatchObject({ transcriptPath: '/tmp/pi-session.jsonl' })
  })

  it('does not promote unsafe ids or relative transcript paths to verified handles', () => {
    const codex = providers.get('codex').normalizeHook({
      receiptId: 'unsafe-id',
      agentSessionId: 'semantic-unsafe',
      runId: 'run-unsafe-id',
      providerId: 'codex',
      eventName: 'SessionStart',
      payload: { session_id: '-resume-me' }
    })
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
    })
    expect(pi.nativeHandle).toBeUndefined()
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
    const first = providers.get('codex').normalizeHook(envelope)
    vi.setSystemTime(20)
    const retry = providers.get('codex').normalizeHook(envelope)
    const resumed = providers.get('codex').normalizeHook({ ...envelope, runId: 'run-2' })

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
    const first = providers.get('codex').normalizeHook(envelope)
    const conflicting = providers.get('codex').normalizeHook({
      ...envelope,
      payload: { last_assistant_message: 'Different result' }
    })

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
    })

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
    })
    expect(event.semanticState).toBe('unknown')
    expect(event.status).toMatchObject({ state: 'running', source: 'native-hook' })
  })

  /**
   * 接线层。采集规则再对，normalizer 不去调它、或调了不把结果放进 item，整个功能就是死的——
   * 而只测 `hookToolOutcome` 的用例仍会全绿。本仓库这一季反复栽在这个位置，所以这几条专守接线。
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
      })

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
        tool_response: { is_error: true, stderr: 'command failed' }
      }))
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
      const appended = item(post({ tool_name: 'Read', tool_input: { file_path: '/a.ts' } }))
      expect(appended.status).toBe('complete')
      expect(Object.hasOwn(appended, 'toolOutput')).toBe(false)
    })

    it('结果穿得过时间轴校验，不是只在 normalizer 内部成立', () => {
      // Core 合同的另一半：normalizer 造得出，`applyAgentTimelineMutation` 却认不得，就等于没接上。
      const event = post({
        tool_name: 'Bash',
        tool_input: { command: 'exit 1' },
        tool_response: { is_error: true, stdout: 'boom' }
      })
      const items = applyAgentTimelineMutation([], event.timeline[0]!)
      expect(items[0]).toMatchObject({ toolOutput: 'boom', status: 'failed' })
    })

    /**
     * snake_case 的 Provider 也必须分得出成败——这是「事件名归一化」真正兑现的地方。
     *
     * 此前判据是 `eventName.startsWith('Post')`，只对 PascalCase 成立。Hermes 的 `post_tool_call`
     * 与 Pi 的 `tool_execution_end` 都读不出结果：两家都声明了 `timeline: 'complete-events'`，
     * 可一条失败的命令和一条成功的命令在时间轴上长得**一模一样**。归一化把判据换成 canonical
     * 的 `tool-use-end`，这几条就是它兑现的证据——把映射表里那两行删掉，这里立刻发红。
     */
    it('Hermes 的 post_tool_call 带得出结果与失败态，不再因命名法被判成事前', () => {
      const hermes = (payload: Record<string, unknown>, eventName: string) =>
        providers.get('hermes').normalizeHook({
          receiptId: `receipt-hermes-${eventName}`,
          agentSessionId: 'semantic-hermes',
          runId: 'run-hermes',
          providerId: 'hermes',
          eventName,
          payload
        })

      const failed = hermes({
        tool_name: 'shell',
        tool_input: { command: 'exit 1' },
        tool_response: { is_error: true, stderr: 'boom' }
      }, 'post_tool_call')
      const succeeded = hermes({
        tool_name: 'shell',
        tool_input: { command: 'exit 0' },
        tool_response: 'ok'
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
        tool_response: { is_error: true }
      }, 'pre_tool_call')
      expect(before.lifecycleEvent).toBe('tool-use-start')
      expect(item(before as ReturnType<typeof post>).toolOutput).toBeUndefined()
    })

    it('Pi 的 tool_execution_end 同样带得出结果——判据是生命周期而非名字形状', () => {
      const pi = (payload: Record<string, unknown>, eventName: string) =>
        providers.get('pi').normalizeHook({
          receiptId: `receipt-pi-${eventName}`,
          agentSessionId: 'semantic-pi',
          runId: 'run-pi-tool',
          providerId: 'pi',
          eventName,
          payload
        })

      const failed = pi({
        tool_name: 'bash',
        tool_input: { command: 'exit 2' },
        tool_response: { is_error: true, stderr: 'nope' }
      }, 'tool_execution_end')
      expect(failed.lifecycleEvent).toBe('tool-use-end')
      expect(item(failed as ReturnType<typeof post>).status).toBe('failed')

      const started = pi({ tool_name: 'bash', tool_input: { command: 'ls' } }, 'tool_execution_start')
      expect(started.lifecycleEvent).toBe('tool-use-start')
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
      })
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
        payload
      })

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
      expect(mutation.item.id).toBe('run-corr:tool:toolu_01ABC')
      expect(mutation.item.id).not.toContain('receipt-pre')
      // 在途态：hook 驱动的 Agent 由此第一次点亮 Streaming 徽标。
      expect(mutation.item.status).toBe('streaming')
    })

    it('PostToolUse 带同一 tool_use_id 时发 upsert 命中 Pre 那条，不再 append 第二条', () => {
      const event = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC', tool_response: 'total 24' },
        'PostToolUse',
        'receipt-post'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('upsert')
      if (mutation?.type !== 'upsert') throw new Error('expected upsert')
      expect(mutation.item.id).toBe('run-corr:tool:toolu_01ABC')
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
          tool_response: { is_error: true, stderr: 'boom' }
        },
        'PostToolUse',
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
        id: 'run-corr:tool:toolu_LOSTPRE',
        kind: 'tool_call',
        status: 'complete',
        toolOutput: 'recovered'
      })
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
      let items = applyAgentTimelineMutation([], parentPre.timeline[0]!)
      expect(items.some((item) => item.id === 'run-corr:tool:toolu_PARENT')).toBe(true)
      // 子代理灌满 200 条，把父 Pre 挤出去。
      for (let index = 0; index < 200; index += 1) {
        const child = claude(
          { tool_name: 'Bash', tool_input: { command: `echo ${index}` }, tool_use_id: `toolu_CHILD_${index}` },
          'PreToolUse',
          `receipt-child-${index}`
        )
        items = applyAgentTimelineMutation(items, child.timeline[0]!)
      }
      expect(items.some((item) => item.id === 'run-corr:tool:toolu_PARENT')).toBe(false)
      // 父 Post 到达：目标已被逐出。upsert 必须补落而不抛。
      const parentPost = claude(
        { tool_name: 'Task', tool_input: { subagent_type: 'Explore' }, tool_use_id: 'toolu_PARENT', tool_response: 'subagent done' },
        'PostToolUse',
        'receipt-parent-post'
      )
      expect(() => applyAgentTimelineMutation(items, parentPost.timeline[0]!)).not.toThrow()
      const after = applyAgentTimelineMutation(items, parentPost.timeline[0]!)
      expect(after.find((item) => item.id === 'run-corr:tool:toolu_PARENT')).toMatchObject({
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

  /**
   * 子代理还在跑时，主 Agent 的 done 不算数。
   *
   * SubagentStart 被平铺映射成 working、Stop 被照单全收判成 done——于是主 Agent 报 Stop 时即便子代理
   * 还在干活，界面也会提前翻成完成、误报完成通知。这里按会话记在途计数，任一子代理存活就把主 Stop
   * 压成 working，全部结束后才收敛 done。
   *
   * 花名册是进程级跨事件状态，所以每条用例用**互不相同**的 runId，避免相互串味。
   */
  describe('子代理在途压制主 done', () => {
    const claudeRun = (runId: string) =>
      (eventName: string, payload: Record<string, unknown>, receiptId = `r-${eventName}-${Math.random()}`) =>
        providers.get('claude').normalizeHook({
          receiptId,
          agentSessionId: `sess-${runId}`,
          runId,
          providerId: 'claude',
          eventName,
          payload
        })

    it('子代理存活时，主 Agent 的 Stop 被压成 working 而不是 done', () => {
      const hook = claudeRun('run-suppress')
      hook('SubagentStart', { agent_id: 'sub-1', agent_type: 'Explore' })
      const stop = hook('Stop', { last_assistant_message: 'All done.' })
      // 主 Agent 说完成了，但子代理还在跑——不许翻成 done。
      expect(stop.semanticState).toBe('working')
      expect(stop.status.state).toBe('working')
    })

    it('两个子代理，只结束一个时主 Stop 仍被压住', () => {
      const hook = claudeRun('run-partial')
      hook('SubagentStart', { agent_id: 'a' })
      hook('SubagentStart', { agent_id: 'b' })
      hook('SubagentStop', { agent_id: 'a' })
      const stop = hook('Stop', { last_assistant_message: 'done?' })
      expect(stop.semanticState).toBe('working')
    })

    it('子代理全部结束后，主 Agent 正常收敛到 done', () => {
      const hook = claudeRun('run-converge')
      hook('SubagentStart', { agent_id: 'only' })
      const stopWhileAlive = hook('Stop', { last_assistant_message: 'wait' })
      expect(stopWhileAlive.semanticState).toBe('working')
      // 最后一个子代理落地——此刻兑现之前被压住的收尾，而不是卡在 working 出不来。
      const lastStop = hook('SubagentStop', { agent_id: 'only' })
      expect(lastStop.semanticState).toBe('done')
    })

    it('没有子代理时，主 Agent 的 Stop 照旧直接判 done——压制不误伤常规收尾', () => {
      const hook = claudeRun('run-nosubs')
      const stop = hook('Stop', { last_assistant_message: 'finished' })
      expect(stop.semanticState).toBe('done')
      expect(stop.status.state).toBe('done')
    })

    it('子代理结束但主 Agent 尚未收尾时，停在 working 不擅自判 done', () => {
      const hook = claudeRun('run-noStopYet')
      hook('SubagentStart', { agent_id: 'x' })
      const subStop = hook('SubagentStop', { agent_id: 'x' })
      // 主 turn 还没结束（没有 Stop pending），子代理归零不该独自宣布完成。
      expect(subStop.semanticState).toBe('working')
    })

    it('重复投递的 SubagentStart（同一 agent_id）幂等，不会虚增在途数', () => {
      const hook = claudeRun('run-dupe')
      hook('SubagentStart', { agent_id: 'dup' }, 'same-receipt')
      hook('SubagentStart', { agent_id: 'dup' }, 'same-receipt')
      // 只结束一次就应归零——若按裸计数器实现，这里会残留 1 个在途，主 Stop 被永远压住。
      hook('SubagentStop', { agent_id: 'dup' })
      const stop = hook('Stop', { last_assistant_message: 'ok' })
      expect(stop.semanticState).toBe('done')
    })

    it('Codex 同样按 agent_id 记账压制主 Stop', () => {
      const codex = (eventName: string, payload: Record<string, unknown>) =>
        providers.get('codex').normalizeHook({
          receiptId: `cx-${eventName}-${Math.random()}`,
          agentSessionId: 'sess-codex-sub',
          runId: 'run-codex-sub',
          providerId: 'codex',
          eventName,
          payload
        })
      codex('SubagentStart', { agent_id: 'cx-1', agent_type: 'reviewer' })
      const stop = codex('Stop', { last_assistant_message: 'done' })
      expect(stop.semanticState).toBe('working')
      const converge = codex('SubagentStop', { agent_id: 'cx-1' })
      expect(converge.semanticState).toBe('done')
    })

    it('花名册按 runId 隔离：另一个 run 的子代理不会压住本 run 的 Stop', () => {
      const other = claudeRun('run-other')
      other('SubagentStart', { agent_id: 'foreign' })
      // 本 run 自己没有子代理，Stop 应正常 done，不被别的 run 的在途污染——若 roster key 把并发的
      // run 混成一格，foreign 会压住这里，断言随即变红。
      const mine = claudeRun('run-mine')
      const stop = mine('Stop', { last_assistant_message: 'ok' })
      expect(stop.semanticState).toBe('done')
    })

    it('run 进程退出清掉花名册：子代理事件丢失后不再永久泄漏、也不永久压住主 Stop', () => {
      // major 修复：子代理被杀 / SubagentStop 永不投递时，只靠 SubagentStop 归零的 happy path 走不到，
      // 花名册那条 id 永不删除。releaseSubagentRoster 是 run 进程退出时的终结路径（client.acceptKernelEvent
      // 在 exit 事件里调它）。这里断言：release 后同一 runId 的记账被彻底清空——真删掉过才返回 true，
      // 且此后该 run 的 Stop 不再被幽灵子代理压制。
      const hook = claudeRun('run-lost-substop')
      hook('SubagentStart', { agent_id: 'ghost' })
      const suppressed = hook('Stop', { last_assistant_message: 'main thinks it is done' })
      expect(suppressed.semanticState).toBe('working')
      // 进程退出：清账。返回 true 证明确实有一条被清除（而非空操作）。
      expect(releaseSubagentRoster('run-lost-substop')).toBe(true)
      // 清完再无残留：重复清返回 false。
      expect(releaseSubagentRoster('run-lost-substop')).toBe(false)
      // 花名册已空，此后同 runId 的 Stop 不再被 ghost 压住，正常收敛。
      const afterRelease = hook('Stop', { last_assistant_message: 'settled' })
      expect(afterRelease.semanticState).toBe('done')
    })

    it('releaseSubagentRoster 只清指定 runId，不误伤并发 run 的在途', () => {
      const victim = claudeRun('run-keep')
      victim('SubagentStart', { agent_id: 'still-alive' })
      // 清另一个不相干的 run 不该动到本 run。
      expect(releaseSubagentRoster('run-unrelated')).toBe(false)
      const stop = victim('Stop', { last_assistant_message: 'main done' })
      // still-alive 仍在册，主 Stop 照旧被压住。
      expect(stop.semanticState).toBe('working')
      // 收尾：正常路径归零，避免给后续用例留脏账。
      victim('SubagentStop', { agent_id: 'still-alive' })
    })

    it('花名册归零后迟到/重投的 SubagentStop 落中性 unknown，不把已 done 的主 Agent 翻回 working', () => {
      // minor 修复：最后一个 SubagentStop 首投已收敛 done 并删掉 roster；它的网络重投（服务端已处理、
      // 客户端 2s 超时又发同一条）再次进入 normalizer 时 roster 已不存在。此前硬编码返回 'working'，
      // 会被 client 落库并发布，把刚 done 的主 Agent 翻回运行中——归零后迟到的 stop 成了反向假信号。
      // 现在退回 baseState：SubagentStop 无匹配 rule，baseState 即 'unknown'，落点中性、client 不落库。
      const hook = claudeRun('run-late-substop')
      hook('SubagentStart', { agent_id: 'only' })
      hook('Stop', { last_assistant_message: 'main thinks done' }) // 被压住
      const converge = hook('SubagentStop', { agent_id: 'only' })
      expect(converge.semanticState).toBe('done') // 归零兑现 done，roster 被删
      // 重投：roster 已删。变异守卫：把实现改回硬编码 `return 'working'`，这条立即变红。
      const redelivered = hook('SubagentStop', { agent_id: 'only' })
      expect(redelivered.semanticState).toBe('unknown')
      expect(redelivered.semanticState).not.toBe('working')
      // 一个从没记过子代理的 run 收到孤立 SubagentStop 也一样中性，不虚构 working。
      const neverTracked = claudeRun('run-never-tracked')
      expect(neverTracked('SubagentStop', { agent_id: 'ghost' }).semanticState).toBe('unknown')
    })
  })
})

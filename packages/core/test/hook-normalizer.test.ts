import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
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

    it('PostToolUse 带同一 tool_use_id 时发 update 命中 Pre 那条，不再 append 第二条', () => {
      const event = claude(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_01ABC', tool_response: 'total 24' },
        'PostToolUse',
        'receipt-post'
      )
      const mutation = event.timeline[0]
      expect(mutation?.type).toBe('update')
      if (mutation?.type !== 'update') throw new Error('expected update')
      expect(mutation.itemId).toBe('run-corr:tool:toolu_01ABC')
      expect(mutation.status).toBe('complete')
      expect(mutation.toolOutput).toBe('total 24')
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
  })
})

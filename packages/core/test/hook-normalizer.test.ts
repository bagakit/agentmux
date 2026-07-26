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
})

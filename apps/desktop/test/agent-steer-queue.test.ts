import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { MAX_AGENT_PROMPT_BYTES } from '@agentmux/core/agent-prompt-budget'

/**
 * T-008: a retry of the SAME prompt must reach Core with the SAME `operationId`, so the idempotent
 * same-id continuation Core already implements (prompt-submission.ts:186) becomes reachable from the
 * product. The id is a per-attempt correlation key carried on the steer-queue entry — never persisted,
 * never a store invariant. This pins the three properties the change turns on:
 *   (a) a retry of the same prompt reaches core with the same operationId
 *   (b) two different prompts get different ids
 *   (c) the steer queue keeps an entry's id stable across a FAILED flush and its retry
 */

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function runningAgent(id = 's') {
  return { id, kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
}

describe('steer queue operationId correlation (T-008)', () => {
  it('(c)+(a) keeps one entry\'s id stable across a failed flush and replays it on retry', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    const ids: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    // First flush rejects (Core busy / link drop) — the entry must be RETAINED for retry.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    // Retry flush succeeds — must carry the SAME operationId, which is what makes Core recognize the replay.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'steer me')
    await useAppStore.getState().flushAgentSteerQueue('s')
    // Retained after the failure — same entry, same id still on it.
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: ids[0], runId: 'r', text: 'steer me' }])

    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()

    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1]) // (a) retry reused the same id
    expect(ids[0]).toBeTruthy()
  })

  it('(b) two different prompts get two different ids', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const ids: string[] = []
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'first prompt')
    useAppStore.getState().enqueueAgentSteer('s', 'second prompt')
    await useAppStore.getState().flushAgentSteerQueue('s')

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
})

/**
 * 超限 prompt 在**入队口**就被拒，不是等 Core 拒。
 *
 * 为什么必须在门口判：`INVALID_AGENT_PROMPT` 对同一段内容是**永久**判决，而 flushAgentSteerQueue
 * 的 catch 把每一次抛出都当可重试——条目留着、循环 return。于是一条超限消息会在每个 runtime 事件
 * 上被重试一次（applyEvent 无条件重刷所有队列），永远不成功，而且**挡住它后面的每一条**。
 * 这不是"错误没报出来"，是队列被一条毒条目卡死。
 *
 * 判据全部读**队列状态**，不读某个字符串自己的属性——本仓记过那一族（测试断言样本而不执行代码）。
 */
describe('超限的 prompt 进不了队列', () => {
  const oversized = 'a'.repeat(MAX_AGENT_PROMPT_BYTES + 1)

  it('不入队，并且告诉用户为什么', () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const reported: unknown[] = []
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation((error) => { reported.push(error) })

    expect(useAppStore.getState().enqueueAgentSteer('s', oversized)).toBe(false)
    // 判据是队列状态：删掉门口那道判断，这条就红。
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(reported).toHaveLength(1)
    expect(String((reported[0] as Error).message)).toMatch(/too large/i)
  })

  it('正常长度照常入队——守卫不能一律拒绝', () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const reported: unknown[] = []
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation((error) => { reported.push(error) })

    expect(useAppStore.getState().enqueueAgentSteer('s', 'a normal steer')).toBe(true)
    expect(useAppStore.getState().agentSteerQueues.s).toHaveLength(1)
    expect(reported).toHaveLength(0)
  })

  it('按 trim 之后的长度判——与 Core 同一条边界', () => {
    // 这条输入是唯一能分辨两种实现的：原文 MAX+3 字节超限，trim 之后恰好等于 MAX 不超限。
    // Core 判的是 trim 后的内容（client.ts:2285），所以它会接受这条。
    // 把守卫改成判未 trim 的 text，这条就红——而上面两条都还是绿的。
    useAppStore.setState({ sessions: [runningAgent() as never] })
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    const atBoundaryAfterTrim = `${'a'.repeat(MAX_AGENT_PROMPT_BYTES)}   `

    expect(useAppStore.getState().enqueueAgentSteer('s', atBoundaryAfterTrim)).toBe(true)
    expect(useAppStore.getState().agentSteerQueues.s).toHaveLength(1)
  })

  it('send() 拒绝超限且不留下毒条目，只报一次', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const reported: unknown[] = []
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation((error) => { reported.push(error) })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => {})

    await expect(useAppStore.getState().send('s', oversized)).rejects.toThrow()
    // 三个独立判据：没进队列、没打到 Core、只报了一次（不是入队一次 + send 再报一次）。
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(submit).not.toHaveBeenCalled()
    expect(reported).toHaveLength(1)
  })
})

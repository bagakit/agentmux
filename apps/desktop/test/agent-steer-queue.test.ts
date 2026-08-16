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
  it('(c)+(a) a rejected flush keeps the entry and the NEXT auto-flush retries it with the same id', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const ids: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    // First flush rejects. The agent is RUNNING (runningAgent()), so this rejection is our own step not
    // completing — not the Agent failing. It must not become terminal.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    // The retry must carry the SAME operationId — that is what makes Core recognise the replay instead
    // of writing the prompt twice. This is the property T-008 exists for.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'steer me')
    await useAppStore.getState().flushAgentSteerQueue('s')
    // Retained, and marked `deferred` — NOT `failed`. This used to assert `failed`, which was the defect
    // written down: a healthy Agent's message judged dead because OUR readiness probe had not completed.
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: ids[0], runId: 'r', text: 'steer me', status: 'deferred', error: 'busy' }])

    // The whole point of `deferred`: the next runtime event retries on its own. No user action, no
    // "Send now" click. This assertion used to read `expect(ids).toHaveLength(1)` — i.e. it pinned the
    // queue's refusal to retry against a live Agent, which is exactly what must not happen.
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(ids).toHaveLength(2)
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined() // drained on the retry

    expect(ids[0]).toBe(ids[1]) // (a) retry reused the same id
    expect(ids[0]).toBeTruthy()
  })

  it('a deferred entry does not block the deliverable entries behind it', async () => {
    // 用户原话的另一半：一次投不出去不能让整条队列停摆。此前队首一旦进终局，头部闸门
    // （store.ts 的 `if (entry.status === 'failed') return`）会让后面每一条都再也发不出去——
    // 一次我们自己的观测失败升级成「这个 Session 再也发不出消息」。
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const sent: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    submit.mockImplementationOnce(async () => { throw new Error('not ready yet') }) // 队首被拒
    submit.mockImplementation(async (_c, prompt) => { sent.push(prompt) })

    useAppStore.getState().enqueueAgentSteer('s', 'first')
    useAppStore.getState().enqueueAgentSteer('s', 'second')
    await useAppStore.getState().flushAgentSteerQueue('s')
    // 本轮到队首就停——保序是「按作者顺序投递」，不是「跳过投不出去的那条」。
    expect(sent).toEqual([])

    // 下一个 runtime 事件：两条都按原顺序投出去，队列排空。
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(sent).toEqual(['first', 'second'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('a refused "Send now" does not freeze the queue behind it', async () => {
    // 这条守的是**手动那条路**，它此前与自动路径犯同一个错，而且更常被点到：「Send now」正是用户
    // 想催一条排队消息时按的，催的时机基本都在 Agent 生成中——那正是 Core 拒绝的正常时刻。
    // 把它记成终局，一次正常的「催一下」就会让整条队列对着一个健康 Agent 停摆（头部闸门认 failed）。
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const sent: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    submit.mockImplementationOnce(async () => { throw new Error('not ready yet') }) // 用户点 Send now，被拒
    submit.mockImplementation(async (_c, prompt) => { sent.push(prompt) })

    useAppStore.getState().enqueueAgentSteer('s', 'hurry this')
    useAppStore.getState().enqueueAgentSteer('s', 'and this')
    const first = useAppStore.getState().agentSteerQueues.s![0]!.operationId
    // 手动与自动共用投递 owner；拒绝原因驻留在条目上。
    await useAppStore.getState().sendQueuedAgentSteer('s', first)
    expect(useAppStore.getState().agentSteerQueues.s![0]!.status).toBe('deferred')

    // 决定性的一句：被拒之后自动投递照常继续，两条都按原顺序送出去。
    // 标成 failed 时这里会读到 `[]`——队首把后面所有条目一起连坐。
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(sent).toEqual(['hurry this', 'and this'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('投递拒绝保留在队列条目上，重试不产生全局弹窗', async () => {
    // 原因必须可读，但自动拒绝和重试都不打断其他 Session。
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const reported: string[] = []
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation((e) => { reported.push(String(e)) })
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('not ready yet'))

    useAppStore.getState().enqueueAgentSteer('s', 'steer me')
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(reported).toEqual([])
    expect(useAppStore.getState().agentSteerQueues.s![0]!.error).toBe('not ready yet')

    await useAppStore.getState().flushAgentSteerQueue('s')
    await useAppStore.getState().flushAgentSteerQueue('s')
    // 还在重试（条目仍在队列里等着），但不再上报——驻留状态由徽标那一档常驻表达。
    expect(useAppStore.getState().agentSteerQueues.s![0]).toMatchObject({ status: 'deferred', error: 'not ready yet' })
    expect(reported).toEqual([])
  })

  it('重启后 hydrate 回来的队列照旧能投递，且不会替用户丢掉对不上 run 的那条', async () => {
    // AGENTS.md 第 12 条要求「进程重启后仍可见且可恢复」有一次回归验证。持久化本身在
    // store-persistence 那条钉了（partialize 逐字存下整份结构）；这一条钉的是**另一半**：
    // 存下来的形状喂回 store 之后，投递链真的认它——否则字虽然还在盘上，产品侧却永远发不出去。
    //
    // 走 JSON round trip 而不是直接 setState 一个对象：落盘要经过序列化，只有 round trip 能证明
    // 这份形状没有任何东西是靠内存引用活着的。
    const persisted = JSON.parse(JSON.stringify({
      's': [
        { operationId: 'op-live', runId: 'r', text: '重启前排的', status: 'queued' },
        // 对着旧 run 的那条：不许静默投进当前 run（它不是写给这个 run 的），也不许替用户删掉。
        { operationId: 'op-stale', runId: 'old-run', text: '写给上一个 run 的', status: 'queued' }
      ]
    }))
    useAppStore.setState({ sessions: [runningAgent() as never], agentSteerQueues: persisted })
    const sent: string[] = []
    const ids: string[] = []
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, prompt, operationId) => {
      sent.push(prompt); ids.push(operationId!)
    })

    await useAppStore.getState().flushAgentSteerQueue('s')

    // 对得上当前 run 的那条投出去了，而且用的是**存下来的那个** operationId——这就是关联键必须
    // 跟着一起持久化的理由：重启后同一条重试要让 Core 认出是同一次尝试，而不是写第二遍。
    expect(sent).toEqual(['重启前排的'])
    expect(ids).toEqual(['op-live'])
    // 过期那条留在队列里，内容一字不动。角标会如实说它不可投递（deliverability 那组守的是文案）。
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: 'op-stale', runId: 'old-run', text: '写给上一个 run 的', status: 'queued' }
    ])
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

    expect(useAppStore.getState().send('s', oversized)).toBe(false)
    // 三个独立判据：没进队列、没打到 Core、只报了一次（不是入队一次 + send 再报一次）。
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(submit).not.toHaveBeenCalled()
    expect(reported).toHaveLength(1)
  })
})

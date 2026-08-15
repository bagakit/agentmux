import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import {
  steerEntryTargetsRun,
  steerQueueCanDrainNow,
  steerQueueCanEverDrain
} from '../src/renderer/src/lib/agent-steer-queue-drain'

/**
 * 一条排队的 steer 绝不能投进它排队时对着的那个 run 以外的 run。
 *
 * 缺陷的形状（三份独立评审各自独立发现的同一条）：队列按 agentSessionId 存，而 agentSessionId
 * 在 Resume 前后**不变**、runId 变（lib/api.ts 的 recover 原地换 control.run.runId）。于是
 *
 *   run 被打断 → 角标如实说「送不出去了」 → 用户点 Resume → 同一个 agentSessionId 回到 running
 *   → applyEvent 那圈 flush 扫到这份没人清过的队列 → 把用户以为已经作废的话投进一个全新的 run。
 *
 * 这恰好是 AgentComposer 明确拒绝提供「重发」按钮的那件事（「不知道下一个 run 是不是同一个
 * Agent，静默重放一条过期的 steer 比什么都不说更糟」）——组件拒绝做的，store 一直在自动做。
 *
 * 判据落在 store 行为上，不落在「有没有调用某个函数」上：真正要守的是**字节有没有出去**。
 */

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function agent(runId: string, processState = 'running') {
  return {
    id: 's',
    kind: 'agent',
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId } },
    status: { state: 'working', observedAt: 1 },
    processState
  }
}

describe('排队的 steer 绑定它排队时的 run', () => {
  it('入队即记下当时的 runId', () => {
    useAppStore.setState({ sessions: [agent('run-1') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'typed at run-1')
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), runId: 'run-1', text: 'typed at run-1' }
    ])
  })

  it('Resume 换了 run 之后，旧 run 的 steer 不会被投进新 run', async () => {
    // 1. 对着 run-1 排队。
    useAppStore.setState({ sessions: [agent('run-1') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'stale steer')

    // 2. run 被打断——此刻队列停在那里，角标如实说送不出去。
    useAppStore.setState({ sessions: [agent('run-1', 'interrupted') as never] })

    // 3. 用户 Resume：同一个 agentSessionId，全新的 runId，回到 running。
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [agent('run-2') as never] })
    await useAppStore.getState().flushAgentSteerQueue('s')

    // 一个字节都不该出去。变异：删掉 flush 里的 steerEntryTargetsRun 跳过，这里立刻红。
    expect(submit).not.toHaveBeenCalled()
  })

  it('同一个 run 上排的队照常送出——判据不是「一律不送」', async () => {
    useAppStore.setState({ sessions: [agent('run-1') as never] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.getState().enqueueAgentSteer('s', 'fresh steer')
    await useAppStore.getState().flushAgentSteerQueue('s')

    // 这一条与上一条互为两侧：把判据收窄成「永远不送」能让上一条绿，却让这一条红。
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[1]).toBe('fresh steer')
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('过期条目被跳过时仍留在队列里，不被悄悄丢弃', async () => {
    useAppStore.setState({ sessions: [agent('run-1') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'stale steer')
    vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [agent('run-2') as never] })
    await useAppStore.getState().flushAgentSteerQueue('s')

    // 用户写下的字不由这个循环替他决定丢不丢：角标仍要拿得到它们（并标成送不出去）。
    // 变异：把 flush 里的 `continue` 改成删除条目，这里红。
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), runId: 'run-1', text: 'stale steer' }
    ])
  })

  it('过期条目不会挡住它后面对着当前 run 排的条目', async () => {
    useAppStore.setState({ sessions: [agent('run-1') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'stale head')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [agent('run-2') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'fresh tail')
    await useAppStore.getState().flushAgentSteerQueue('s')

    // 跳过必须是 `continue` 而不是 `return`：队头一条过期不该把后面还能送的一起卡死。
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[1]).toBe('fresh tail')
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), runId: 'run-1', text: 'stale head' }
    ])
  })
})

describe('排空判定只有一处', () => {
  it('三个 run 状态各自给出「将来还能不能排空」', () => {
    // 穷举表在 union 上是 tsc 守的；这里守的是三格各自的取值没被写反。
    expect(steerQueueCanEverDrain('running')).toBe(true)
    expect(steerQueueCanEverDrain('exited')).toBe(false)
    expect(steerQueueCanEverDrain('interrupted')).toBe(false)
  })

  it('pendingInteraction 只挡「此刻」，不改「将来」', () => {
    // 这一对是两个谓词必须分开的全部理由：respondInteraction 答完立刻再 flush 一次，所以
    // 一条被交互卡住的 steer 是真的还在路上，角标不能对它说「送不出去了」。
    expect(steerQueueCanEverDrain('running')).toBe(true)
    expect(steerQueueCanDrainNow({ processState: 'running', pendingInteraction: { requestId: 'q' } })).toBe(false)
    expect(steerQueueCanDrainNow({ processState: 'running' })).toBe(true)
    expect(steerQueueCanDrainNow({ processState: 'interrupted' })).toBe(false)
  })

  it('run 身份判定按 runId 相等', () => {
    expect(steerEntryTargetsRun({ runId: 'run-1' }, 'run-1')).toBe(true)
    expect(steerEntryTargetsRun({ runId: 'run-1' }, 'run-2')).toBe(false)
  })

  it('store 的 flush 闸门走的就是这个谓词，不是第二份手抄', async () => {
    // 判据是行为不是文本：让谓词说 false 的那些状态，flush 必须一个字节都不发。
    // 变异：把 flush 的闸门改回手抄 `processState !== 'running'`，这条仍绿——它守的是
    // pendingInteraction 那一半（手抄版漏掉它就会发出去）。
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({
      sessions: [{ ...agent('run-1'), pendingInteraction: { requestId: 'q' } } as never]
    })
    useAppStore.getState().enqueueAgentSteer('s', 'blocked by interaction')
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit).not.toHaveBeenCalled()
  })
})

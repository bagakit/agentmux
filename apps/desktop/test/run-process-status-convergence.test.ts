import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'

/**
 * 「进程事实 → 界面那一行状态」在**实时路径**上的接线。
 *
 * 这族测试的存在理由是一个真缺陷：这段投影曾经在主进程（快照/reload 路径）与 renderer（实时事件路径）
 * 各写了一遍，而实时那一份整段没读过内核报的终止信号——`exitSignal` 在 session-state.ts 里零命中。
 * 后果是同一个被 SIGSEGV 打死的 Agent：崩溃**当下**只显示一个没有下文的 error，关掉窗口重开反而看到了
 * `signal SIGSEGV`。最需要那条信息的时刻恰好没有。
 *
 * 所以这里守的不是「投影算得对」（那由 Core 侧 agent-run-status.test.ts 守），而是**这条路真的走了那个
 * 投影**。判据落在用户能看到的字符串上：detail 是横幅上的那句话，也是可搜索的文本。
 *
 * 姊妹一半在 runtime-controller.test.ts（快照路径）。两个文件必须各自独立红——一处绿不能替另一处担保，
 * 那正是这个缺陷此前活下来的方式。
 */

const session: SessionSnapshot = {
  id: 'session-1',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  capabilities: {
    terminal: true,
    timeline: 'complete-events',
    permission: 'observe',
    providerResume: true,
    replyCorrelation: 'none'
  },
  hostId: 'local',
  workspacePath: '/repo',
  label: 'Codex',
  createdAt: 1,
  updatedAt: 2,
  processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 2 },
  latestOutputBytes: 0,
  control: {
    kind: 'agent',
    hostId: 'local',
    agentSessionId: 'session-1',
    run: { runId: 'run-1' }
  }
}

function core(event: RuntimeEvent['event']): RuntimeEvent {
  return { type: 'core', hostId: 'local', event }
}

function initialState() {
  return {
    sessions: [session],
    timelines: {},
    pendingAgentLaunches: {},
    tabs: {},
    layouts: {},
    viewModes: {}
  }
}

/** 投一条 process-state 事件进实时路径，取回那个 Session 投影出来的 status。 */
function statusAfterProcessEvent(
  event: Omit<Extract<RuntimeEvent['event'], { type: 'process-state' }>, 'type' | 'agentSessionId' | 'run' | 'evidence' | 'pid'>
    & { observedAt?: number }
): SessionSnapshot['status'] {
  const { observedAt = 4, ...rest } = event
  const next = reduceRuntimeEvent(initialState(), core({
    type: 'process-state',
    agentSessionId: session.id,
    run: session.control.run,
    pid: 42,
    ...rest,
    evidence: { source: 'run-process', observedAt, run: session.control.run }
  }))
  const projected = next.sessions[0]
  if (!projected) throw new Error('实时路径把 Session 整个丢了')
  return projected.status
}

describe('实时路径的进程状态投影', () => {
  it('被信号打死时当场说是哪个信号——这条事实此前只有 reload 之后才看得到', () => {
    // 缺陷的正脸。删掉 session-state.ts 里传 exitSignal 那一行，这条红，而 exitCode/exitReason 那两条仍绿。
    expect(statusAfterProcessEvent({
      state: 'exited',
      exitCode: 139,
      exitSignal: 'SIGSEGV'
    })).toMatchObject({ state: 'exited', detail: 'signal SIGSEGV' })
  })

  it('PTY 消失时给出 interrupt 那句说明，且显示态是 error', () => {
    // 独立承重：文案与 signal 各走投影里的一条分支，改一条不影响另一条。
    expect(statusAfterProcessEvent({ state: 'interrupted' })).toMatchObject({
      state: 'error',
      detail: 'The Run owner interrupted this PTY.'
    })
  })

  it('干净退出不写 detail——没有更多信息就别装作有', () => {
    expect(statusAfterProcessEvent({ state: 'exited', exitCode: 0 })).not.toHaveProperty('detail')
  })

  it('退出原因原样贴上，让横幅说得清是你关的还是它崩的', () => {
    expect(statusAfterProcessEvent({
      state: 'exited',
      exitCode: 1,
      exitReason: 'crashed'
    })).toMatchObject({ exitReason: 'crashed' })
  })

  it('事件没带退出原因时不凭空造一个', () => {
    expect(statusAfterProcessEvent({ state: 'exited', exitCode: 0 })).not.toHaveProperty('exitReason')
  })
})

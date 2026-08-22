import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { runInterruptionFact } from '../src/shared/contracts.js'
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

/** 投一条 process-state 事件进实时路径，取回那个 Session 整份投影。 */
function sessionAfterProcessEvent(
  event: Omit<Extract<RuntimeEvent['event'], { type: 'process-state' }>, 'type' | 'agentSessionId' | 'run' | 'evidence' | 'pid'>
    & { observedAt?: number }
): SessionSnapshot {
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
  return projected
}

/** 投一条 process-state 事件进实时路径，取回那个 Session 投影出来的 status。 */
function statusAfterProcessEvent(
  event: Omit<Extract<RuntimeEvent['event'], { type: 'process-state' }>, 'type' | 'agentSessionId' | 'run' | 'evidence' | 'pid'>
    & { observedAt?: number }
): SessionSnapshot['status'] {
  return sessionAfterProcessEvent(event).status
}

describe('实时路径的进程状态投影', () => {
  it('readiness observer failure after a stop stays exited instead of becoming a red error', () => {
    const next = reduceRuntimeEvent(initialState(), core({
      type: 'agent-error',
      agentSessionId: session.id,
      code: 'AGENT_RUN_EXITED',
      message: 'Agent Run exited before its composer became ready.',
      evidence: { source: 'terminal-output', observedAt: 5, run: session.control.run }
    }))
    expect(next.sessions[0]?.status).toMatchObject({
      state: 'exited',
      detail: 'Agent Run exited before its composer became ready.'
    })
    expect(next.sessions[0]?.status.state).not.toBe('error')
  })

  it('a late readiness observer cannot replace a Core crash fact', () => {
    const crashed = reduceRuntimeEvent(initialState(), core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      state: 'exited',
      pid: 42,
      exitCode: 139,
      exitSignal: 'SIGSEGV',
      evidence: { source: 'run-process', observedAt: 9, run: session.control.run }
    }))
    const next = reduceRuntimeEvent(crashed, core({
      type: 'agent-error',
      agentSessionId: session.id,
      code: 'AGENT_RUN_EXITED',
      message: 'Agent Run exited before its composer became ready.',
      evidence: { source: 'terminal-output', observedAt: 10, run: session.control.run }
    }))
    expect(next.sessions[0]?.status).toMatchObject({ state: 'error', detail: 'signal SIGSEGV' })
  })

  it('a readiness observer cannot turn a Runtime interruption into a stopped state', () => {
    const interrupted = reduceRuntimeEvent(initialState(), core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      state: 'interrupted',
      pid: 42,
      interruptionReason: 'daemon_restart',
      evidence: { source: 'run-process', observedAt: 9, run: session.control.run }
    }))
    const next = reduceRuntimeEvent(interrupted, core({
      type: 'agent-error',
      agentSessionId: session.id,
      code: 'AGENT_RUN_EXITED',
      message: 'Agent Run exited before its composer became ready.',
      evidence: { source: 'terminal-output', observedAt: 10, run: session.control.run }
    }))
    expect(next.sessions[0]?.status).toMatchObject({ state: 'disconnected', detail: 'The Runtime restarted and interrupted this Run.' })
  })

  it('the Core process fact wins when its event arrives after the observer, even with an older timestamp', () => {
    const observed = reduceRuntimeEvent(initialState(), core({
      type: 'agent-error',
      agentSessionId: session.id,
      code: 'AGENT_RUN_EXITED',
      message: 'Agent Run exited before its composer became ready.',
      evidence: { source: 'terminal-output', observedAt: 10, run: session.control.run }
    }))
    const next = reduceRuntimeEvent(observed, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      state: 'exited',
      pid: 42,
      exitCode: 139,
      exitSignal: 'SIGSEGV',
      evidence: { source: 'run-process', observedAt: 9, run: session.control.run }
    }))
    expect(next.sessions[0]?.status).toMatchObject({ state: 'error', detail: 'signal SIGSEGV' })
  })

  it('keeps Runtime restart recoverable and a deliberate stop neutral on the live path', () => {
    expect(sessionAfterProcessEvent({ state: 'interrupted', interruptionReason: 'daemon_restart' }))
      .toMatchObject({ processState: 'interrupted', interruptionReason: 'daemon_restart', status: {
        state: 'disconnected', detail: 'The Runtime restarted and interrupted this Run.'
      } })
    expect(statusAfterProcessEvent({ state: 'exited', exitCode: 137, exitSignal: 'SIGKILL', exitReason: 'user-stopped' }))
      .toMatchObject({ state: 'exited', exitReason: 'user-stopped' })
  })

  it('被信号打死时当场说是哪个信号——这条事实此前只有 reload 之后才看得到', () => {
    // 缺陷的正脸。删掉 session-state.ts 里传 exitSignal 那一行，这条红，而 exitCode/exitReason 那两条仍绿。
    expect(statusAfterProcessEvent({
      state: 'exited',
      exitCode: 139,
      exitSignal: 'SIGSEGV'
    })).toMatchObject({ state: 'error', detail: 'signal SIGSEGV' })
  })

  it('PTY 消失时给出 interrupt 那句说明，且显示态诚实断开', () => {
    // 独立承重：文案与 signal 各走投影里的一条分支，改一条不影响另一条。
    expect(statusAfterProcessEvent({ state: 'interrupted' })).toMatchObject({
      state: 'disconnected',
      detail: 'The Run was interrupted; the cause was not reported.'
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

  it('PTY 为什么消失也要在实时路径落到 Session 上——终端的自动恢复靠它', () => {
    // 第四条同族事实，且它是唯一一条**不落在 status 里**的：`interruptionReason` 挂在 Session 本体。
    // 上面那个 helper 只取回 status，所以那五条断言对它整条失明——这正是它此前在实时路径漏掉而
    // 39/39 全绿的原因（实测：把 session-state 里传这条的那一段中性化，五个文件 56 条全绿）。
    //
    // 后果不是少显示一行字：SessionPane 靠 `interruptionReason === 'daemon_restart'` 决定要不要
    // 自动重开一个终端。这条事实丢了，被 daemon 重启打死的终端不会自动恢复，只摊着一个「Check
    // again」——而 PTY 已经没了，那个按钮永远不可能成功。
    expect(sessionAfterProcessEvent({
      state: 'interrupted',
      interruptionReason: 'daemon_restart'
    })).toMatchObject({ processState: 'interrupted', interruptionReason: 'daemon_restart' })
  })

  it('中断但没说原因时不落一个空的理由——空串会被读成一个假理由', () => {
    // 独立承重：上面那条只证「带了会传」，这条证「没带不会伪造」。两者一起才把那个条件的两侧钉住。
    expect(sessionAfterProcessEvent({ state: 'interrupted' })).not.toHaveProperty('interruptionReason')
  })

  it('中断但理由是空串时也不落——空串不是「没说」的合法写法，daemon_restart 的判定会读到假值', () => {
    // 上面那条喂的是 `undefined`（整个字段缺席）。把判据从真值收窄成 `interruptionReason !== undefined`
    // 就能放行 `''`：字段在场、值是空串。那正是 runInterruptionFact 的注释点名要挡的东西——空串会把
    // 「没说原因」伪装成「原因是空的」，也会让 SessionPane 的 `=== 'daemon_restart'` 判定读到一个假值。
    // 只喂 `undefined` 的断言对这条盲，因为 `!== undefined` 恰好把 `undefined` 挡住、把 `''` 放行。
    expect(sessionAfterProcessEvent({ state: 'interrupted', interruptionReason: '' }))
      .not.toHaveProperty('interruptionReason')
  })

  it('非中断状态不许带中断理由——那条事实只对「PTY 没了」有定义', () => {
    // 第三侧：条件里 `state === 'interrupted'` 那一半。少了这条，把判据放宽成「只看理由在不在」
    // 会让一个正常退出的 run 带上一条中断理由，而 SessionPane 会据此去自动重开终端。
    expect(sessionAfterProcessEvent({
      state: 'exited',
      exitCode: 0,
      interruptionReason: 'daemon_restart'
    })).not.toHaveProperty('interruptionReason')
  })

  it('中断理由不跨事件残留——上一次中断的理由不许贴在这次退出上', () => {
    // 这一段的实现是先把旧值解构掉再按新事件重算。少了那次解构，一个中断过又被恢复的 Session
    // 会永久带着旧理由，于是 SessionPane 每次看到它都想再自动重开一次终端。
    const interrupted = sessionAfterProcessEvent({
      state: 'interrupted',
      interruptionReason: 'daemon_restart'
    })
    expect(interrupted.interruptionReason).toBe('daemon_restart')
    const next = reduceRuntimeEvent({ ...initialState(), sessions: [interrupted] }, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: session.control.run,
      pid: 42,
      state: 'running',
      evidence: { source: 'run-process', observedAt: 9, run: session.control.run }
    }))
    expect(next.sessions[0]).not.toHaveProperty('interruptionReason')
  })
})

describe('runInterruptionFact 的取值判据本身', () => {
  // 上面那族测的是「实时路径真的调了这个函数」。这一族直接质询函数本身，把它注释点名的两个条件
  // 的三侧各钉一次——两处消费者（主进程快照 runtime-controller.ts、实时路径 session-state.ts）都从
  // 这一个函数取这条事实，所以这里守住的是它们共同的取值口径。

  it('中断且带了理由时原样取出', () => {
    expect(runInterruptionFact({ state: 'interrupted', interruptionReason: 'daemon_restart' }))
      .toEqual({ interruptionReason: 'daemon_restart' })
  })

  it('理由是空串时判据必须落成 {}，绝不落一个空的理由', () => {
    // 注释逐字写着：理由缺席时不能落成空串——空串会把「没说原因」伪装成「原因是空的」，也会让
    // daemon_restart 的判定读到假值。把真值判据放宽成 `interruptionReason !== undefined` 就会放行
    // 这一条（字段在场、值是空串），于是返回 `{ interruptionReason: '' }`。toEqual({}) 认得出这个多写，
    // 而单看「非中断态不带理由」/「缺席不伪造 undefined」两条对它都是盲的。
    expect(runInterruptionFact({ state: 'interrupted', interruptionReason: '' })).toEqual({})
  })

  it('理由整个缺席时也落成 {}', () => {
    expect(runInterruptionFact({ state: 'interrupted' })).toEqual({})
  })

  it('非中断态即使带着理由也不取——这条事实只对「PTY 没了」有定义', () => {
    // `interrupted` 之外的另两个 run state 各钉一次：正常退出与运行中都不该把中断理由带出去，
    // 否则 SessionPane 会据此去自动重开一个其实没被 daemon 打死的终端。
    expect(runInterruptionFact({ state: 'exited', interruptionReason: 'daemon_restart' })).toEqual({})
    expect(runInterruptionFact({ state: 'running', interruptionReason: 'daemon_restart' })).toEqual({})
  })
})

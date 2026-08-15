import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'

// composerSubmitMode is pure, but the agreement assertions below call the real agentComposerAvailability,
// which lives in a module that also pulls the Store and the native api. Those resolve build-time constants
// in a browser bundle, so they are stubbed exactly as the sibling composer test stubs them; nothing here
// reads store state — the mocks only satisfy the import graph.
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { ui: {} } }))

import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode.js'
import { agentComposerAvailability } from '../src/renderer/src/components/AgentSessionComposer.js'

function agentSession(
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 'agent-1',
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
    updatedAt: 1,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } },
    ...overrides
  }
}

const pendingInteraction: Extract<SessionSnapshot, { kind: 'agent' }>['pendingInteraction'] = {
  kind: 'permission',
  id: 'permission-1',
  agentSessionId: 'agent-1',
  title: 'Allow command?',
  options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
  evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'run-1' }, hookReceiptId: 'permission-1' }
}

describe('composerSubmitMode', () => {
  it('lets a working Agent be BOTH steered and stopped — canSubmit true while primaryAction stays stop', () => {
    // The bug this whole module exists to fix: one !isWorking flag decided both questions, so a running
    // Agent could only be interrupted, never steered. These are different questions and must not agree.
    const mode = composerSubmitMode(agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } }))

    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(true)
    expect(mode.primaryAction).toBe('stop')
    expect(mode.placeholder).toBe('Ask, steer, or paste a command…')
  })

  it('offers Send, not Stop, for an idle running Agent', () => {
    const mode = composerSubmitMode(agentSession({ status: { state: 'running', source: 'run-process', observedAt: 1 } }))

    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(true)
    expect(mode.primaryAction).toBe('send')
  })

  it('blocks submit while an interaction is pending, so steer cannot bypass the card', () => {
    const mode = composerSubmitMode(
      agentSession({ status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, pendingInteraction })
    )

    // The card is the only input surface here; the textarea shuts and no submit is offered.
    expect(mode.canType).toBe(true)
    expect(mode.canSubmit).toBe(false)
    expect(mode.placeholder).toContain('Draft a steer')
  })

  it('keeps Stop reachable even while a pending card blocks submit on a working Agent', () => {
    // canSubmit is false (card owns input) but a turn is still in flight, so the primary action stays Stop:
    // the two axes are independent, and folding them would strand an un-interruptible running turn.
    const mode = composerSubmitMode(
      agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 2 }, pendingInteraction })
    )

    expect(mode.canSubmit).toBe(false)
    expect(mode.primaryAction).toBe('stop')
  })

  it('cannot type when the Agent snapshot is missing', () => {
    const mode = composerSubmitMode(undefined)

    expect(mode.canType).toBe(false)
    expect(mode.canSubmit).toBe(false)
    expect(mode.placeholder).toBe('Agent is connecting…')
  })

  it('cannot type when forceDisabled, regardless of a live working Agent', () => {
    const mode = composerSubmitMode(agentSession(), true)

    expect(mode.canType).toBe(false)
    expect(mode.canSubmit).toBe(false)
  })

  it('never lets an output-channel error gate a running composer, on ANY evidence source', () => {
    // RED-LINES.md 判定流程: greying a `running` Agent takes away an ability the daemon still honours —
    // writeAgentInput / recoverableInput reach the process regardless of the output attachment. "绕过我这段
    // 代码，这条路还能不能通？ → 能" ⇒ blocking here is the red line (原则 11 第 2 类 written as 第 1 类).
    //
    // 遍历全部三个 source 而不是只钉 run-process：reducer 对每一次 scoped agent-error 都把 state 翻成
    // 'error' 并盖一个 source，只守一侧的话换个 source 就漏。三者都不意味着「进程 running 时 Agent 不再
    // 收字节」——hook-install / launch-prompt / timeline-persist 走 'user'，prompt-readiness / OUTPUT_GAP
    // 走 'terminal-output'，实时输出故障走 'run-process'。
    //
    // run-process 这一档尤其分不得：两种故障落到这里是同一个快照 { state:'error', source:'run-process' }，
    // 因为 reducer 丢掉了 error code（SessionStatus 没有 code 字段）：
    //   (a) 通道活着但不连续：observation_discontinuity / tmux 建议事件带来的 CTXMUX_EVENT_INVALID，
    //       泵继续跑、输出继续流。锁住它就是当初报上来的那个 bug。
    //   (b) 通道真死了：RECONNECT_REATTACH_FAILED。输入照样到得了 Agent；诚实的信号是一条服务窗
    //       （「输出可能没在显示 — 把这块 pane 切到 Activity 再切回来即可重新附着」），不是一个锁死的
    //       输入框。那句恢复动作刻意不点名 Resume：running 的 Run 判出 reattachable 直接返回，不走 attach。
    // 既然分不清，就不该假装分得清。插回 `if (status.state==='error' && status.source==='run-process')
    // canType:false` 会让这条变红。
    for (const source of ['user', 'terminal-output', 'run-process'] as const) {
      const mode = composerSubmitMode(
        agentSession({ processState: 'running', status: { state: 'error', source, observedAt: 3 } })
      )

      expect(mode.canType).toBe(true)
      expect(mode.canSubmit).toBe(true)
      expect(mode.placeholder).toBe('Ask, steer, or paste a command…')
    }
  })

  // canType must never disagree with the sealed availability contract for the cases that gate typing at
  // all. This calls the REAL agentComposerAvailability so a drift in either function fails the suite.
  it('agrees item-for-item with agentComposerAvailability on every gate that disables the surface', () => {
    const cases: Array<{ session: SessionSnapshot | undefined; forceDisabled: boolean }> = [
      { session: undefined, forceDisabled: false },
      { session: agentSession(), forceDisabled: true },
      { session: agentSession({ status: { state: 'disconnected', source: 'run-process', observedAt: 2 } }), forceDisabled: false },
      { session: agentSession({ processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: 3 } }), forceDisabled: false },
      { session: agentSession({ status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, pendingInteraction }), forceDisabled: false },
      { session: agentSession({ status: { state: 'running', source: 'run-process', observedAt: 1 } }), forceDisabled: false },
      { session: agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } }), forceDisabled: false }
    ]

    for (const { session, forceDisabled } of cases) {
      const availability = agentComposerAvailability(session, forceDisabled)
      const mode = composerSubmitMode(session, forceDisabled)
      // pendingInteraction 只落在 agent 变体上，先窄化再读——terminal 快照没有这个字段。
      const pending = session?.kind === 'agent' ? session.pendingInteraction : undefined
      // canType is the inverse of availability.disabled, and the placeholder text is identical.
      expect(mode.canType).toBe(pending ? true : !availability.disabled)
      expect(mode.placeholder).toBe(pending ? 'Answer the Agent request above… Draft a steer…' : availability.placeholder)
    }
  })
})

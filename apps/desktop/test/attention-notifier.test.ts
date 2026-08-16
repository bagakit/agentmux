import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { createAttentionNotifier } from '../src/renderer/src/lib/attention-notifier.js'

function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
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
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function timelineItem(kind: AgentTimelineItem['kind'], content: string, id: string): AgentTimelineItem {
  return {
    id,
    agentSessionId: 'a',
    kind,
    status: 'complete',
    source: kind === 'user_message' ? 'user' : 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: kind,
    content
  }
}

function timelines(sessionId: string, items: AgentTimelineItem[]): Record<string, AgentTimelineSnapshot> {
  return { [sessionId]: { agentSessionId: sessionId, revision: 1, items } }
}

// The user is elsewhere, notifications on the default-ish "standard" tier, no conversation unless a test
// supplies one. Every reconcile spreads this so a test only names what it is actually about.
const away = {
  windowFocused: false,
  visibleSessionIds: new Set<string>(),
  mode: 'standard' as const,
  // The shipped default (see DEFAULT_NOTIFICATION_SOUND): a banner you see, not hear. A test that is
  // about sound overrides it explicitly.
  sound: false,
  timelines: {} as Record<string, AgentTimelineSnapshot>
}

function ports() {
  return {
    notify: vi.fn(async () => ({ status: 'shown' as const, presentation: 'as-requested' as const })),
    onUnsupported: vi.fn(),
    onDowngraded: vi.fn()
  }
}

describe('attention notifier', () => {
  it('notifies on a transition into a category worth interrupting', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    const raised = await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })

    expect(raised.map((event) => event.category)).toEqual(['done'])
    // The title still names the category; the body now leads with the Agent and its concrete state.
    expect(io.notify).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'a', title: 'Agent finished', mode: 'standard' })
    )
    expect(io.notify.mock.calls[0]![0]!.body).toBe('Agent a — Finished')
  })

  it('carries the sound choice through to delivery, both ways', async () => {
    // 这条测的是一条**曾经不存在的线**：`silent` 此前是 main 的请求类型上的一个可选字段，投递侧认真
    // 读它，而整个应用没有任何一处传过它——一个声明了、被兑现了、却谁也够不着的能力。所以判据不是
    // 「类型上有这个字段」，而是「用户选的那个值真的走到了投递的入参里」，两个方向各钉一次：只钉 true
    // 的话，把实现写成恒 true 也能绿。
    for (const sound of [true, false]) {
      const io = ports()
      const notifier = createAttentionNotifier(io)
      notifier.seed([agent('a', 'working')])

      await notifier.reconcile({ sessions: [agent('a', 'done')], ...away, sound })

      expect(io.notify).toHaveBeenCalledWith(expect.objectContaining({ sound }))
    }
  })

  it('does not notify twice for the same state', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })
    // A second projection carrying the same fact must be silent — providers re-announce status.
    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })

    expect(io.notify).toHaveBeenCalledOnce()
  })

  it('seeds without notifying, so attaching does not replay old work', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    // Seeding with already-finished Agents must not fire: that work predates the app being open.
    notifier.seed([agent('a', 'done'), agent('b', 'waiting')])

    await notifier.reconcile({ sessions: [agent('a', 'done'), agent('b', 'waiting')], ...away })

    expect(io.notify).not.toHaveBeenCalled()
  })

  it('stays quiet about the Session the user is looking at', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({
      sessions: [agent('a', 'done')],
      windowFocused: true,
      visibleSessionIds: new Set(['a']),
      mode: 'standard',
      sound: false,
      timelines: {}
    })

    expect(io.notify).not.toHaveBeenCalled()
  })

  it('composes a body with the Agent, its state, and the last exchange, then omits missing segments', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    // A full exchange: user asked, assistant replied, then the Agent went to waiting.
    await notifier.reconcile({
      ...away,
      sessions: [agent('a', 'waiting')],
      timelines: timelines('a', [
        timelineItem('user_message', 'Please refactor the parser', 'u1'),
        timelineItem('tool_call', 'grep -rn parser', 't1'),
        timelineItem('assistant_message', 'Done — extracted a pure tokenizer', 'r1')
      ])
    })

    // Four segments requested, three available (there is no separate "current status text" beyond the
    // state word), each on its own line: name+state, assistant reply, user question.
    expect(io.notify.mock.calls[0]![0]!.body).toBe(
      'Agent a — Waiting for you\nAgent a: Done — extracted a pure tokenizer\nYou: Please refactor the parser'
    )

    // No timeline at all: the reply and question segments are dropped entirely, no "(none)" placeholder.
    await notifier.reconcile({ sessions: [agent('a', 'error')], ...away })
    const errorBody = io.notify.mock.calls[1]![0]!.body
    expect(errorBody).toBe('Agent a — Error')
    expect(errorBody).not.toContain('(')
  })

  it('raises nothing on the off tier but still advances the baseline', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    // Off: the done transition happens but nothing is delivered.
    await notifier.reconcile({ ...away, mode: 'off', sessions: [agent('a', 'done')] })
    expect(io.notify).not.toHaveBeenCalled()

    // Turning it back on must NOT replay that transition — the baseline moved while off.
    await notifier.reconcile({ ...away, sessions: [agent('a', 'done')] })
    expect(io.notify).not.toHaveBeenCalled()

    // A genuinely new transition after re-enabling still notifies.
    await notifier.reconcile({ ...away, sessions: [agent('a', 'waiting')] })
    expect(io.notify).toHaveBeenCalledOnce()
  })

  it('reports an unsupported platform once, not on every event', async () => {
    const io = {
      notify: vi.fn(async () => ({ status: 'unsupported' as const, reason: 'Notifications are off.' })),
      onUnsupported: vi.fn(),
      onDowngraded: vi.fn()
    }
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working'), agent('b', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'done'), agent('b', 'done')], ...away })
    await notifier.reconcile({ sessions: [agent('a', 'waiting'), agent('b', 'waiting')], ...away })

    // Four refusals, one report: a platform that refuses will refuse every time, and repeating it would
    // turn one honest failure into a stream of noise.
    expect(io.notify.mock.calls.length).toBe(4)
    expect(io.onUnsupported).toHaveBeenCalledOnce()
    expect(io.onUnsupported).toHaveBeenCalledWith('Notifications are off.')
  })

  it('reports a platform downgrade once, and never confuses it with unsupported', async () => {
    // The banner DID show, just not persistently: shown + downgraded. This must reach onDowngraded, not
    // onUnsupported, and only once even across several downgraded deliveries.
    const io = {
      notify: vi.fn(async () => ({ status: 'shown' as const, presentation: 'downgraded' as const })),
      onUnsupported: vi.fn(),
      onDowngraded: vi.fn()
    }
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working'), agent('b', 'working')])

    await notifier.reconcile({
      ...away,
      mode: 'until-acknowledged',
      sessions: [agent('a', 'done'), agent('b', 'waiting')]
    })
    await notifier.reconcile({ ...away, mode: 'until-acknowledged', sessions: [agent('a', 'error')] })

    expect(io.onDowngraded).toHaveBeenCalledOnce()
    expect(io.onDowngraded).toHaveBeenCalledWith('until-acknowledged')
    expect(io.onUnsupported).not.toHaveBeenCalled()
  })

  it('titles each category for the person reading a banner out of context', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'waiting')], ...away })
    await notifier.reconcile({ sessions: [agent('a', 'error')], ...away })

    expect(io.notify.mock.calls.map((call) => call[0]!.title))
      .toEqual(['Agent needs you', 'Agent failed'])
  })
})

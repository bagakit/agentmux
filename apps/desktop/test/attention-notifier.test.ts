import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
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
      hookEvents: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      acp: false,
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

const away = { windowFocused: false, visibleSessionIds: new Set<string>() }

function ports() {
  return {
    notify: vi.fn(async () => ({ status: 'shown' as const })),
    onUnsupported: vi.fn()
  }
}

describe('attention notifier', () => {
  it('notifies on a transition into a category worth interrupting', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    const raised = await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })

    expect(raised.map((event) => event.category)).toEqual(['done'])
    expect(io.notify).toHaveBeenCalledWith({
      sessionId: 'a',
      title: 'Agent finished',
      body: 'Agent a finished its turn.'
    })
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
      visibleSessionIds: new Set(['a'])
    })

    expect(io.notify).not.toHaveBeenCalled()
  })

  it('reports an unsupported platform once, not on every event', async () => {
    const io = {
      notify: vi.fn(async () => ({ status: 'unsupported' as const, reason: 'Notifications are off.' })),
      onUnsupported: vi.fn()
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

  it('goes silent when disabled but keeps tracking, so re-enabling replays no backlog', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    notifier.setEnabled(false)
    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })
    expect(io.notify).not.toHaveBeenCalled()

    notifier.setEnabled(true)
    // The done transition happened while off. Re-enabling must not announce it retroactively.
    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })
    expect(io.notify).not.toHaveBeenCalled()

    // A genuinely new transition after re-enabling still notifies.
    await notifier.reconcile({ sessions: [agent('a', 'waiting')], ...away })
    expect(io.notify).toHaveBeenCalledOnce()
  })

  it('words each category for the person reading a banner out of context', async () => {
    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'waiting')], ...away })
    await notifier.reconcile({ sessions: [agent('a', 'error')], ...away })

    expect(io.notify.mock.calls.map((call) => call[0]!.title))
      .toEqual(['Agent needs you', 'Agent failed'])
    expect(io.notify.mock.calls.map((call) => call[0]!.body)).toEqual([
      'Agent a is waiting for your answer.',
      'Agent a stopped with an error.'
    ])
  })
})

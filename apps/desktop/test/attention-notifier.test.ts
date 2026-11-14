import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { createAttentionNotifier, type AttentionNotifierPorts, type AttentionReconcileInput } from '../src/renderer/src/lib/attention-notifier.js'

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
    workspacePath: _hygiene_fixturePath("repo"),
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
    notify: vi.fn(async () => ({ status: 'shown' as const, presentation: 'as-requested' as const }))
  }
}

// Drive the same current-snapshot port as the mounted hook; updates can happen during a delivery.
function drive(io: Omit<AttentionNotifierPorts, 'snapshot'>) {
  let input: AttentionReconcileInput = { ...away, sessions: [] }
  const owner = createAttentionNotifier({ ...io, snapshot: () => input })
  return { ...owner, current(next: AttentionReconcileInput) { input = next },
    reconcile(next: AttentionReconcileInput) { input = next; return owner.reconcile() } }
}

describe('attention notifier', () => {
  it('notifies on a transition into a category worth interrupting', async () => {
    const io = ports()
    const notifier = drive(io)
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
      const notifier = drive(io)
      notifier.seed([agent('a', 'working')])

      await notifier.reconcile({ sessions: [agent('a', 'done')], ...away, sound })

      expect(io.notify).toHaveBeenCalledWith(expect.objectContaining({ sound }))
    }
  })

  it('does not notify twice for the same state', async () => {
    const io = ports()
    const notifier = drive(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })
    // A second projection carrying the same fact must be silent — providers re-announce status.
    await notifier.reconcile({ sessions: [agent('a', 'done')], ...away })

    expect(io.notify).toHaveBeenCalledOnce()
  })

  it('seeds without notifying, so attaching does not replay old work', async () => {
    const io = ports()
    const notifier = drive(io)
    // Seeding with already-finished Agents must not fire: that work predates the app being open.
    notifier.seed([agent('a', 'done'), agent('b', 'waiting')])

    await notifier.reconcile({ sessions: [agent('a', 'done'), agent('b', 'waiting')], ...away })

    expect(io.notify).not.toHaveBeenCalled()
  })

  it('stays quiet about the Session the user is looking at', async () => {
    const io = ports()
    const notifier = drive(io)
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
    const notifier = drive(io)
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
    const notifier = drive(io)
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

  it('titles each category for the person reading a banner out of context', async () => {
    const io = ports()
    const notifier = drive(io)
    notifier.seed([agent('a', 'working')])

    await notifier.reconcile({ sessions: [agent('a', 'waiting')], ...away })
    await notifier.reconcile({ sessions: [agent('a', 'error')], ...away })

    expect(io.notify.mock.calls.map((call) => call[0]!.title))
      .toEqual(['Agent needs you', 'Agent failed'])
  })
})

it.each(['off', 'visible', 'second-visible', 'state', 'rebound', 'host', 'disposed'] as const)(
  'rechecks %s before the next status delivery after a native wait', async kind => {
    let finish!: (delivery: Awaited<ReturnType<AttentionNotifierPorts['notify']>>) => void
    const io = { notify: vi.fn<AttentionNotifierPorts['notify']>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ status: 'shown', presentation: 'as-requested' }) }
    const owner = drive(io)
    owner.seed([agent('a', 'working'), agent('b', 'working')])
    let current: AttentionReconcileInput = { ...away, sessions: [agent('a', 'done'), agent('b', 'done')] }
    const pending = owner.reconcile(current)
    if (kind === 'off') current = { ...current, mode: 'off' }
    if (kind === 'visible') current = { ...current, windowFocused: true, visibleSessionIds: new Set(['b']) }
    if (kind === 'second-visible') current = { ...current, windowFocused: true, visibleSessionIds: new Set(['b-view']),
      sessions: [...current.sessions, { ...agent('b', 'done'), id: 'b-view' }] }
    if (kind === 'state') current = { ...current, sessions: [agent('a', 'done'), agent('b', 'working')] }
    if (kind === 'host') current = { ...current, sessions: [agent('a', 'done'), { ...agent('b', 'done'), hostId: 'other-host' }] }
    if (kind === 'rebound') current = { ...current, sessions: [agent('a', 'done'), { ...agent('foreign', 'done'), id: 'b' }] }
    owner.current(current)
    if (kind === 'disposed') owner.dispose()
    finish({ status: 'shown', presentation: 'as-requested' })
    expect((await pending).map(event => event.sessionId)).toEqual(['a'])
    expect(io.notify).toHaveBeenCalledOnce()
  })

it('uses current preferences and conversation while preserving the original transition across unrelated changes', async () => {
  let finish!: (delivery: Awaited<ReturnType<AttentionNotifierPorts['notify']>>) => void
  const io = { notify: vi.fn<AttentionNotifierPorts['notify']>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ status: 'unknown', reason: 'Native display was not confirmed.' }) }
  const owner = drive(io)
  owner.seed([agent('a', 'working'), agent('b', 'working')])
  const current = { ...away, sessions: [agent('a', 'done'), agent('b', 'waiting')] }
  const pending = owner.reconcile(current)
  owner.current({ ...current, mode: 'patient', sound: true, sessions: [agent('a', 'done'), { ...agent('b', 'waiting'), label: 'Current task' }, agent('unrelated', 'working')],
    timelines: timelines('b', [timelineItem('assistant_message', 'Current original reply', 'r-current')]) })
  finish({ status: 'shown', presentation: 'as-requested' })
  expect((await pending).map(event => event.sessionId)).toEqual(['a', 'b'])
  expect(io.notify.mock.calls[1]![0]).toMatchObject({ sessionId: 'b', mode: 'patient', sound: true,
    body: 'Current task — Waiting for you\nCurrent task: Current original reply' })
})

it('an old batch cannot borrow a later A-B-A transition while same-state observations preserve a current one', async () => {
  for (const changed of [false, true]) {
    let finish!: (delivery: Awaited<ReturnType<AttentionNotifierPorts['notify']>>) => void
    const io = { notify: vi.fn<AttentionNotifierPorts['notify']>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ status: 'shown', presentation: 'as-requested' }) }
    const owner = drive(io)
    owner.seed([agent('a', 'working'), agent('b', 'working')])
    const waiting = { ...away, sessions: [agent('a', 'done'), agent('b', 'waiting')] }
    const old = owner.reconcile(waiting)
    if (changed) await owner.reconcile({ ...waiting, sessions: [agent('a', 'done'), agent('b', 'working')] })
    await owner.reconcile(waiting)
    finish({ status: 'shown', presentation: 'as-requested' })
    expect((await old).map(event => event.sessionId)).toEqual(changed ? ['a'] : ['a', 'b'])
    expect(io.notify.mock.calls.map(call => call[0].sessionId)).toEqual(['a', 'b'])
  }
})

it('never snapshots, submits or feeds back after an explicit dispose', async () => {
  const snapshot = vi.fn(() => ({ ...away, sessions: [agent('a', 'done')] })), io = ports()
  const owner = createAttentionNotifier({ ...io, snapshot })
  owner.dispose(); owner.dispose(); owner.seed([agent('a', 'working')])
  expect(await owner.reconcile()).toEqual([])
  expect(snapshot).not.toHaveBeenCalled(); expect(io.notify).not.toHaveBeenCalled()
})

it('announces one original transition for two background presentations and retains its baseline across display changes', async () => {
  const io = ports(), owner = drive(io)
  owner.seed([agent('canonical', 'working'), { ...agent('canonical', 'working'), id: 'second-view' }])
  const done = [agent('canonical', 'done'), { ...agent('canonical', 'done'), id: 'second-view' }]
  expect((await owner.reconcile({ ...away, sessions: done })).map(event => event.sessionId)).toEqual(['canonical'])
  await owner.reconcile({ ...away, sessions: done.slice(1) })
  expect(io.notify).toHaveBeenCalledOnce()
  await owner.reconcile({ ...away, sessions: [{ ...agent('canonical', 'waiting'), id: 'second-view' }] })
  expect(io.notify.mock.calls[1]![0]).toMatchObject({ sessionId: 'second-view', title: 'Agent needs you' })
})

it('a pending original transition may use its other accurate presentation after the first display disappears', async () => {
  let finish!: (value: unknown) => void
  const io = { notify: vi.fn<AttentionNotifierPorts['notify']>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ status: 'shown', presentation: 'as-requested' }) }
  const owner = drive(io)
  owner.seed([agent('a', 'working'), agent('b', 'working')])
  const pending = owner.reconcile({ ...away, sessions: [agent('a', 'done'), agent('b', 'waiting')] })
  owner.current({ ...away, sessions: [agent('a', 'done'), { ...agent('b', 'waiting'), id: 'second-b-view' }] })
  finish({ status: 'shown', presentation: 'as-requested' })
  expect((await pending).map(event => event.sessionId)).toEqual(['a', 'second-b-view'])
  expect(io.notify.mock.calls[1]![0]).toMatchObject({ sessionId: 'second-b-view', title: 'Agent needs you' })
})

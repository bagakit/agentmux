import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import {
  attentionEventFor,
  attentionEvents,
  categoryFor,
  nextAttentionStates
} from '../src/renderer/src/lib/attention-event.js'

function agent(
  id: string,
  state: AgentDisplayState,
  observedAt = 1
): Extract<SessionSnapshot, { kind: 'agent' }> {
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
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

// The user is elsewhere: window not focused, so nothing is being watched.
const away = { windowFocused: false, sessionVisible: false }

describe('attention event decision', () => {
  it('raises a done event when an Agent finishes while the user is away', () => {
    const event = attentionEventFor({
      session: agent('a', 'done', 42),
      previousState: 'working',
      visibility: away
    })

    expect(event).toEqual({ category: 'done', sessionId: 'a', label: 'Agent a', observedAt: 42 })
  })

  it('treats waiting and blocked as one needs-you category, matching the shared vocabulary', () => {
    // The rest of the app already collapses these two into "an Agent needs you"; a notification that
    // split them would contradict the dot sitting next to it.
    for (const state of ['waiting', 'blocked'] as const) {
      expect(
        attentionEventFor({ session: agent('a', state), previousState: 'working', visibility: away })
          ?.category
      ).toBe('needs-you')
    }
  })

  it('stays quiet when the same state is reported again', () => {
    // Providers re-announce status and a hook can deliver the same fact twice. Without this the user
    // is interrupted repeatedly for one event.
    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'done', visibility: away })
    ).toBeNull()
  })

  it('stays quiet on first sight, so attaching does not fire a burst for old work', () => {
    // Opening the app onto Sessions that finished hours ago must not notify: that is startup noise,
    // and it teaches people to ignore the channel.
    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: null, visibility: away })
    ).toBeNull()
  })

  it('does not interrupt the user with what they are already looking at', () => {
    const watching = { windowFocused: true, sessionVisible: true }

    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'working', visibility: watching })
    ).toBeNull()
  })

  it('still notifies for a focused window when that Session is off screen', () => {
    // A collapsed pane or a background tab group is not visible even with the window focused, so the
    // completion would otherwise go unseen.
    const elsewhere = { windowFocused: true, sessionVisible: false }

    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'working', visibility: elsewhere })
        ?.category
    ).toBe('done')
  })

  it('still notifies when the window lost focus, even though the Session is on screen', () => {
    // 这是最常见的那一种：你在等这个 Agent，切去浏览器看点别的，它跑完了。Session 还摊在屏幕上
    // （tab 没换），但你的眼睛不在那儿——正是该出通知的时刻。
    //
    // 判据落在 `&&` 的**接受**侧。压制条件是 `windowFocused && sessionVisible`，而此前三个 fixture
    // 是 {F,F}、{T,T}、{T,F}：把 `windowFocused &&` 整段删掉，三者的结果一个都不变
    //（实测：删掉那半个合取项，八个文件 94 条全绿）。少的就是这第四种组合 {F,T}，而它恰好是
    // 「切到别的应用」——删掉之后，这条路上的完成通知永久静默。
    const screenOnButLookingElsewhere = { windowFocused: false, sessionVisible: true }

    expect(
      attentionEventFor({
        session: agent('a', 'done'),
        previousState: 'working',
        visibility: screenOnButLookingElsewhere
      })?.category
    ).toBe('done')

    // 四种组合各钉一次，把「只有两者同时成立才压制」写成穷举而不是三个例子。少一格就是少一条路。
    const suppressed = ([true, false] as const).flatMap((windowFocused) =>
      ([true, false] as const).map((sessionVisible) => ({
        windowFocused,
        sessionVisible,
        quiet:
          attentionEventFor({
            session: agent('a', 'done'),
            previousState: 'working',
            visibility: { windowFocused, sessionVisible }
          }) === null
      }))
    )
    expect(suppressed).toEqual([
      { windowFocused: true, sessionVisible: true, quiet: true },
      { windowFocused: true, sessionVisible: false, quiet: false },
      { windowFocused: false, sessionVisible: true, quiet: false },
      { windowFocused: false, sessionVisible: false, quiet: false }
    ])
  })

  it('never raises attention for lifecycle noise or a dropped link', () => {
    // disconnected is absent on purpose: it is not a request for attention, and it has its own neutral
    // treatment precisely so amber means needs-you and nothing else. starting/running/exited are
    // process facts the tab and Board already carry.
    for (const state of ['starting', 'running', 'disconnected', 'exited', 'unknown'] as const) {
      expect(categoryFor(state as AgentDisplayState)).toBeNull()
      expect(
        attentionEventFor({
          session: agent('a', state as AgentDisplayState),
          previousState: 'working',
          visibility: away
        })
      ).toBeNull()
    }
  })

  it('raises an error event so a failure is not quieter than a success', () => {
    expect(
      attentionEventFor({ session: agent('a', 'error'), previousState: 'working', visibility: away })
        ?.category
    ).toBe('error')
  })

  it('folds a batch and ignores non-agent sessions', () => {
    const terminal = {
      id: 't',
      kind: 'terminal' as const,
      hostId: 'local',
      workspacePath: '/repo',
      label: 'Terminal',
      createdAt: 1,
      updatedAt: 1,
      processState: 'running' as const,
      status: { state: 'running' as const, source: 'run-process' as const, observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal' as const, hostId: 'local', run: { runId: 'run-t' } }
    } as unknown as SessionSnapshot

    const events = attentionEvents({
      sessions: [agent('a', 'done', 5), agent('b', 'waiting', 3), agent('c', 'working'), terminal],
      previousStates: new Map<string, AgentDisplayState>([
        ['a', 'working'],
        ['b', 'working'],
        ['c', 'starting']
      ]),
      visibilityFor: () => away
    })

    expect(events.map((event) => [event.sessionId, event.category])).toEqual([
      ['a', 'done'],
      ['b', 'needs-you']
    ])
  })

  it('forgets Sessions that disappeared so a returning one is a first sight again', () => {
    // Remembering a vanished Session would make its return look like a transition nobody witnessed.
    const states = nextAttentionStates([agent('a', 'done'), agent('b', 'working')])
    expect([...states.entries()]).toEqual([['a', 'done'], ['b', 'working']])

    const afterClose = nextAttentionStates([agent('b', 'working')])
    expect(afterClose.has('a')).toBe(false)
  })
})

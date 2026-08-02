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

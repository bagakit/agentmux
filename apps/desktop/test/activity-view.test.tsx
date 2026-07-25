import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ActivityView } from '../src/renderer/src/components/ActivityView.js'

function activity(
  id: string,
  overrides: Partial<AgentTimelineItem> = {}
): AgentTimelineItem {
  return {
    id,
    agentSessionId: 'agent-1',
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Assistant response',
    ...overrides
  }
}

function render(
  capability: 'unavailable' | 'complete-events' | 'streaming',
  items: AgentTimelineItem[] = []
): string {
  return renderToStaticMarkup(createElement(ActivityView, { capability, items }))
}

describe('ActivityView', () => {
  it('states that structured Activity is unavailable without inventing Terminal-derived items', () => {
    const markup = render('unavailable', [activity('stale-item')])

    expect(markup).toContain('does not provide structured activity')
    expect(markup).toContain('Terminal remains available')
    expect(markup).not.toContain('Assistant response')
  })

  it('distinguishes an available but empty Timeline from an unavailable capability', () => {
    const markup = render('complete-events')

    expect(markup).toContain('No structured activity yet')
    expect(markup).not.toContain('does not provide structured activity')
  })

  it('renders Core Timeline status, provenance, and prose without Provider branches', () => {
    const markup = render('streaming', [
      activity('ask', {
        kind: 'user_message',
        source: 'user',
        title: 'Prompt',
        content: 'Ship it',
        createdAt: 1,
        updatedAt: 1
      }),
      activity('edit', {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Edit',
        toolName: 'Edit',
        toolInput: 'runtime.ts',
        createdAt: 2,
        updatedAt: 2
      }),
      activity('failed', {
        kind: 'tool_call',
        status: 'failed',
        source: 'acp',
        title: 'Run tests',
        toolName: 'shell',
        toolInput: 'pnpm test',
        createdAt: 3,
        updatedAt: 3
      }),
      activity('reply', {
        status: 'streaming',
        source: 'native-hook',
        content: 'Working on it',
        createdAt: 4,
        updatedAt: 4
      })
    ])

    expect(markup).toContain('Structured Session activity only')
    expect(markup).toContain('never Terminal output or private chain-of-thought')
    expect(markup).toContain('Streaming')
    expect(markup).toContain('Failed')
    // Provenance lives on the machine rows; a turn carries its speaker in the caption and glyph, not a
    // native-hook/user label, so the register split is what keeps the conversation from reading machine.
    expect(markup).toContain('native-hook')
    expect(markup).toContain('acp')
    // Prose the agent and user produced is the substance of the trace and always renders.
    expect(markup).toContain('Working on it')
    expect(markup).toContain('Ship it')
    // A tool's arguments are machine payload: the row names the call and keeps the argv folded until
    // asked for, which is what stops a repeated tool loop from burying the conversation.
    expect(markup).toContain('Run tests')
    expect(markup).not.toContain('pnpm test')
  })

  it('folds a run of machine-reported steps into one disclosure and counts identical repeats', () => {
    const hook = (id: string, createdAt: number) =>
      activity(id, {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Bash',
        toolName: 'bash',
        toolInput: 'ls -la',
        createdAt,
        updatedAt: createdAt
      })
    const markup = render('complete-events', [
      activity('ask', { kind: 'user_message', source: 'user', title: 'User prompt', content: 'User prompt', createdAt: 1 }),
      hook('h1', 2),
      hook('h2', 3),
      hook('h3', 4),
      activity('reply', { source: 'acp', title: 'Assistant response', content: 'Assistant response', createdAt: 5, updatedAt: 5 })
    ])

    // The run collapses to a single summary row; the turns around it stay visible — their words render
    // in the turn register, not (as they once incidentally did) in a ruler tick's tooltip.
    expect(markup).toContain('3 steps')
    expect(markup).toContain('User prompt')
    expect(markup).toContain('Assistant response')
    // Collapsed means collapsed: the repeated step rows are not in the log at all. (The ruler still
    // carries a tick per event, so scope the check to the log itself.)
    const log = markup.slice(markup.indexOf('activity-log'))
    expect(log).not.toContain('Bash')
  })

  it('renders a user turn in the turn register — a speaker caption over the words, not a machine row', () => {
    const markup = render('complete-events', [
      activity('ask', {
        kind: 'user_message',
        source: 'user',
        title: 'Prompt',
        content: 'Make the adapter observable.'
      })
    ])

    // The turn lands in the conversation register, not the machine Row.
    expect(markup).toContain('log-turn log-turn--user_message')
    expect(markup).not.toContain('log-row log-row--user_message')
    // The words are the substance; the caption is the human speaker, not the generic machine title.
    expect(markup).toContain('log-turn__body')
    expect(markup).toContain('Make the adapter observable.')
    expect(markup).toContain('You')
  })

  it('never folds the assistant reply into a machine run, even when it is native-hook next to a tool call', () => {
    // Mirrors the shipped trace: a native-hook tool_call immediately followed by the native-hook
    // assistant reply. Folding by source alone would sweep the reply into "2 steps" and hide it.
    const markup = render('complete-events', [
      activity('a2', {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Edit',
        toolName: 'Edit',
        toolInput: 'packages/core/src/runtime.ts',
        createdAt: 1,
        updatedAt: 1
      }),
      activity('a3', {
        kind: 'assistant_message',
        source: 'native-hook',
        title: 'Assistant response',
        content: 'The runtime now emits typed session events from one owner.',
        createdAt: 2,
        updatedAt: 2
      })
    ])

    // The reply is a turn, on screen, in full — never behind a default-closed disclosure.
    expect(markup).toContain('log-turn log-turn--assistant_message')
    expect(markup).toContain('The runtime now emits typed session events from one owner.')
    expect(markup).toContain('Assistant')
    // The lone tool_call renders as a machine row; its argv stays folded.
    expect(markup).toContain('Edit')
    expect(markup).not.toContain('packages/core/src/runtime.ts')
  })

  it('renders a mid-turn steer as an interjection in the turn register, between the machine steps', () => {
    // A steer submitted while the Agent is working is recorded by Core as a `source: 'user'`
    // `user_message` landing BETWEEN the run's native-hook steps. It must read as conversation — a full
    // turn, never folded into the "N steps" run around it — so the trace shows when the human interjected
    // and why the Agent changed course. It keeps source 'user'; it never masquerades as native-hook.
    const markup = render('complete-events', [
      activity('h1', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
        createdAt: 1, updatedAt: 1
      }),
      activity('h2', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
        createdAt: 2, updatedAt: 2
      }),
      activity('steer', {
        kind: 'user_message', source: 'user', title: 'Prompt',
        content: 'Actually, focus on the parser instead.', createdAt: 3, updatedAt: 3
      }),
      activity('h3', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'parser.ts',
        createdAt: 4, updatedAt: 4
      }),
      activity('h4', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'parser2.ts',
        createdAt: 5, updatedAt: 5
      })
    ])

    // The steer renders as a turn with its words on screen — not a machine row, never behind a fold.
    expect(markup).toContain('log-turn log-turn--user_message')
    expect(markup).toContain('Actually, focus on the parser instead.')
    expect(markup).toContain('You')
    expect(markup).not.toContain('log-row log-row--user_message')

    // It is bracketed by machine steps, proving it landed mid-turn: the two runs on either side each fold
    // to "2 steps", and the steer sits between them rather than being swept into either.
    const log = markup.slice(markup.indexOf('activity-log'))
    expect(log).toContain('2 steps')
    const turnAt = log.indexOf('log-turn--user_message')
    const firstFold = log.indexOf('2 steps')
    const lastFold = log.lastIndexOf('2 steps')
    expect(firstFold).toBeGreaterThanOrEqual(0)
    expect(lastFold).toBeGreaterThan(firstFold) // two distinct folds exist
    expect(turnAt).toBeGreaterThan(firstFold) // steer comes after the first run
    expect(turnAt).toBeLessThan(lastFold) // and before the second — i.e. between the machine steps
  })

  it('shows no turn for a refused steer — a rejected submit records nothing', () => {
    // Core throws its readiness/interaction refusal BEFORE recordPromptAfterSideEffect, so a refused steer
    // appends no timeline item at all. The trace for a run whose steer was rejected therefore carries only
    // the machine steps — no user turn and no failed placeholder. Without this assertion a future real
    // dropped event would look identical to normal and pass silently.
    const markup = render('complete-events', [
      activity('h1', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
        createdAt: 1, updatedAt: 1
      }),
      activity('h2', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
        createdAt: 2, updatedAt: 2
      })
    ])

    expect(markup).not.toContain('log-turn--user_message')
    expect(markup).not.toContain('log-turn__body')
    // The machine steps that did happen are still there — the trace is not empty, it simply has no turn.
    expect(markup).toContain('2 steps')
  })

  it('spaces the ruler by real elapsed time, and says so when there is none to show', () => {
    const spread = render('complete-events', [
      activity('a', { createdAt: 1_000, updatedAt: 1_000 }),
      activity('b', { createdAt: 3_000, updatedAt: 3_000 }),
      activity('c', { createdAt: 5_000, updatedAt: 5_000 })
    ])
    // The middle event sits at the middle of the track: the axis is honest about the gaps.
    expect(spread).toContain('data-axis="temporal"')
    expect(spread).toContain('left:50%')

    // Same-instant events carry no spread to map, so they fall back to even ordinal spacing rather
    // than stacking every tick on the left edge and reading as a single event.
    const flat = render('complete-events', [
      activity('a', { createdAt: 1, updatedAt: 1 }),
      activity('b', { createdAt: 1, updatedAt: 1 }),
      activity('c', { createdAt: 1, updatedAt: 1 })
    ])
    expect(flat).toContain('data-axis="ordinal"')
    expect(flat).toContain('left:50%')
  })

  it('exposes the ruler as one focusable slider whose accessible value is honest per axis', () => {
    // The ruler is a single interactive control: focusable (tabindex, role=slider), and its accessible
    // name/value describe the axis without over-claiming. A temporal axis may name elapsed time; an
    // ordinal axis says only that the spacing is order. This is the a11y contract for click+keyboard.
    const temporal = render('complete-events', [
      activity('a', { createdAt: 1_000, updatedAt: 1_000 }),
      activity('b', { createdAt: 3_000, updatedAt: 3_000 })
    ])
    expect(temporal).toContain('role="slider"')
    expect(temporal).toContain('tabindex="0"')
    expect(temporal).toContain('aria-valuemin="1"')
    expect(temporal).toContain('aria-valuemax="2"')
    // The temporal axis is allowed to name the elapsed span in its label.
    expect(temporal).toMatch(/aria-label="Activity timeline, 2 events over [^"]*s"/)

    const ordinal = render('complete-events', [
      activity('a', { createdAt: 5, updatedAt: 5 }),
      activity('b', { createdAt: 5, updatedAt: 5 }),
      activity('c', { createdAt: 5, updatedAt: 5 })
    ])
    // The ordinal axis must NOT smuggle a duration into its label — order only, no fabricated span.
    expect(ordinal).toContain('aria-label="Activity timeline, 3 events in order"')
    expect(ordinal).not.toMatch(/aria-(label|valuetext)="[^"]*over[^"]*"/)
    // And nothing in the ordinal ruler renders a wall-clock time — no ":" time string leaks into a
    // tick title the way the pre-interactive ruler used to unconditionally emit one.
    const ruler = ordinal.slice(ordinal.indexOf('activity-ruler'), ordinal.indexOf('activity-log'))
    expect(ruler).not.toMatch(/title="[^"]*\d{1,2}:\d{2}/)
  })

  it('wraps each log segment in a scroll target the ruler can jump to, without a second scroller', () => {
    // Click/keyboard resolve a position to an event and scroll its host segment into view. The wiring is
    // the per-segment wrapper carrying a data key; the scroll itself reuses the shared scrollIntoView
    // primitive at runtime. Asserting the wrapper exists proves the target the jump lands on is real.
    const markup = render('complete-events', [
      activity('ask', { kind: 'user_message', source: 'user', title: 'Prompt', content: 'Hi', createdAt: 1 }),
      activity('reply', { source: 'native-hook', content: 'There', createdAt: 2_000, updatedAt: 2_000 })
    ])
    expect(markup).toContain('activity-log__segment')
  })
})

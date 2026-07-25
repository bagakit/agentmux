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
      activity('ask', { kind: 'user_message', source: 'user', title: 'User prompt', createdAt: 1 }),
      hook('h1', 2),
      hook('h2', 3),
      hook('h3', 4),
      activity('reply', { source: 'acp', title: 'Assistant response', createdAt: 5, updatedAt: 5 })
    ])

    // The run collapses to a single summary row; the turns around it stay visible.
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
})

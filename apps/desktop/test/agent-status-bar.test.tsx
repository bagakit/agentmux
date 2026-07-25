import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { AgentDisplayState } from '@agentmux/core'
import { summarizeAgentAttention } from '../src/renderer/src/lib/agent-attention.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    selectSession: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state)
}))

import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar.js'

type AnyProps = { [key: string]: unknown; children?: unknown }

// The component renders synchronously over the mocked store, so we can call it as a plain function
// and walk the returned element tree to find and fire the real onClick a user would trigger — no DOM
// needed, and no re-implementing the target logic the test is meant to check.
function findByAttention(node: unknown, attention: string): AnyProps | null {
  if (!node || typeof node !== 'object') return null
  const element = node as ReactElement<AnyProps>
  const props = element.props
  if (props && typeof props === 'object') {
    if ((props as AnyProps)['data-attention'] === attention) return props as AnyProps
    const children = (props as AnyProps).children
    const list = Array.isArray(children) ? children : [children]
    for (const child of list) {
      const found = findByAttention(child, attention)
      if (found) return found
    }
  }
  return null
}

function fireClick(element: ReactElement, attention: string): void {
  const props = findByAttention(element, attention)
  const onClick = props?.onClick
  if (typeof onClick !== 'function') throw new Error(`No clickable segment for ${attention}`)
  ;(onClick as () => void)()
}

function agent(id: string, state: AgentDisplayState, observedAt: number): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      acp: false,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function terminal(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: `run-${id}` } }
  }
}

describe('summarizeAgentAttention', () => {
  it('counts each attention class and ignores Terminal Sessions', () => {
    const rollup = summarizeAgentAttention([
      agent('a', 'working', 10),
      agent('b', 'waiting', 20),
      agent('c', 'blocked', 30),
      agent('d', 'error', 40),
      agent('e', 'done', 50),
      terminal('t')
    ])
    expect(rollup.total).toBe(5)
    expect(rollup.working).toBe(1)
    // waiting + blocked both fold into the single "needs you" class.
    expect(rollup.needsYou).toBe(2)
    expect(rollup.error).toBe(1)
  })

  it('targets the earliest session by observedAt within each attention class', () => {
    const rollup = summarizeAgentAttention([
      agent('late-block', 'blocked', 300),
      agent('early-wait', 'waiting', 100),
      agent('mid-wait', 'waiting', 200),
      agent('late-error', 'error', 90),
      agent('early-error', 'error', 50)
    ])
    // earliest across waiting|blocked is the wait at t=100, not the block at t=300.
    expect(rollup.needsYouSessionId).toBe('early-wait')
    expect(rollup.errorSessionId).toBe('early-error')
  })

  it('leaves jump targets null when an attention class is empty', () => {
    const rollup = summarizeAgentAttention([agent('a', 'working', 10)])
    expect(rollup.needsYou).toBe(0)
    expect(rollup.needsYouSessionId).toBeNull()
    expect(rollup.error).toBe(0)
    expect(rollup.errorSessionId).toBeNull()
  })
})

describe('AgentStatusBar', () => {
  it('renders nothing when no Agent Session exists', () => {
    fixture.state.sessions = [terminal('t')]
    expect(renderToStaticMarkup(createElement(AgentStatusBar))).toBe('')
  })

  it('stays neutral until a count crosses zero, then colours only that segment', () => {
    fixture.state.sessions = [agent('a', 'working', 10)]
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))
    // total and needs-you and error are all-or-nothing neutral here; only working carries colour.
    expect(markup).toContain('status status--working')
    expect(markup).not.toContain('status--waiting')
    expect(markup).not.toContain('status--error')
  })

  it('makes the needs-you and error segments clickable only when populated', () => {
    // Scoped to the attention segments on purpose: the total segment is now the roster's disclosure and
    // is always actionable, so counting every --action would conflate two different questions.
    const attentionButtons = (markup: string): number =>
      (markup.match(/<button[^>]*data-attention="(?:needs-you|error)"/gu) ?? []).length

    fixture.state.sessions = [agent('a', 'working', 10)]
    const idle = renderToStaticMarkup(createElement(AgentStatusBar))
    // With nothing needing attention, neither attention segment is a button.
    expect(attentionButtons(idle)).toBe(0)

    fixture.state.sessions = [agent('w', 'waiting', 10), agent('e', 'error', 20)]
    const active = renderToStaticMarkup(createElement(AgentStatusBar))
    expect(active).toContain('data-attention="needs-you"')
    expect(active).toContain('status status--waiting')
    expect(active).toContain('status status--error')
    // Both populated attention segments become actionable.
    expect(attentionButtons(active)).toBe(2)
  })

  it('jumps a needs-you click to the earliest waiting|blocked session', () => {
    fixture.state.selectSession = vi.fn()
    fixture.state.sessions = [
      agent('late', 'blocked', 300),
      agent('earliest', 'waiting', 100),
      agent('err', 'error', 50)
    ]
    // Fire the segment's real onClick and assert the component chose the earliest waiting|blocked id.
    fireClick(AgentStatusBar() as ReactElement, 'needs-you')
    expect(fixture.state.selectSession).toHaveBeenCalledWith('earliest')
  })

  it('jumps an error click to the earliest session in error', () => {
    fixture.state.selectSession = vi.fn()
    fixture.state.sessions = [
      agent('late-error', 'error', 200),
      agent('early-error', 'error', 40),
      agent('w', 'waiting', 10)
    ]
    fireClick(AgentStatusBar() as ReactElement, 'error')
    expect(fixture.state.selectSession).toHaveBeenCalledWith('early-error')
  })

  it('names the rollup as a group so its aria-label is a real accessible name', () => {
    // A bare div is a generic node; role="group" turns the aria-label into an announced name.
    fixture.state.sessions = [agent('a', 'working', 10)]
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))
    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Agent attention across this window"')
  })

  it('folds the count into each action segment’s accessible name so AT hears the fact, not just the jump', () => {
    // The button’s aria-label overrides its inner "N needs you" text, so the number must live in
    // the label itself or a screen-reader user loses it. Singular and plural both carry the count.
    fixture.state.sessions = [agent('w', 'waiting', 10), agent('e', 'error', 20)]
    const single = findByAttention(AgentStatusBar() as ReactElement, 'needs-you')
    expect(single?.['aria-label']).toBe('1 agent needs you. Jump to the one waiting longest.')
    const singleError = findByAttention(AgentStatusBar() as ReactElement, 'error')
    expect(singleError?.['aria-label']).toBe('1 agent in error. Jump to the earliest.')

    fixture.state.sessions = [
      agent('w1', 'waiting', 10),
      agent('b1', 'blocked', 15),
      agent('e1', 'error', 20),
      agent('e2', 'error', 25)
    ]
    const many = findByAttention(AgentStatusBar() as ReactElement, 'needs-you')
    expect(many?.['aria-label']).toBe('2 agents need you. Jump to the one waiting longest.')
    const manyError = findByAttention(AgentStatusBar() as ReactElement, 'error')
    expect(manyError?.['aria-label']).toBe('2 agents in error. Jump to the earliest.')
  })
})

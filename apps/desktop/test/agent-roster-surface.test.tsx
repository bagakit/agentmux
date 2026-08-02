import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 这条 surface 现在（经 AgentStatusBar）连着资源面板，而资源面板要读 api，api 在模块加载时
// 就要判断跑在哪个宿主里。不先立起这个全局，import 阶段就炸，测的什么都还没跑到。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as AgentCatalogEntry[],
    selectSession: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { AgentRoster } from '../src/renderer/src/components/AgentRoster.js'
import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar.js'

function agent(
  id: string,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): SessionSnapshot {
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
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as unknown as SessionSnapshot
}

function catalogEntry(): AgentCatalogEntry {
  return {
    id: 'codex',
    label: 'Codex',
    launchOptions: [
      {
        id: 'sandbox',
        label: 'Sandbox',
        choices: [
          { id: 'read-only', label: 'Read only', tier: 'safe' },
          { id: 'danger-full-access', label: 'Danger full access', tier: 'danger' }
        ]
      }
    ]
  } as unknown as AgentCatalogEntry
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.providerCatalog = []
  fixture.state.selectSession.mockClear()
})

describe('agent roster surface', () => {
  it('costs only the count that was already on the bar until it is opened', () => {
    // Collapsed is a trigger carrying the same total the bar showed before; the list is not rendered.
    fixture.state.sessions = [agent('a'), agent('b')]
    const markup = renderToStaticMarkup(createElement(AgentRoster, { total: 2 }))

    expect(markup).toContain('agent-roster__trigger')
    expect(markup).toContain('>2<')
    // Radix keeps the content unmounted while closed, so no row and no heading are in the DOM.
    expect(markup).not.toContain('agent-roster__row')
    expect(markup).not.toContain('Agents in this window')
  })

  it('does not render at all when the window projects no Agent', () => {
    expect(renderToStaticMarkup(createElement(AgentRoster, { total: 0 }))).toBe('')
  })

  it('replaces the bar total with the roster trigger, so one fact has one control', () => {
    // The total segment already owned "how many Agents exist"; the enumerable list belongs to it rather
    // than to a second control competing for the same number.
    fixture.state.sessions = [agent('a')]
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))

    expect(markup).toContain('agent-roster__trigger')
    // Still one bar, still the shared status vocabulary.
    expect(markup).toContain('agent-status-bar')
    expect(markup).toContain('status__dot')
  })

  it('names the count in the trigger label so a reader gets the fact, not just a control', () => {
    fixture.state.sessions = [agent('a'), agent('b'), agent('c')]
    const markup = renderToStaticMarkup(createElement(AgentRoster, { total: 3 }))

    expect(markup).toContain('3 agents in this window')
    // Singular reads correctly too.
    fixture.state.sessions = [agent('a')]
    expect(renderToStaticMarkup(createElement(AgentRoster, { total: 1 })))
      .toContain('1 agent in this window')
  })

  it('keeps the bar rendering nothing when the window holds no Agent Session', () => {
    // The bar's existing contract: it occupies no space at all rather than showing an empty rollup.
    expect(renderToStaticMarkup(createElement(AgentStatusBar))).toBe('')
  })
})

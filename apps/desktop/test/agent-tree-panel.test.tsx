import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { allStyleRules } from './helpers/styles.js'

// 状态栏挂着资源面板，资源面板 import 阶段要判宿主。不先立这个全局，一条断言都跑不到。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as AgentCatalogEntry[],
    config: null as { workspaces: WorkspaceRecord[] } | null,
    selectSession: vi.fn(),
    reportError: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar.js'
import { AgentTreePanel } from '../src/renderer/src/components/AgentRoster.js'

function agent(id: string, state: AgentDisplayState, workspacePath = '/repo/one'): SessionSnapshot {
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
    workspacePath,
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function workspace(id: string, name: string, path: string): WorkspaceRecord {
  return { id, name, hostId: 'local', path, kind: 'folder' }
}

type AnyProps = { [key: string]: unknown; children?: unknown }
function findByAttention(node: unknown, attention: string): AnyProps | null {
  if (!node || typeof node !== 'object') return null
  const props = (node as ReactElement<AnyProps>).props
  if (props && typeof props === 'object') {
    if ((props as AnyProps)['data-attention'] === attention) return props as AnyProps
    const children = (props as AnyProps).children
    for (const child of Array.isArray(children) ? children : [children]) {
      const found = findByAttention(child, attention)
      if (found) return found
    }
  }
  return null
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.providerCatalog = []
  fixture.state.config = null
  fixture.state.selectSession.mockClear()
  fixture.state.reportError.mockClear()
})

describe('AgentTreePanel — the project→Agent tree behind a count', () => {
  it('renders nothing when its class is empty — a zero count is not a dead click', () => {
    fixture.state.sessions = [agent('done', 'done')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    // No working agent -> the working tree renders nothing at all (no chevron, no popover trigger).
    const markup = renderToStaticMarkup(
      createElement(AgentTreePanel, { filter: 'working', heading: 'Working · by project', label: 'x' })
    )
    expect(markup).toBe('')
  })

  it('discloses a chevron trigger when the class is populated', () => {
    fixture.state.sessions = [agent('a', 'working')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    const markup = renderToStaticMarkup(
      createElement(AgentTreePanel, { filter: 'working', heading: 'Working · by project', label: 'Show working' })
    )
    expect(markup).toContain('agent-tree__disclose')
    expect(markup).toContain('aria-label="Show working"')
  })
})

describe('AgentStatusBar — counts disclose without losing the jump', () => {
  it('keeps the needs-you and error one-click jump buttons (no capability removed)', () => {
    fixture.state.sessions = [agent('w', 'waiting'), agent('e', 'error')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }

    // The jump buttons still exist, still carry data-attention, still fire selectSession on click.
    const needsYou = findByAttention(AgentStatusBar() as ReactElement, 'needs-you')
    expect(typeof needsYou?.onClick).toBe('function')
    ;(needsYou!.onClick as () => void)()
    expect(fixture.state.selectSession).toHaveBeenCalledWith('w')

    const error = findByAttention(AgentStatusBar() as ReactElement, 'error')
    expect(typeof error?.onClick).toBe('function')
  })

  it('adds a disclosure chevron beside each populated count', () => {
    fixture.state.sessions = [agent('go', 'working'), agent('w', 'waiting'), agent('e', 'error')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))
    // Three classes populated -> three disclosure chevrons.
    expect((markup.match(/agent-tree__disclose/gu) ?? []).length).toBe(3)
  })

  it('groups every count with its own reset, compact disclosure button', () => {
    fixture.state.sessions = [agent('go', 'working'), agent('w', 'waiting'), agent('e', 'error')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    const document = new Window().document
    document.body.innerHTML = renderToStaticMarkup(createElement(AgentStatusBar))
    const groups = [...document.querySelectorAll('.agent-status-bar__group')]
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.querySelector('.agent-status-bar__label')?.textContent))
      .toEqual(['working', 'needs you', 'error'])
    expect(groups.map((group) => group.querySelectorAll('.agent-tree__disclose').length)).toEqual([1, 1, 1])
    const buttons = groups.map((group) => group.querySelector('.agent-tree__disclose')!)
    expect(buttons.map((button) => button.classList.contains('agent-status-bar__segment'))).toEqual([true, true, true])
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button', 'button'])
    const css = allStyleRules()
    const reset = css.match(/\.agent-status-bar__segment\s*\{([^}]+)\}/)?.[1]
    expect(reset).toBeDefined()
    expect(reset).toMatch(/border:\s*0;/)
    expect(reset).toMatch(/padding:\s*0;/)
    expect(reset).toMatch(/background:\s*transparent;/)
    const compact = css.match(/\.agent-tree__disclose\s*\{([^}]+)\}/)?.[1]
    expect(compact).toBeDefined()
    expect(compact).toMatch(/width:\s*16px;/)
    expect(compact).toMatch(/height:\s*16px;/)
    expect(compact).toContain('justify-content: center')
    expect(css).toMatch(/\.agent-tree__disclose:hover,\s*\.agent-tree__disclose:focus-visible,\s*\.agent-tree__disclose\[data-state='open'\]\s*\{[^}]*background:/)
  })

  it('a zero class shows no chevron — consistent across all three counts', () => {
    // Only working is populated; needs-you and error are zero and disclose nothing.
    fixture.state.sessions = [agent('go', 'working')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))
    expect((markup.match(/agent-tree__disclose/gu) ?? []).length).toBe(1)
  })

  it('an all-idle window discloses no chevron at all — the working panel is always mounted', () => {
    // The working segment renders AgentTreePanel unconditionally, so this is the case that proves the
    // empty-state guard fires there too: a done Agent means working=0, and a panel that opened anyway
    // would show a chevron over an empty tree — a dead click.
    fixture.state.sessions = [agent('done', 'done')]
    fixture.state.config = { workspaces: [workspace('w1', 'One', '/repo/one')] }
    const markup = renderToStaticMarkup(createElement(AgentStatusBar))
    expect((markup.match(/agent-tree__disclose/gu) ?? []).length).toBe(0)
  })
})

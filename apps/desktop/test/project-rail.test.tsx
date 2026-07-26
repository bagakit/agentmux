import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { workingAgentCount } from '../src/renderer/src/lib/project-board.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

const fixture = vi.hoisted(() => ({
  state: {
    config: null as AppConfig | null,
    sessions: [] as SessionSnapshot[],
    activeWorkspaceId: 'project-a',
    mainSurface: 'workbench' as const,
    projectRailOpen: true,
    toolsOpen: false,
    selectWorkspace: vi.fn(async () => {}),
    setMainSurface: vi.fn(),
    setConfig: vi.fn(),
    toggleProjectRail: vi.fn(),
    toggleTools: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { workspaces: { chooseLocalFolder: vi.fn(async () => null) } }
}))

import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'project-a', name: 'Alpha', hostId: 'local', path: '/alpha', kind: 'folder' },
    { id: 'project-b', name: 'Beta', hostId: 'local', path: '/beta', kind: 'folder' },
    { id: 'project-c', name: 'Gamma', hostId: 'local', path: '/gamma', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function session(
  id: string,
  workspacePath: string,
  state: SessionSnapshot['status']['state'],
  kind: SessionSnapshot['kind'] = 'agent'
): SessionSnapshot {
  if (kind === 'terminal') {
    return {
      id,
      kind: 'terminal',
      providerId: null,
      hostId: 'local',
      workspacePath,
      label: id,
      createdAt: 1,
      updatedAt: 1,
      processState: 'running',
      status: { state, source: 'run-process', observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal', hostId: 'local', run: { runId: `run-${id}` } }
    }
  }
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function renderRail(): string {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, { onOpenSettings: vi.fn() }))
}

afterEach(() => {
  fixture.state.config = structuredClone(config)
  fixture.state.sessions = []
  fixture.state.activeWorkspaceId = 'project-a'
})

describe('workingAgentCount', () => {
  it('uses the Board working column and excludes idle, finished, and terminal sessions', () => {
    expect(workingAgentCount([
      session('starting', '/alpha', 'starting'),
      session('running', '/alpha', 'running'),
      session('working', '/alpha', 'working'),
      session('waiting', '/alpha', 'waiting'),
      session('done', '/alpha', 'done'),
      session('terminal', '/alpha', 'running', 'terminal')
    ])).toBe(3)
  })
})

describe('Project Rail selection and running signals', () => {
  it('shows a running marker for every running project, including the selected one', () => {
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [
      session('agent-a', '/alpha', 'working'),
      session('agent-b', '/beta', 'running'),
      session('agent-c', '/gamma', 'waiting')
    ]
    const markup = renderRail()
    const runningRows = markup.match(/data-running="true"/g) ?? []
    expect(runningRows).toHaveLength(2)
    expect(markup).toContain('project-rail-row--active')
    expect(markup).toContain('class="project-rail-row__activity status status--working"')
    expect(markup).toContain('Alpha · 1 Agent is running')
    expect(markup).toContain('Beta · 1 Agent is running')
    expect(markup).not.toContain('Gamma · 1 Agent is running')
  })

  it('keeps selected and running independent across all four combinations', () => {
    fixture.state.config = structuredClone(config)
    fixture.state.sessions = [session('agent-b', '/beta', 'working')]
    fixture.state.activeWorkspaceId = 'project-a'
    let markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(1)
    expect(markup).toContain('project-rail-row--active')

    fixture.state.sessions = [session('agent-a', '/alpha', 'working')]
    fixture.state.activeWorkspaceId = 'project-a'
    markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(1)
    expect(markup).toContain('Alpha · 1 Agent is running')

    fixture.state.sessions = []
    fixture.state.activeWorkspaceId = 'project-a'
    markup = renderRail()
    expect(markup.match(/data-running="true"/g) ?? []).toHaveLength(0)
    expect(markup).toContain('project-rail-row--active')
  })

  it('removes the repeated project icon while retaining Scratch identity', () => {
    fixture.state.config = structuredClone(config)
    const markup = renderRail()
    const projectRows = [...markup.matchAll(/<button[^>]+class="project-rail-row(?:"| )[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .filter((row) => row.includes('project-rail-row__identity'))
    expect(projectRows).toHaveLength(4)
    const regularRows = projectRows.filter((row) => !row.includes('scratch-workspace-row'))
    expect(regularRows).toHaveLength(3)
    expect(regularRows.every((row) => !row.includes('project-rail-row__icon'))).toBe(true)
    expect(markup).toContain('scratch-workspace-row__icon')
  })
})

describe('Project Rail style contract', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/styles/chrome.css', import.meta.url),
    'utf8'
  )

  it('scans the Project Rail rules and keeps the section label below row-title emphasis', () => {
    const heading = source.match(/\.sidebar__section-heading\s*\{([^}]*)\}/)?.[1] ?? ''
    const row = source.match(/\.project-rail-row\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(heading.length).toBeGreaterThan(0)
    expect(row.length).toBeGreaterThan(0)
    expect(heading).toContain('font-size: var(--fs-micro)')
    expect(heading).toContain('font-weight: 560')
    expect(heading).toContain('text-transform: none')
  })

  it('does not brighten a project icon in the selected rule and has a separate running slot', () => {
    expect(source).not.toContain('.project-rail-row--active .project-rail-row__icon')
    expect(source).toContain('.project-rail-row__activity')
    expect(source).toContain('.project-rail-row__activity .status__dot')
  })
})

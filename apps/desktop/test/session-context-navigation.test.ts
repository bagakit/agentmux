import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../src/renderer/src/store.js'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board.js'

const baseline = useAppStore.getState()

const workspace: WorkspaceRecord = {
  id: 'context-workspace', name: 'Context repo', hostId: 'local', path: '/context-repo', kind: 'folder'
}

const session: SessionSnapshot = {
  id: 'context-session',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: workspace.path,
  label: 'Context session',
  createdAt: 1,
  updatedAt: 2,
  processState: 'running',
  status: { state: 'working', source: 'run-process', observedAt: 2 },
  latestOutputBytes: 0,
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'context-session', run: { runId: 'context-run' } }
}

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [workspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function demand(): DemandRecord {
  return {
    id: 'demand:context', title: 'Context demand', description: 'Keeps the selected Session visible on Board',
    status: 'in_progress', priority: 'normal', projectId: workspace.id, projectName: workspace.name,
    sessionIds: [session.id], createdAt: 1, updatedAt: 2, source: 'session'
  }
}

function prepare(): void {
  useAppStore.setState({
    config,
    sessions: [session],
    activeWorkspaceId: workspace.id,
    tabs: {},
    layouts: { [workspace.id]: createWorkspaceLayout('context-pane') },
    demands: {},
    selectedAgentSessionId: null,
    selectedDemandId: null,
    mainSurface: 'agents',
    error: null
  })
}

afterEach(() => {
  useAppStore.setState(baseline, true)
})

describe('selected Session context across main surfaces', () => {
  it('records the Session when opening it and returns to its Workspaces Region', () => {
    prepare()

    useAppStore.getState().selectSession(session.id, 'context-pane')
    const opened = useAppStore.getState()
    expect(opened.selectedAgentSessionId).toBe(session.id)
    expect(opened.mainSurface).toBe('workbench')
    expect(Object.values(opened.tabs).some((tab) => Object.values(tab.regions).some((surface) => surface.kind === 'agent' && surface.sessionId === session.id))).toBe(true)

    useAppStore.getState().setMainSurface('agents')
    useAppStore.getState().setMainSurface('workbench')
    expect(useAppStore.getState().selectedAgentSessionId).toBe(session.id)
    expect(useAppStore.getState().mainSurface).toBe('workbench')
  })

  it('selects the linked Demand when the same Session context enters Board', () => {
    prepare()
    useAppStore.setState({ selectedAgentSessionId: session.id, demands: { [demand().id]: demand() } })

    useAppStore.getState().setMainSurface('board')

    expect(useAppStore.getState()).toMatchObject({ mainSurface: 'board', selectedDemandId: 'demand:context' })
  })
})

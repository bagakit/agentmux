import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { addTab, createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const baseline = useAppStore.getState()
const workspace: WorkspaceRecord = { id: 'workspace', name: 'Workspace', hostId: 'local', path: '/repo', kind: 'folder' }
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [workspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function terminalSession(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  }
}

afterEach(() => useAppStore.setState(baseline, true))

describe('execution focus history from Workbench surfaces', () => {
  it('records the Terminal Session when its Region becomes focused', () => {
    const session = terminalSession('terminal-1')
    const tab = createWorkbenchTab('terminal-tab', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: session.id
    })
    const layout = addTab(createWorkspaceLayout('group'), 'group', tab.id)
    useAppStore.setState({
      config,
      sessions: [session],
      tabs: { [tab.id]: tab },
      layouts: { [workspace.id]: layout },
      agentFocus: EMPTY_AGENT_FOCUS,
      activeWorkspaceId: workspace.id
    })

    useAppStore.getState().focusRegion(workspace.id, tab.id, 'terminal-region')

    const focus = useAppStore.getState().agentFocus
    expect(focus.execution.sessionId).toBe(session.id)
    expect(focus.execution.history).toEqual([{ sessionId: session.id, focusedAt: expect.any(Number) }])
    expect(focus.pmo.sessionId).toBeNull()
  })
})

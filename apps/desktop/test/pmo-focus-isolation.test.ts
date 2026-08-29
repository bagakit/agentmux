import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import { useAppStore } from '../src/renderer/src/store.js'

const baseline = useAppStore.getState()
const workspace: WorkspaceRecord = { id: 'project', name: 'Project', hostId: 'local', path: '/project', kind: 'folder' }
const scratch: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' }
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [workspace, scratch],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function session(id: string, workspacePath: string): SessionSnapshot {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    label: id, createdAt: 1, updatedAt: 2, processState: 'running',
    status: { state: 'working', source: 'run-process', observedAt: 2 }, latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

afterEach(() => useAppStore.setState(baseline, true))

describe('PMO focus isolation', () => {
  it('keeps execution focus and history when selecting a PMO Session', () => {
    const execution = session('execution-1', workspace.path)
    const pmo = session('pmo-1', `${scratch.path}/topic--launcher--leader`)
    useAppStore.setState({
      config, sessions: [execution, pmo], tabs: {},
      layouts: { [workspace.id]: createWorkspaceLayout('project-group'), [scratch.id]: createWorkspaceLayout('scratch-group') },
      activeWorkspaceId: workspace.id,
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
      mainSurface: 'agents'
    })

    useAppStore.getState().selectSession(execution.id, 'project-group')
    const beforePmo = useAppStore.getState().agentFocus
    useAppStore.getState().selectSession(pmo.id, 'scratch-group')
    const afterPmo = useAppStore.getState().agentFocus

    expect(beforePmo.execution).toEqual({ sessionId: execution.id, history: [{ sessionId: execution.id, focusedAt: expect.any(Number) }] })
    expect(afterPmo.execution).toEqual(beforePmo.execution)
    expect(afterPmo.pmo.sessionId).toBe(pmo.id)
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentActivity, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state.js'
import {
  reduceDocumentContent,
  reduceDocumentSaved,
  reduceFileClosed,
  reduceFileOpened
} from '../src/renderer/src/lib/file-workbench-state.js'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { documentKey, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

const session: SessionSnapshot = {
  id: 'session-1',
  kind: 'agent',
  agentId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  label: 'Codex',
  createdAt: 1,
  updatedAt: 2,
  processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 2 },
  latestOutputBytes: 0,
  control: {
    kind: 'agent',
    hostId: 'local',
    agentSessionId: 'session-1',
    run: { runId: 'run-1', incarnationId: 'incarnation-1' }
  }
}

const activity: AgentActivity = {
  id: 'activity-1',
  sessionId: session.id,
  kind: 'lifecycle',
  source: 'user',
  createdAt: 2,
  title: 'Started'
}

function core(event: RuntimeEvent['event']): RuntimeEvent {
  return { type: 'core', hostId: 'local', event }
}

describe('Renderer resource state owners', () => {
  it('ignores late events from an old Run incarnation even when Agent Session identity matches', () => {
    const tabId = `session:${session.id}`
    const state = {
      sessions: [session],
      activities: { [session.id]: [activity] },
      tabs: {
        [tabId]: {
          id: tabId,
          kind: 'agent' as const,
          phase: 'attached' as const,
          workspaceId: 'workspace-1',
          sessionId: session.id
        }
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'conversation' as const }
    }
    const staleRun = { ...session.control.run, incarnationId: 'stale-incarnation' }

    const afterState = reduceRuntimeEvent(state, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: staleRun,
      state: 'exited',
      pid: 99,
      exitCode: 1,
      evidence: { source: 'run-process', observedAt: 10, run: staleRun }
    }))
    const afterRemoval = reduceRuntimeEvent(afterState, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: staleRun,
      evidence: { source: 'user', observedAt: 11, run: staleRun }
    }))

    expect(afterRemoval).toEqual(state)
  })

  it('owns every Runtime Event transition and fully removes Session resources', () => {
    const tabId = `session:${session.id}`
    let state = {
      sessions: [session],
      activities: { [session.id]: [activity] },
      tabs: {
        [tabId]: {
          id: tabId,
          kind: 'agent',
          phase: 'attached',
          workspaceId: 'workspace-1',
          sessionId: session.id
        } satisfies WorkbenchTab
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'conversation' as const }
    }

    state = reduceRuntimeEvent(state, core({
      type: 'agent-status',
      agentSessionId: session.id,
      state: 'waiting',
      evidence: { source: 'native-hook', observedAt: 3, run: session.control.run }
    }))
    state = reduceRuntimeEvent(state, core({
      type: 'terminal-output',
      agentSessionId: session.id,
      run: session.control.run,
      data: 'Waiting for approval',
      evidence: {
        source: 'terminal-output',
        observedAt: 4,
        run: session.control.run,
        outputByteRange: { startByte: 0, endByte: 20 }
      }
    }))
    state = reduceRuntimeEvent(state, core({
      type: 'agent-activity',
      agentSessionId: session.id,
      activity: { id: 'activity-2', kind: 'lifecycle', createdAt: 4, title: 'Started' },
      evidence: { source: 'native-hook', observedAt: 4, run: session.control.run }
    }))
    expect(state.sessions[0]).toMatchObject({
      status: { state: 'waiting' },
      latestOutputBytes: 20,
      updatedAt: 3
    })
    expect(state.activities[session.id]).toHaveLength(2)

    state = reduceRuntimeEvent(state, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: session.control.run,
      evidence: { source: 'user', observedAt: 5, run: session.control.run }
    }))
    expect(state.sessions).toEqual([])
    expect(state.activities[session.id]).toBeUndefined()
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
    expect(state.viewModes[session.id]).toBeUndefined()
  })

  it('removes a launching Tab when Core removes the matching Session', () => {
    const tabId = `session:${session.id}`
    const state = reduceRuntimeEvent({
      sessions: [session],
      activities: {},
      tabs: {
        [tabId]: {
          id: tabId,
          kind: 'agent',
          phase: 'launching',
          workspaceId: 'workspace-1',
          sessionId: session.id
        }
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: {}
    }, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: session.control.run,
      evidence: { source: 'user', observedAt: 5, run: session.control.run }
    }))

    expect(state.sessions).toEqual([])
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
  })

  it('owns Browser update and close convergence across Tab and Layout', () => {
    const tabId = 'browser-tab'
    const browserTab = {
      id: tabId,
      kind: 'browser' as const,
      workspaceId: 'workspace-1',
      browserId: 'browser-1',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null
    }
    let state = {
      tabs: { [tabId]: browserTab },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) }
    }
    state = reduceBrowserEvent(state, {
      type: 'updated',
      browser: { ...browserTab, id: 'browser-1', title: 'Docs', url: 'https://example.com/' }
    })
    expect(state.tabs[tabId]).toMatchObject({ title: 'Docs', url: 'https://example.com/' })

    state = reduceBrowserEvent(state, { type: 'closed', id: 'browser-1' })
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
  })

  it('owns File open, edit, and save transitions without Store side effects', () => {
    const workspaceId = 'workspace-1'
    let state = {
      tabs: {},
      documents: {},
      dirtyDocuments: {},
      layouts: { [workspaceId]: createWorkspaceLayout('pane') },
      lastActiveFileByWorkspace: {}
    }
    state = reduceFileOpened(
      state,
      workspaceId,
      'src/app.ts',
      { path: 'src/app.ts', content: 'before' }
    )
    const tabId = `file:${workspaceId}:src/app.ts`
    state = reduceDocumentContent(state, tabId, 'after')
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toEqual({
      path: 'src/app.ts',
      content: 'after'
    })
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(true)

    state = reduceDocumentSaved(state, workspaceId, 'src/app.ts')
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(false)
    expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe(tabId)

    state = reduceFileClosed(state, workspaceId, 'pane', tabId)
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.lastActiveFileByWorkspace[workspaceId]).toBeUndefined()
  })
})

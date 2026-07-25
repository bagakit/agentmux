import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state.js'
import {
  reduceDocumentContent,
  reduceDocumentWritten,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileRename,
  type FileWorkbenchState,
  reconcileWorkbenchFileProjection
} from '../src/renderer/src/lib/file-workbench-state.js'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  documentKey,
  initialWorkbenchRegionId,
  titleWorkbenchSurface,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  applyWorkbenchViewCloseTopology,
  planWorkbenchViewClose,
  reconcileWorkbenchViewClose
} from '../src/renderer/src/lib/workbench-view-close.js'

const session: SessionSnapshot = {
  id: 'session-1',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  capabilities: {
    terminal: true,
    hookEvents: true,
    timeline: 'complete-events',
    permission: 'observe',
    providerResume: true,
    acp: false,
    replyCorrelation: 'none'
  },
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
    run: { runId: 'run-1' }
  }
}

const timelineItem: AgentTimelineItem = {
  id: 'activity-1',
  agentSessionId: session.id,
  kind: 'lifecycle',
  status: 'complete',
  source: 'user',
  createdAt: 2,
  updatedAt: 2,
  title: 'Started'
}

function core(event: RuntimeEvent['event']): RuntimeEvent {
  return { type: 'core', hostId: 'local', event }
}

function sessionTab(tabId: string, phase: 'launching' | 'attached') {
  return createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'agent',
    phase,
    workspaceId: 'workspace-1',
    sessionId: session.id
  })
}

describe('Renderer resource state owners', () => {
  it('keeps terminal output out of the global Session projection', () => {
    const state = {
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {},
      layouts: {},
      viewModes: {}
    }

    const next = reduceRuntimeEvent(state, core({
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

    expect(next).toBe(state)
  })

  it('ignores old-Run lifecycle events but accepts committed Session Timeline revisions', () => {
    const tabId = `session:${session.id}`
    const state = {
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [timelineItem] }
      },
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'attached')
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'activity' as const }
    }
    const staleRun = { runId: 'stale-run' }

    const afterState = reduceRuntimeEvent(state, core({
      type: 'process-state',
      agentSessionId: session.id,
      run: staleRun,
      state: 'exited',
      pid: 99,
      exitCode: 1,
      evidence: { source: 'run-process', observedAt: 10, run: staleRun }
    }))
    const afterTimeline = reduceRuntimeEvent(afterState, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 2,
      mutation: {
        type: 'append',
        agentSessionId: session.id,
        item: {
          ...timelineItem,
          id: 'stale-run-item',
          updatedAt: 10,
          createdAt: 10,
          title: 'Stale run'
        }
      },
      evidence: { source: 'native-hook', observedAt: 10, run: staleRun }
    }))
    const afterRemoval = reduceRuntimeEvent(afterTimeline, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: staleRun,
      evidence: { source: 'user', observedAt: 11, run: staleRun }
    }))

    expect(afterRemoval.sessions[0]).toMatchObject({
      id: session.id,
      processState: 'running',
      control: { run: session.control.run }
    })
    expect(afterRemoval.timelines[session.id]).toMatchObject({
      revision: 2,
      items: [
        timelineItem,
        expect.objectContaining({ id: 'stale-run-item', title: 'Stale run' })
      ]
    })
  })

  it('owns every Runtime Event transition and fully removes Session resources', () => {
    const tabId = `session:${session.id}`
    let state = {
      sessions: [session],
      timelines: {
        [session.id]: { agentSessionId: session.id, revision: 1, items: [timelineItem] }
      },
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'attached')
      },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) },
      viewModes: { [session.id]: 'activity' as const }
    }

    state = reduceRuntimeEvent(state, core({
      type: 'agent-status',
      agentSessionId: session.id,
      state: 'waiting',
      evidence: { source: 'native-hook', observedAt: 3, run: session.control.run }
    }))
    state = reduceRuntimeEvent(state, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 2,
      mutation: {
        type: 'append',
        agentSessionId: session.id,
        item: {
          id: 'activity-2',
          agentSessionId: session.id,
          kind: 'assistant_message',
          status: 'streaming',
          source: 'native-hook',
          createdAt: 4,
          updatedAt: 4,
          title: 'Assistant response',
          content: 'Hello'
        }
      },
      evidence: { source: 'native-hook', observedAt: 4, run: session.control.run }
    }))
    expect(state.sessions[0]).toMatchObject({
      status: { state: 'waiting' },
      latestOutputBytes: 0,
      updatedAt: 4
    })
    state = reduceRuntimeEvent(state, core({
      type: 'agent-timeline',
      agentSessionId: session.id,
      revision: 3,
      mutation: {
        type: 'update',
        agentSessionId: session.id,
        itemId: 'activity-2',
        updatedAt: 5,
        status: 'complete',
        content: 'Hello, world'
      },
      evidence: { source: 'native-hook', observedAt: 5, run: session.control.run }
    }))
    expect(state.timelines[session.id]).toMatchObject({ revision: 3 })
    expect(state.timelines[session.id]?.items).toHaveLength(2)
    expect(state.timelines[session.id]?.items[1]).toMatchObject({ content: 'Hello, world', status: 'complete' })

    state = reduceRuntimeEvent(state, core({
      type: 'run-removed',
      agentSessionId: session.id,
      run: session.control.run,
      evidence: { source: 'user', observedAt: 6, run: session.control.run }
    }))
    expect(state.sessions).toEqual([])
    expect(state.timelines[session.id]).toBeUndefined()
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.layouts['workspace-1']?.groups[0]?.tabOrder).toEqual([])
    expect(state.viewModes[session.id]).toBeUndefined()
  })

  it('removes a launching Tab when Core removes the matching Session', () => {
    const tabId = `session:${session.id}`
    const state = reduceRuntimeEvent({
      sessions: [session],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: {
        [tabId]: sessionTab(tabId, 'launching')
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
    const browserRegionId = initialWorkbenchRegionId(tabId)
    const browserSurface = {
      id: 'browser-1',
      regionId: browserRegionId,
      kind: 'browser' as const,
      workspaceId: 'workspace-1',
      browserId: 'browser-1',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'responsive',
      error: null
    }
    const browserTab = createWorkbenchTab(tabId, browserSurface)
    let state = {
      tabs: { [tabId]: browserTab },
      layouts: { 'workspace-1': createWorkspaceLayout('pane', [tabId]) }
    }
    state = reduceBrowserEvent(state, {
      type: 'updated',
      browser: { ...browserSurface, title: 'Docs', url: 'https://example.com/' }
    })
    expect(titleWorkbenchSurface(state.tabs[tabId]!)).toMatchObject({
      title: 'Docs',
      url: 'https://example.com/'
    })

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
      documentGenerations: {},
      documentObservationGenerations: {},
      documentIssues: {},
      savingDocuments: {},
      layouts: { [workspaceId]: createWorkspaceLayout('pane') },
      lastActiveFileByWorkspace: {}
    }
    state = reduceFileOpened(
      state,
      workspaceId,
      'src/app.ts',
      { path: 'src/app.ts', content: 'before', revision: 'revision-before' }
    )
    const tabId = `file:${workspaceId}:src/app.ts`
    state = reduceDocumentContent(state, tabId, 'after')
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toEqual({
      path: 'src/app.ts',
      content: 'after',
      revision: 'revision-before'
    })
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(true)

    state = reduceDocumentWritten(state, workspaceId, 'src/app.ts', 1, 'revision-after')
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBe(false)
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]?.revision).toBe('revision-after')
    expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe(tabId)

    const plan = planWorkbenchViewClose({
      tabs: state.tabs,
      layouts: state.layouts,
      sessions: [],
      workspaceId,
      tabGroupId: 'pane',
      tabId,
      keepAgentSessions: false
    })!
    const reconciliation = reconcileWorkbenchViewClose({
      plan,
      currentTab: state.tabs[tabId],
      currentSessions: [],
      receipts: []
    })
    state = reconcileWorkbenchFileProjection(
      state,
      applyWorkbenchViewCloseTopology(state, plan, reconciliation.tab)
    )
    expect(state.tabs[tabId]).toBeUndefined()
    expect(state.documents[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.dirtyDocuments[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentGenerations[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentObservationGenerations[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.documentIssues[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.savingDocuments[documentKey(workspaceId, 'src/app.ts')]).toBeUndefined()
    expect(state.lastActiveFileByWorkspace[workspaceId]).toBeUndefined()
  })

  it('rekeys and removes File owners in non-title Regions without replacing the View', () => {
    const workspaceId = 'workspace-1'
    const tabId = `file:${workspaceId}:src/title.ts`
    const titleRegionId = initialWorkbenchRegionId(tabId)
    const detailRegionId = 'region:detail'
    const titleTab = createWorkbenchTab(tabId, {
      regionId: titleRegionId,
      kind: 'file',
      workspaceId,
      path: 'src/title.ts'
    })
    const tab = addWorkbenchRegion(titleTab, titleRegionId, 'right', {
      regionId: detailRegionId,
      kind: 'file',
      workspaceId,
      path: 'src/detail/value.ts'
    })
    const detailKey = documentKey(workspaceId, 'src/detail/value.ts')
    const state: FileWorkbenchState = {
      tabs: { [tabId]: tab },
      documents: {
        [documentKey(workspaceId, 'src/title.ts')]: {
          path: 'src/title.ts', content: 'title', revision: 'revision-title'
        },
        [detailKey]: { path: 'src/detail/value.ts', content: 'detail', revision: 'revision-detail' }
      },
      dirtyDocuments: { [detailKey]: true },
      documentGenerations: { [detailKey]: 2 },
      documentObservationGenerations: { [detailKey]: 3 },
      documentIssues: { [detailKey]: { kind: 'deleted' } },
      savingDocuments: { [detailKey]: true },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [tabId]) },
      lastActiveFileByWorkspace: { [workspaceId]: 'src/detail/value.ts' },
      fileExplorerStates: {
        [workspaceId]: {
          selection: {
            activePath: 'src/detail/value.ts',
            anchorPath: 'src/detail/value.ts',
            selectedPaths: new Set(['src/detail/value.ts', 'src/details.ts'])
          },
          expandedPaths: new Set(['src/detail', 'src/details'])
        }
      }
    }

    const renamed = reduceFileRename(state, workspaceId, 'src/detail', 'src/renamed')
    const renamedKey = documentKey(workspaceId, 'src/renamed/value.ts')
    expect(renamed.tabs[tabId]?.layout).toEqual(tab.layout)
    expect(workbenchSurfaces(renamed.tabs[tabId]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ regionId: titleRegionId, path: 'src/title.ts' }),
      expect.objectContaining({ regionId: detailRegionId, path: 'src/renamed/value.ts' })
    ]))
    expect(renamed.documents[renamedKey]).toMatchObject({ path: 'src/renamed/value.ts' })
    expect(renamed.documentGenerations[renamedKey]).toBe(2)
    expect(renamed.documentObservationGenerations[renamedKey]).toBe(3)
    expect(renamed.documentIssues[renamedKey]).toEqual({ kind: 'deleted' })
    expect(renamed.savingDocuments[renamedKey]).toBe(false)
    expect(renamed.fileExplorerStates[workspaceId]?.selection).toEqual({
      activePath: 'src/renamed/value.ts',
      anchorPath: 'src/renamed/value.ts',
      selectedPaths: new Set(['src/renamed/value.ts', 'src/details.ts'])
    })
    expect(renamed.fileExplorerStates[workspaceId]?.expandedPaths).toEqual(
      new Set(['src/renamed', 'src/details'])
    )

    const deleted = reduceFileDelete(renamed, workspaceId, 'src/renamed')
    expect(deleted.tabs[tabId]).toBeDefined()
    expect(workbenchSurfaces(deleted.tabs[tabId]!)).toEqual([
      expect.objectContaining({ regionId: titleRegionId, path: 'src/title.ts' })
    ])
    expect(deleted.documents[renamedKey]).toBeUndefined()
    expect(deleted.documentGenerations[renamedKey]).toBeUndefined()
    expect(deleted.documentObservationGenerations[renamedKey]).toBeUndefined()
    expect(deleted.documentIssues[renamedKey]).toBeUndefined()
    expect(deleted.savingDocuments[renamedKey]).toBeUndefined()
    expect(deleted.fileExplorerStates[workspaceId]?.selection).toEqual({
      activePath: 'src/details.ts',
      anchorPath: 'src/details.ts',
      selectedPaths: new Set(['src/details.ts'])
    })
    expect(deleted.fileExplorerStates[workspaceId]?.expandedPaths).toEqual(new Set(['src/details']))
  })

  it('rekeys changed observation payloads without touching prefix-neighbor issues', () => {
    const workspaceId = 'workspace-1'
    const sourcePath = 'src/app/index.ts'
    const neighborPath = 'src/application.ts'
    const sourceKey = documentKey(workspaceId, sourcePath)
    const neighborKey = documentKey(workspaceId, neighborPath)
    const sourceTabId = `file:${workspaceId}:${sourcePath}`
    const sourceTab = createWorkbenchTab(sourceTabId, {
      regionId: initialWorkbenchRegionId(sourceTabId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    const state: FileWorkbenchState = {
      tabs: { [sourceTabId]: sourceTab },
      documents: {
        [sourceKey]: { path: sourcePath, content: 'draft', revision: 'source-revision' },
        [neighborKey]: { path: neighborPath, content: 'neighbor', revision: 'neighbor-revision' }
      },
      dirtyDocuments: { [sourceKey]: true, [neighborKey]: true },
      documentGenerations: {},
      documentObservationGenerations: {},
      documentIssues: {
        [sourceKey]: {
          kind: 'changed',
          observed: { path: sourcePath, content: 'observed', revision: 'observed-revision' }
        },
        [neighborKey]: { kind: 'deleted' }
      },
      savingDocuments: {},
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceTabId]) },
      lastActiveFileByWorkspace: { [workspaceId]: sourcePath },
      fileExplorerStates: {}
    }

    const renamed = reduceFileRename(state, workspaceId, 'src/app', 'src/moved')
    const destinationKey = documentKey(workspaceId, 'src/moved/index.ts')

    expect(renamed.documentIssues[sourceKey]).toBeUndefined()
    expect(renamed.documentIssues[destinationKey]).toEqual({
      kind: 'changed',
      observed: {
        path: 'src/moved/index.ts',
        content: 'observed',
        revision: 'observed-revision'
      }
    })
    expect(renamed.documentIssues[neighborKey]).toBe(state.documentIssues[neighborKey])
    expect(renamed.documents[neighborKey]).toBe(state.documents[neighborKey])
  })
})

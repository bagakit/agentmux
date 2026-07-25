import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  projectPersistedWorkbench,
  restorePersistedWorkbench
} from '../src/renderer/src/lib/workbench-persistence.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const config: AppConfig = {
  version: 6,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }
}

function session(id: string): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId: `run-${id}` }
    }
  }
}

function splitView() {
  const viewId = 'view'
  const leftRegionId = initialWorkbenchRegionId(viewId)
  let tab = createWorkbenchTab(viewId, {
    regionId: leftRegionId,
    kind: 'agent' as const,
    phase: 'attached' as const,
    workspaceId: 'workspace',
    sessionId: 'left'
  })
  tab = addWorkbenchRegion(tab, leftRegionId, 'right', {
    regionId: 'right-top',
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId: 'right-top'
  })
  tab = addWorkbenchRegion(tab, 'right-top', 'down', {
    regionId: 'right-bottom',
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId: 'right-bottom'
  })
  return tab
}

describe('durable Workbench presentation', () => {
  it('starts with empty Views instead of expanding background Sessions when no Workbench was persisted', () => {
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('background')],
      persisted: null,
      createTabGroupId: () => 'group'
    })

    expect(restored.tabs).toEqual({})
    expect(restored.layouts.workspace?.groups[0]?.tabOrder).toEqual([])
  })

  it('restores one split View instead of exploding its Sessions into Tabs', () => {
    const tab = splitView()
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('left'), session('right-top'), session('right-bottom')],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })

    expect(Object.keys(restored.tabs)).toEqual([tab.id])
    expect(workbenchSurfaces(restored.tabs[tab.id]!)).toHaveLength(3)
    expect(restored.tabs[tab.id]!.layout).toEqual(tab.layout)
    expect(restored.layouts.workspace?.groups[0]?.tabOrder).toEqual([tab.id])
  })

  it('collapses a missing Session Region without reopening background Sessions as Tabs', () => {
    const tab = splitView()
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('left'), session('right-bottom'), session('new')],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })

    expect(workbenchSurfaces(restored.tabs[tab.id]!).flatMap((surface) => (
      surface.kind === 'agent' || surface.kind === 'terminal' ? [surface.sessionId] : []
    ))).toEqual([
      'left',
      'right-bottom'
    ])
    expect(restored.layouts.workspace?.groups[0]?.tabOrder).toEqual([
      tab.id
    ])
    expect(restored.layouts.workspace?.groups[0]?.activeTabId).toBe(tab.id)
  })

  it('persists only attached Session Regions and keeps their remaining split tree', () => {
    let tab = splitView()
    tab = addWorkbenchRegion(tab, 'right-bottom', 'right', {
      regionId: 'launcher',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })

    expect(workbenchSurfaces(projected.tabs[tab.id]!)).toHaveLength(3)
    expect(projected.tabs[tab.id]!.regions.launcher).toBeUndefined()
  })

  it('restores a Scratch View Topic when its Agent cwd is the Topic directory', () => {
    const scratchConfig: AppConfig = {
      ...config,
      workspaces: [{
        id: SCRATCH_WORKSPACE_ID,
        name: 'Scratch',
        hostId: 'local',
        path: '/scratch',
        kind: 'folder'
      }]
    }
    const scratchSession = {
      ...session('scratch-agent'),
      workspacePath: '/scratch/topic--view--shared-topic'
    }
    const viewId = 'view:shared-topic'
    const regionId = initialWorkbenchRegionId(viewId)
    const tab = {
      ...createWorkbenchTab(viewId, {
        regionId,
        kind: 'agent' as const,
        phase: 'attached' as const,
        workspaceId: SCRATCH_WORKSPACE_ID,
        sessionId: scratchSession.id
      }),
      topicId: viewId
    }

    const restored = restorePersistedWorkbench({
      config: scratchConfig,
      sessions: [scratchSession],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })

    expect(restored.tabs[viewId]?.topicId).toBe(viewId)
    expect(restored.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.tabOrder).toEqual([viewId])
  })

  it('keeps an empty Scratch Topic owner View across restart', () => {
    const viewId = 'view:empty-topic'
    const tab = {
      ...createWorkbenchTab(viewId, {
        regionId: initialWorkbenchRegionId(viewId),
        kind: 'launcher' as const,
        workspaceId: SCRATCH_WORKSPACE_ID
      }),
      topicId: viewId
    }
    const persisted = projectPersistedWorkbench({
      tabs: { [viewId]: tab },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [viewId]) }
    })
    const restored = restorePersistedWorkbench({
      config: {
        ...config,
        workspaces: [{
          id: SCRATCH_WORKSPACE_ID,
          name: 'Scratch',
          hostId: 'local',
          path: '/scratch',
          kind: 'folder'
        }]
      },
      sessions: [],
      persisted,
      createTabGroupId: () => 'new-group'
    })

    expect(restored.tabs[viewId]).toEqual(tab)
    expect(restored.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.tabOrder).toEqual([viewId])
  })
})

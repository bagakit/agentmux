import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import { readFileSync } from 'node:fs'

const initialState = useAppStore.getState()
const scratch: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID,
  name: 'Scratch',
  hostId: 'local',
  path: '/scratch',
  kind: 'folder'
}
const project: WorkspaceRecord = {
  id: 'project-a',
  name: 'Project A',
  hostId: 'local',
  path: '/project-a',
  kind: 'folder'
}
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [scratch, project],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const snapshot = {
  id: 'view:shared',
  directoryPath: '/scratch/view-shared',
  topicPath: '/scratch/view-shared/topic.md',
  title: 'Shared',
  summary: 'A shared Topic',
  collaborators: []
}

function mount(): void {
  const tab = createWorkbenchTab('launcher:shared', {
    regionId: initialWorkbenchRegionId('launcher:shared'),
    kind: 'launcher',
    workspaceId: SCRATCH_WORKSPACE_ID
  })
  useAppStore.setState({
    config,
    activeWorkspaceId: project.id,
    mainSurface: 'board',
    tabs: { [tab.id]: { ...tab, topicId: snapshot.id } },
    layouts: {
      [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [tab.id]),
      [project.id]: createWorkspaceLayout('project-group')
    },
    error: null
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Topic navigation reveals the visible workbench', () => {
  it('switches from another main surface to the Scratch workbench and focuses an existing Tab', async () => {
    mount()
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(snapshot)

    await useAppStore.getState().openScratchTopic(snapshot.id, SCRATCH_WORKSPACE_ID)

    const state = useAppStore.getState()
    expect(state.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(state.mainSurface).toBe('workbench')
    expect(state.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe('launcher:shared')
  })

  it('keeps the durable work surface when Topic metadata cannot be read', async () => {
    mount()
    const before = useAppStore.getState()
    vi.spyOn(api.scratch, 'readTopic').mockRejectedValue(new Error('metadata unavailable'))

    await expect(useAppStore.getState().openScratchTopic(snapshot.id, SCRATCH_WORKSPACE_ID)).rejects.toThrow('metadata unavailable')

    const after = useAppStore.getState()
    expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(after.mainSurface).toBe(before.mainSurface)
    expect(after.layouts).toEqual(before.layouts)
    expect(after.tabs).toEqual(before.tabs)
  })

  it('keeps Leader preparation explicitly backgrounded', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/LeaderTopicFloatingPanel.tsx', import.meta.url), 'utf8')
    const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
    expect(panel).toContain('openScratchTopic(LEADER_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })')
    expect(store).toContain('const reveal = options?.reveal ?? true')
    expect(store).toContain('activeWorkspaceId: workspace.id')
  })
})

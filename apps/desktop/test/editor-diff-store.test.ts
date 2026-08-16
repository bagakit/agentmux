import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store owns three decisions this file guards:
//   1. openFileDiff opens a file AND flips its canonical Region into diff mode — the "click a change →
//      see its diff" end-to-end path. The regionId must be the file's canonical one, or the mode lands
//      on a Region that is not showing this file.
//   2. Entering diff mode loads the diff through the existing git bridge (HEAD vs worktree), and toggling
//      back to edit and forward again does NOT refetch (the payload is cached per Region).
//   3. pruneEditorRegionState drops mode/diff for Regions no longer on the board, so a closed-then-
//      reopened file returns to edit rather than resurrecting a stale diff (regionIds are deterministic).

const fileApi = vi.hoisted(() => {
  const observes: Array<{ workspaceId: string; path: string }> = []
  const reads: Array<{ workspaceId: string; path: string }> = []
  return {
    observes,
    reads,
    document: { path: 'src/app.ts', content: 'worktree body', revision: 'r1' },
    api: {
      files: {
        observe: async (workspaceId: string, path: string) => { observes.push({ workspaceId, path }) },
        unobserve: async () => {},
        read: async (workspaceId: string, path: string) => {
          reads.push({ workspaceId, path })
          return { status: 'read', document: fileApi.document }
        },
        onInvalidated: () => () => {}
      }
    }
  }
})

const git = vi.hoisted(() => {
  const diffCalls: Array<{ workspaceId: string; path: string }> = []
  return {
    diffCalls,
    diff: vi.fn(async (workspaceId: string, path: string) => {
      diffCalls.push({ workspaceId, path })
      return {
        path,
        old: { present: true, binary: false, text: 'head body' },
        new: { present: true, binary: false, text: 'worktree body' },
        binary: false,
        change: 'modified' as const
      }
    })
  }
})

vi.mock('../src/renderer/src/lib/api.js', () => ({ api: fileApi.api }))

import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  fileTabId,
  initialWorkbenchRegionId
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const WORKSPACE: WorkspaceRecord = {
  id: 'diff-workspace',
  name: 'Diff fixture',
  hostId: 'local',
  path: '/fixture',
  kind: 'folder'
}
const CONFIG: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [WORKSPACE],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const PATH = 'src/app.ts'

beforeEach(() => {
  // window.agentmux.git is the same bridge the Changes panel uses; the diff loader reads it at call time.
  ;(globalThis as unknown as { window?: unknown }).window = { agentmux: { git } }
})

function seedActiveWorkspace(): void {
  useAppStore.setState({
    config: CONFIG,
    activeWorkspaceId: WORKSPACE.id,
    tabs: {},
    layouts: { [WORKSPACE.id]: createWorkspaceLayout('group', []) }
  })
}

afterEach(() => {
  useAppStore.setState(initialState, true)
  fileApi.observes.splice(0)
  fileApi.reads.splice(0)
  git.diffCalls.splice(0)
  git.diff.mockClear()
})

describe('editor diff / word-wrap store actions', () => {
  it('openFileDiff opens the file and flips its CANONICAL Region into diff mode', async () => {
    seedActiveWorkspace()
    await useAppStore.getState().openFileDiff(PATH)
    const regionId = initialWorkbenchRegionId(fileTabId(WORKSPACE.id, PATH))
    const state = useAppStore.getState()
    // Mode landed on the file's own Region — not some other id.
    expect(state.editorRegionModes[regionId]).toBe('diff')
    // And the file is actually open (document attached), so the diff has something behind it.
    expect(state.tabs[fileTabId(WORKSPACE.id, PATH)]).toBeTruthy()
  })

  it('entering diff mode loads the diff through the git bridge (HEAD vs worktree)', async () => {
    seedActiveWorkspace()
    const regionId = initialWorkbenchRegionId(fileTabId(WORKSPACE.id, PATH))
    await useAppStore.getState().setEditorRegionMode(regionId, WORKSPACE.id, PATH, 'diff')
    expect(git.diff).toHaveBeenCalledWith(WORKSPACE.id, PATH)
    const loaded = useAppStore.getState().editorRegionDiffs[regionId]
    expect(loaded?.loading).toBe(false)
    expect(loaded?.diff?.old).toEqual({ present: true, binary: false, text: 'head body' })
    expect(loaded?.diff?.new).toEqual({ present: true, binary: false, text: 'worktree body' })
  })

  it('toggling edit→diff→edit→diff does not refetch a cached diff; reload forces a fetch', async () => {
    seedActiveWorkspace()
    const regionId = initialWorkbenchRegionId(fileTabId(WORKSPACE.id, PATH))
    await useAppStore.getState().setEditorRegionMode(regionId, WORKSPACE.id, PATH, 'diff')
    await useAppStore.getState().setEditorRegionMode(regionId, WORKSPACE.id, PATH, 'edit')
    await useAppStore.getState().setEditorRegionMode(regionId, WORKSPACE.id, PATH, 'diff')
    expect(git.diff).toHaveBeenCalledTimes(1)
    await useAppStore.getState().reloadRegionDiff(regionId, WORKSPACE.id, PATH)
    expect(git.diff).toHaveBeenCalledTimes(2)
  })

  it('toggleEditorWordWrap flips the global bit', () => {
    expect(useAppStore.getState().editorWordWrap).toBe(false)
    useAppStore.getState().toggleEditorWordWrap()
    expect(useAppStore.getState().editorWordWrap).toBe(true)
    useAppStore.getState().toggleEditorWordWrap()
    expect(useAppStore.getState().editorWordWrap).toBe(false)
  })

  it('pruneEditorRegionState via closeRegion drops a closed Region\'s stale diff mode', async () => {
    // A file Region's id is deterministic, so without pruning a reopened file would resurrect diff mode.
    seedActiveWorkspace()
    // Two Regions in one tab so the tab survives the close (single-Region close removes the whole tab).
    const tabId = 'multi'
    const rootRegion = initialWorkbenchRegionId(tabId)
    const tab = createWorkbenchTab(tabId, {
      regionId: rootRegion,
      kind: 'launcher',
      workspaceId: WORKSPACE.id
    })
    useAppStore.setState({
      tabs: { [tabId]: tab },
      layouts: { [WORKSPACE.id]: createWorkspaceLayout('group', [tabId]) }
    })
    useAppStore.getState().splitRegion(WORKSPACE.id, tabId, rootRegion, 'right')
    const split = useAppStore.getState().tabs[tabId]!
    const addedRegion = Object.keys(split.regions).find((id) => id !== rootRegion)!
    // Mark the region-to-be-closed as in diff mode.
    useAppStore.setState({ editorRegionModes: { [addedRegion]: 'diff' } })

    await useAppStore.getState().closeRegion(WORKSPACE.id, tabId, addedRegion)

    expect(useAppStore.getState().editorRegionModes[addedRegion]).toBeUndefined()
  })
})

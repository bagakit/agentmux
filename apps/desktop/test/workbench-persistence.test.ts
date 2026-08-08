import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { regionIds } from '../src/renderer/src/lib/workbench-view-layout.js'
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
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
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

// These fixtures/guards protect the「重启后 tab 和分屏没了」fix: the save side must stop stripping file
// Regions and the restore side must stop killing whole tabs for a non-Session Region. Each guard is
// paired in the report with the mutation it kills (see the probe/report). Browser Regions stay stripped
// whole by decision — there is no cold-start lifecycle that revives one into a usable blank page.
function agentSurface(regionId: string, sessionId: string, workspaceId = 'workspace') {
  return {
    regionId,
    kind: 'agent' as const,
    phase: 'attached' as const,
    workspaceId,
    sessionId
  }
}

function agentPlusFile(filePath: string, fileWorkspaceId = 'workspace') {
  const viewId = 'view:agent-file'
  const left = initialWorkbenchRegionId(viewId)
  let tab = createWorkbenchTab(viewId, agentSurface(left, 'af-agent'))
  tab = addWorkbenchRegion(tab, left, 'right', {
    regionId: 'af-file',
    kind: 'file',
    workspaceId: fileWorkspaceId,
    path: filePath
  })
  return { viewId, tab }
}

describe('durable Workbench file/browser projection', () => {
  it('G1: keeps a file Region and its split alive through projection', () => {
    const { viewId, tab } = agentPlusFile('/repo/src/main.ts')
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })
    const projectedTab = projected.tabs[viewId]!
    expect(workbenchSurfaces(projectedTab)).toHaveLength(2)
    const fileSurface = projectedTab.regions['af-file']!
    expect(fileSurface.kind).toBe('file')
    expect(fileSurface.kind === 'file' && fileSurface.path).toBe('/repo/src/main.ts')
    expect(projectedTab.layout.root.type).toBe('split')
  })

  it('G2: persists relative and absolute file paths verbatim, without normalizing', () => {
    for (const path of ['docs/notes.md', '/repo/abs/config.env']) {
      const viewId = `file:workspace:${path}`
      const tab = createWorkbenchTab(viewId, {
        regionId: initialWorkbenchRegionId(viewId),
        kind: 'file',
        workspaceId: 'workspace',
        path
      })
      const projected = projectPersistedWorkbench({
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      })
      const projectedTab = projected.tabs[viewId]
      // Assert survival BEFORE dereferencing regions: if the save side strips file Regions again, the
      // solo file tab collapses to zero and projected.tabs[viewId] is undefined. This must redden as a
      // clean assertion ("expected undefined to be defined"), not crash inside workbenchSurfaces.
      expect(projectedTab).toBeDefined()
      const surface = projectedTab!.regions[initialWorkbenchRegionId(viewId)]!
      expect(surface.kind === 'file' && surface.path).toBe(path)
    }
  })

  it('G3: strips a browser Region whole (no url/title/navigationId, Region gone)', () => {
    const viewId = 'view:agent-browser'
    const left = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, agentSurface(left, 'ab-agent'))
    tab = addWorkbenchRegion(tab, left, 'right', {
      regionId: 'ab-browser',
      kind: 'browser',
      workspaceId: 'workspace',
      browserId: 'ab-browser',
      id: 'ab-browser',
      navigationId: 'nav-secret',
      profileId: 'profile-1',
      url: 'https://secret.example.com/x',
      title: 'Secret',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewport: 'responsive',
      error: null
    })
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })
    const projectedTab = projected.tabs[viewId]!
    expect(workbenchSurfaces(projectedTab)).toHaveLength(1)
    expect(projectedTab.regions['ab-browser']).toBeUndefined()
    // Two-sided guard: the browser's page content is stripped AND the agent sibling of the same split
    // structurally survives. A one-sided "browser Region gone" check would still pass if the WHOLE tab
    // had collapsed — which is exactly the「分屏没了」half of the bug. Assert the agent slot is still here.
    expect(projectedTab.regions[left]!.kind).toBe('agent')
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('secret.example.com')
    expect(serialized).not.toContain('nav-secret')
  })

  it('G4: restores a file Region (workspace still configured) with path and split intact', () => {
    const { viewId, tab } = agentPlusFile('/repo/src/main.ts')
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('af-agent')],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })
    const restoredTab = restored.tabs[viewId]!
    expect(workbenchSurfaces(restoredTab)).toHaveLength(2)
    const fileSurface = restoredTab.regions['af-file']!
    expect(fileSurface.kind === 'file' && fileSurface.path).toBe('/repo/src/main.ts')
    expect(restoredTab.layout).toEqual(tab.layout)
  })

  it('G5: on restore, removes only the non-surviving Region and keeps the tab (collapses to leaf)', () => {
    // A file's out-of-bounds case cannot be a split sibling of a surviving Region: addWorkbenchRegion
    // forces every Region to share the tab's workspaceId, so an unconfigured file implies an
    // unconfigured agent sibling too (that is G6, whole-tab collapse). The genuinely constructible
    // partial-removal on the non-session branch is [agent(attached, configured) | launcher(non-topic)]:
    // the agent survives, the non-topic launcher is dropped via removeWorkbenchRegion. This one guard
    // kills BOTH restore mutations — return-null (whole tab dies, agent lost) and bare-continue (the
    // launcher wrongly survives) — and proves the split collapses to a leaf without killing the tab.
    const viewId = 'view:agent-launcher'
    const left = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, agentSurface(left, 'al-agent'))
    tab = addWorkbenchRegion(tab, left, 'right', {
      regionId: 'al-launcher',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('al-agent')],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })
    const restoredTab = restored.tabs[viewId]!
    expect(restoredTab).toBeDefined()
    expect(workbenchSurfaces(restoredTab)).toHaveLength(1)
    expect(restoredTab.regions['al-launcher']).toBeUndefined()
    expect(restoredTab.regions[left]!.kind).toBe('agent')
    expect(restoredTab.layout.root.type).toBe('leaf')
  })

  it('G6: a file-only tab whose workspace is not configured disappears entirely', () => {
    const viewId = 'file:gone-workspace:/gone/orphan.md'
    const tab = createWorkbenchTab(viewId, {
      regionId: initialWorkbenchRegionId(viewId),
      kind: 'file',
      workspaceId: 'gone-workspace',
      path: '/gone/orphan.md'
    })
    const restored = restorePersistedWorkbench({
      config,
      sessions: [],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })
    expect(restored.tabs[viewId]).toBeUndefined()
  })

  it('G6b: 一个 Agent 面的 Session 不属于这个 Workspace 时必须剔除——哪怕 Workspace 本身配置得好好的', () => {
    // 归属判断是一个 `&&`：Workspace 仍被配置 **且** 这个 Session 归它所有。
    // G4/G5 只守住了"该留的留下"，G6 只守住了"Workspace 没了"这一半；
    // 「Workspace 在，但 Session 是别人的」这一侧此前无人守——实测把
    // sessionBelongsToWorkspace 强制 `|| true`，apps/desktop/test 全部 192 文件
    // 2025 条测试**全绿**。也就是说一个把外来 Session 认作己有的 bug 会静默通过。
    //
    // 这不是理论风险：投影里存的是 sessionId 字符串，Runtime 快照按 id 查回来的
    // Session 带着自己的 hostId/workspacePath。id 复用、Workspace 改路径、
    // 同一台机上两个 Workspace 指向不同目录，都会让这两者对不上。认错的后果是把
    // 另一个 Workspace 的 Agent 画进当前 Workbench——比丢一个 Region 更糟，
    // 因为用户看到的是一个"属于这里"的 Agent，而它的输出来自别处。
    //
    // 两个子分支各钉一次，对应 workspaceOwnsSessionPath 的两个 return false：
    // 路径不属于（同 host、不同目录）与 host 不属于（同路径、不同 host）。
    for (const foreign of [
      { ...session('g6b-agent'), workspacePath: '/elsewhere' },
      { ...session('g6b-agent'), hostId: 'other-host' }
    ]) {
      const viewId = 'view:foreign-session'
      const regionId = initialWorkbenchRegionId(viewId)
      const tab = createWorkbenchTab(viewId, agentSurface(regionId, 'g6b-agent'))
      const restored = restorePersistedWorkbench({
        config,
        sessions: [foreign],
        persisted: {
          tabs: { [tab.id]: tab },
          layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
        },
        createTabGroupId: () => 'new-group'
      })
      // 这是这个 tab 唯一的面，所以剔除该 Region 等于整 tab 收敛掉——
      // 与 G6 同一条出口（removeWorkbenchRegion → 无面则 tab 消失）。
      expect(restored.tabs[viewId]).toBeUndefined()
    }

    // 反面对照写在同一条测试里：把 Session 换成真正属于这个 Workspace 的，
    // tab 必须活下来。少了这一行，"永远剔除"这个相反的坏实现也能让上面全绿。
    const viewId = 'view:foreign-session'
    const regionId = initialWorkbenchRegionId(viewId)
    const tab = createWorkbenchTab(viewId, agentSurface(regionId, 'g6b-agent'))
    const kept = restorePersistedWorkbench({
      config,
      sessions: [session('g6b-agent')],
      persisted: {
        tabs: { [tab.id]: tab },
        layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
      },
      createTabGroupId: () => 'new-group'
    })
    expect(kept.tabs[viewId]).toBeDefined()
    expect(kept.tabs[viewId]!.regions[regionId]!.kind).toBe('agent')
  })

  it('G7: survives a full JSON round trip — a multi-Region split with a file Region comes back whole', () => {
    // This is the EXACT path that failed for the user: partialize projects the Workbench, zustand writes
    // it to localStorage as JSON, and restore reads it back after restart. Neither project-only (G1) nor
    // restore-only (G4) exercises the JSON boundary between them, so a field that survives an in-memory
    // object graph but is dropped by JSON.stringify/parse (e.g. an undefined key, a class instance) would
    // pass both and still lose the user's split. Assert the whole round trip: the tab survives, both
    // surfaces are back, the file path is verbatim, and the inner split tree (type/children/ratio) is
    // intact — a flatten-to-leaf mutation on restore must redden here.
    const { viewId, tab } = agentPlusFile('/repo/src/round-trip.ts')
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })
    const onDisk = JSON.parse(JSON.stringify(projected)) as typeof projected
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('af-agent')],
      persisted: onDisk,
      createTabGroupId: () => 'new-group'
    })
    const restoredTab = restored.tabs[viewId]!
    expect(restoredTab).toBeDefined()
    expect(workbenchSurfaces(restoredTab)).toHaveLength(2)
    const fileSurface = restoredTab.regions['af-file']!
    expect(fileSurface.kind).toBe('file')
    expect(fileSurface.kind === 'file' && fileSurface.path).toBe('/repo/src/round-trip.ts')
    // The inner layout is the half the user saw vanish. Assert it is a real split, not a collapsed leaf,
    // with both children present and the ratio intact.
    const root = restoredTab.layout.root
    expect(root.type).toBe('split')
    if (root.type !== 'split') throw new Error('expected split root')
    expect(regionIds(root)).toEqual(regionIds(tab.layout.root))
    if (tab.layout.root.type === 'split') expect(root.ratio).toBe(tab.layout.root.ratio)
    expect(restoredTab.layout).toEqual(tab.layout)
  })

  it('G8: a file-only tab whose workspace is still configured survives restart (the 0→1 case)', () => {
    // The原始 bug erased a plain file tab entirely: 1 surface in → 0 persisted → tab gone. G1/G4 always
    // pair the file with an agent, so a mutation that drops SOLO file tabs (e.g. "only persist a file
    // Region when the tab also has a session Region") would slip past them. This is the standalone 0→1:
    // a single file Region, workspace configured, must come back as exactly one surface with its path.
    const path = '/repo/docs/solo.md'
    const viewId = `file:workspace:${path}`
    const tab = createWorkbenchTab(viewId, {
      regionId: initialWorkbenchRegionId(viewId),
      kind: 'file',
      workspaceId: 'workspace',
      path
    })
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })
    // Save side kept the tab (0→1 already proven at the projection boundary). Assert existence BEFORE
    // dereferencing regions so a save-side file-strip mutation reddens as a clean assertion here, not a
    // crash inside workbenchSurfaces(undefined).
    const projectedTab = projected.tabs[viewId]
    expect(projectedTab).toBeDefined()
    expect(workbenchSurfaces(projectedTab!)).toHaveLength(1)
    const onDisk = JSON.parse(JSON.stringify(projected)) as typeof projected
    const restored = restorePersistedWorkbench({
      config,
      sessions: [],
      persisted: onDisk,
      createTabGroupId: () => 'new-group'
    })
    const restoredTab = restored.tabs[viewId]!
    expect(restoredTab).toBeDefined()
    expect(workbenchSurfaces(restoredTab)).toHaveLength(1)
    const surface = restoredTab.regions[initialWorkbenchRegionId(viewId)]!
    expect(surface.kind === 'file' && surface.path).toBe(path)
    expect(restored.layouts.workspace?.groups[0]?.tabOrder).toEqual([viewId])
  })
})

import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout, regionIds } from '@agentmux/layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  projectPersistedWorkbench,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from '../src/renderer/src/lib/workbench-persistence.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
  it.each([false, true])('round-trips bookmark source and binary=%s with the original Browser split and focus', (binary) => {
    const browser = createWorkbenchTab('bookmark-view', {
      regionId: 'bookmark-region', kind: 'browser', workspaceId: 'workspace', browserId: 'original-browser', id: 'original-browser',
      url: 'https://example.invalid/original?a=1&b=2', title: 'Saved link', bookmarkOrigin: { path: 'links/Saved.webloc', binary },
      navigationId: 'transient-navigation', profileId: 'transient-profile', loading: true, canGoBack: true, canGoForward: true,
      viewport: 'responsive', error: 'transient', driving: true, appLinkPrompt: null
    })
    let tab = addWorkbenchRegion(browser, 'bookmark-region', 'right', {
      regionId: 'healthy-neighbor', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'neighbor'
    })
    tab = { ...tab, layout: { ...tab.layout, activeRegionId: 'bookmark-region' } }
    const layout = createWorkspaceLayout('original-group', [tab.id])
    const projected = JSON.parse(JSON.stringify(projectPersistedWorkbench({ tabs: { [tab.id]: tab }, layouts: { workspace: layout } })))
    expect(projected.tabs[tab.id].regions['bookmark-region']).toEqual({
      regionId: 'bookmark-region', kind: 'browser', workspaceId: 'workspace', browserId: 'original-browser',
      url: 'https://example.invalid/original?a=1&b=2', title: 'Saved link', bookmarkOrigin: { path: 'links/Saved.webloc', binary }
    })
    const restored = restorePersistedWorkbench({ config, sessions: [session('neighbor')], persisted: projected, createTabGroupId: () => 'unwanted-new-group' })
    expect(Object.keys(restored.tabs)).toEqual([tab.id])
    expect(restored.tabs[tab.id]!.regions['bookmark-region']).toMatchObject({
      bookmarkOrigin: { path: 'links/Saved.webloc', binary }, navigationId: '', profileId: '', loading: false, error: null, driving: false
    })
    expect(restored.tabs[tab.id]!.regions['healthy-neighbor']).toEqual(tab.regions['healthy-neighbor'])
    expect(restored.tabs[tab.id]!.layout).toEqual(tab.layout)
    expect(restored.layouts.workspace).toEqual(layout)
  })
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

  it('collapses an explicitly retired Session Region without reopening background Sessions as Tabs', () => {
    const tab = splitView()
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('left'), session('right-bottom'), session('new')],
      retiredSessionIds: new Set(['right-top']),
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

  it('persists attached Sessions and Project Launchers with their original split tree', () => {
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

    expect(workbenchSurfaces(projected.tabs[tab.id]!)).toHaveLength(4)
    expect(projected.tabs[tab.id]!.regions.launcher).toEqual(tab.regions.launcher)
    expect(projected.tabs[tab.id]!.layout).toEqual(tab.layout)
  })

  it('round-trips an ordinary Project Launcher and its focused split without changing the draft identity', () => {
    const launcher = createWorkbenchTab('project-launcher', {
      regionId: 'original-draft-region', kind: 'launcher', workspaceId: 'workspace'
    })
    let split = addWorkbenchRegion(launcher, 'original-draft-region', 'right', {
      regionId: 'healthy-neighbor', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'neighbor'
    })
    split = { ...split, layout: { ...split.layout, activeRegionId: 'original-draft-region' } }
    const layout = createWorkspaceLayout('original-group', [split.id])
    const projected = projectPersistedWorkbench({ tabs: { [split.id]: split }, layouts: { workspace: layout } })
    expect(projected.tabs[split.id]).toEqual(split)
    const restored = restorePersistedWorkbench({ config, sessions: [session('neighbor')],
      persisted: JSON.parse(JSON.stringify(projected)), createTabGroupId: () => 'unwanted-new-group' })
    expect(restored.tabs[split.id]).toEqual(split)
    expect(restored.layouts.workspace).toEqual(layout)
    expect(restored.tabs[split.id]!.layout.activeRegionId).toBe('original-draft-region')
    const solo = projectPersistedWorkbench({ tabs: { [launcher.id]: launcher }, layouts: { workspace: createWorkspaceLayout('solo-group', [launcher.id]) } })
    expect(restorePersistedWorkbench({ config, sessions: [], persisted: solo, createTabGroupId: () => 'unwanted-new-group' }).tabs[launcher.id]).toEqual(launcher)
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

  it('G3: persists a browser Region as its re-instantiable subset only (url yes, transient runtime no)', () => {
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
      error: null,
      driving: false,
      appLinkPrompt: null
    })
    const projected = projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })
    const projectedTab = projected.tabs[viewId]!
    // 三侧守卫，缺一条都会放过一种真实回退：
    //  1. browser 面**活下来**且带着 url —— 冷启动要靠它 `api.browser.create` 复活成原页；
    //  2. 瞬时运行时位**不进盘** —— 直接断言 navigationId/profileId 这两个字段名不在产物里，
    //     所以「有人把整个活体 BrowserSnapshot 存回去」会立刻变红，而不是只要 url 在就放行；
    //  3. 同一分屏里的 agent 兄弟结构上存活 —— 只判 browser 那一侧的话，整张 tab 塌掉也照样过，
    //     而那正是「分屏没了」那半个 bug。
    expect(workbenchSurfaces(projectedTab)).toHaveLength(2)
    const persistedBrowser = projectedTab.regions['ab-browser']!
    expect(persistedBrowser.kind).toBe('browser')
    expect(persistedBrowser).toEqual({
      regionId: 'ab-browser',
      kind: 'browser',
      workspaceId: 'workspace',
      browserId: 'ab-browser',
      url: 'https://secret.example.com/x',
      title: 'Secret'
    })
    expect(projectedTab.regions[left]!.kind).toBe('agent')
    const serialized = JSON.stringify(projected)
    expect(serialized).toContain('secret.example.com')
    expect(serialized).not.toContain('nav-secret')
    expect(serialized).not.toContain('navigationId')
    expect(serialized).not.toContain('profileId')
  })

  it('G7b: a browser Region survives the same JSON round trip and comes back hydrated with its url', () => {
    // 端到端那一条：project → JSON.stringify/parse → restore。只测 reduce/hydrate 函数本身证明不了
    // 它们**被调用了**——闸门没放行时两个函数都是死代码，单元测试照样绿（这正是本轮真实发生过的事）。
    // 这条从活体 tab 出发、过一遍真的磁盘形态、再读回活体，任何一环断掉都会红。
    const viewId = 'view:browser-round-trip'
    const left = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, agentSurface(left, 'brt-agent'))
    tab = addWorkbenchRegion(tab, left, 'right', {
      regionId: 'brt-browser',
      kind: 'browser',
      workspaceId: 'workspace',
      browserId: 'brt-browser',
      id: 'brt-browser',
      navigationId: 'nav-transient',
      profileId: 'profile-transient',
      url: 'https://example.com/keep-me',
      title: 'Keep me',
      loading: true,
      canGoBack: true,
      canGoForward: false,
      viewport: 'desktop',
      error: null,
      driving: true,
      appLinkPrompt: null
    })
    const onDisk = JSON.parse(JSON.stringify(projectPersistedWorkbench({
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    }))) as PersistedWorkbench
    const restored = restorePersistedWorkbench({
      config,
      sessions: [session('brt-agent')],
      persisted: onDisk,
      createTabGroupId: () => 'new-group'
    })
    const restoredTab = restored.tabs[viewId]!
    expect(restoredTab).toBeDefined()
    expect(workbenchSurfaces(restoredTab)).toHaveLength(2)
    const browser = restoredTab.regions['brt-browser']!
    expect(browser.kind).toBe('browser')
    if (browser.kind !== 'browser') throw new Error('expected a browser surface')
    // 可再实例化的那一档回来了 —— 冷启动的 `api.browser.create(browserId, url)` 就吃这两个字段。
    expect(browser.browserId).toBe('brt-browser')
    expect(browser.url).toBe('https://example.com/keep-me')
    expect(browser.title).toBe('Keep me')
    // 瞬时位回到中性默认，等 create 之后的真快照覆盖；绝不能把上一次运行的 driving/loading 带回来，
    // 那会让 UI 一启动就显示「Agent 正在操作」而底下根本没有 WebContentsView。
    expect(browser.navigationId).toBe('')
    expect(browser.driving).toBe(false)
    expect(browser.loading).toBe(false)
    // 分屏结构原样 —— browser 活下来但 tab 塌成单叶，等于只修好了一半。
    expect(restoredTab.layout).toEqual(tab.layout)
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
    // A not-yet-attached Terminal has no confirmed Run to restore; only that Region is removed.
    const viewId = 'view:agent-pending-terminal'
    const left = initialWorkbenchRegionId(viewId)
    let tab = createWorkbenchTab(viewId, agentSurface(left, 'al-agent'))
    tab = addWorkbenchRegion(tab, left, 'right', {
      regionId: 'al-pending-terminal',
      kind: 'terminal',
      phase: 'launching',
      sessionId: 'not-attached',
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
    expect(restoredTab.regions['al-pending-terminal']).toBeUndefined()
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

  it('G6b: durable Region placement survives a changed execution directory or Host', () => {
    // Space placement and execution location are distinct public facts. A display move never
    // changes the original Session cwd or Host, and restore cannot delete that lawful projection.
    for (const foreign of [
      { ...session('g6b-agent'), workspacePath: '/elsewhere' },
      { ...session('g6b-agent'), hostId: 'other-host' }
    ]) {
      const viewId = 'view:foreign-session'
      const regionId = initialWorkbenchRegionId(viewId)
      const tab = createWorkbenchTab(viewId, agentSurface(regionId, 'g6b-agent'))
      const persisted = { tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) } }
      const restored = restorePersistedWorkbench({ config, sessions: [foreign], persisted, createTabGroupId: () => 'new-group' })
      expect(restored.tabs[viewId]).toEqual(tab)
      expect(restored.layouts.workspace?.groups[0]?.tabOrder).toEqual([viewId])
      const retired = restorePersistedWorkbench({ config, sessions: [foreign], persisted,
        retiredSessionIds: new Set(['g6b-agent']), createTabGroupId: () => 'new-group' })
      expect(retired.tabs).toEqual({})
    }
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

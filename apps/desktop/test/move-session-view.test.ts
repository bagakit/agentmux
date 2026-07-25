import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  addTab,
  createWorkspaceLayout,
  findGroupForTab,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  findWorkbenchRegion,
  workbenchSurfaces,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  moveSessionViewToWorkspace,
  type MoveSessionViewInput
} from '../src/renderer/src/lib/move-session-view.js'
import { sessionTabTooltip } from '../src/renderer/src/lib/session-metadata.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'

// A projection is a Region carrying a Session inside a View. `agentTab` builds a one-Region View that
// projects `sessionId` while displaying `workspaceId` — never a cwd, which lives only in Core.
function agentTab(tabId: string, regionId: string, workspaceId: string, sessionId: string): WorkbenchTab {
  return createWorkbenchTab(tabId, {
    regionId,
    kind: 'agent',
    phase: 'attached',
    workspaceId,
    sessionId
  })
}

function baseInput(overrides: Partial<MoveSessionViewInput> = {}): MoveSessionViewInput {
  const tab = agentTab('view-a', 'region-a', 'workspace-a', 'agent-1')
  return {
    tabs: { [tab.id]: tab },
    layouts: { 'workspace-a': createWorkspaceLayout('group-a', [tab.id]) },
    regionId: 'region-a',
    sessionId: 'agent-1',
    targetWorkspaceId: 'workspace-b',
    workspaceIds: ['workspace-a', 'workspace-b'],
    mint: { tabId: 'view-new', tabGroupId: 'group-new', regionId: 'region-new' },
    ...overrides
  }
}

describe('moveSessionViewToWorkspace', () => {
  it('creates a View in the target workspace when none can host the projection', () => {
    const result = moveSessionViewToWorkspace(baseInput())
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return

    // The need for a new View is expressed, not silently dropped.
    expect(result.createdView).toBe(true)
    expect(result.target.workspaceId).toBe('workspace-b')

    // The landed projection carries the same Session and shows the target workspace as display identity.
    const landed = findWorkbenchRegion(result.tabs, result.target.regionId)
    expect(landed?.surface).toMatchObject({ sessionId: 'agent-1', workspaceId: 'workspace-b' })

    // A View in the target workspace's layout now hosts the moved tab.
    const targetLayout = result.layouts['workspace-b']
    expect(findGroupForTab(targetLayout, result.target.tabId)?.tabOrder).toContain(result.target.tabId)
  })

  it('never emits a cwd — no field in the output carries a workspacePath', () => {
    const result = moveSessionViewToWorkspace(baseInput())
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('workspacePath')
    // Surfaces carry display identity (workspaceId) and Session identity only.
    for (const tab of Object.values(result.tabs)) {
      for (const surface of workbenchSurfaces(tab)) {
        expect(surface).not.toHaveProperty('workspacePath')
      }
    }
  })

  it('disposes the source View when its last Region leaves', () => {
    const result = moveSessionViewToWorkspace(baseInput())
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return

    // The emptied source View is gone from both tabs and the source layout.
    expect(result.tabs['view-a']).toBeUndefined()
    const sourceLayout = result.layouts['workspace-a']
    expect(findGroupForTab(sourceLayout, 'view-a')).toBeNull()
  })

  it('keeps the source View alive when it still hosts other Regions', () => {
    const shared = addWorkbenchRegion(
      agentTab('view-a', 'region-a', 'workspace-a', 'agent-1'),
      'region-a',
      'right',
      { regionId: 'region-a2', kind: 'terminal', phase: 'attached', workspaceId: 'workspace-a', sessionId: 'term-9' }
    )
    const result = moveSessionViewToWorkspace(baseInput({
      tabs: { [shared.id]: shared },
      layouts: { 'workspace-a': createWorkspaceLayout('group-a', [shared.id]) }
    }))
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return

    // Source View survives, retaining the other Region; only agent-1's projection left it.
    const survivor = result.tabs['view-a']
    expect(survivor).toBeDefined()
    expect(workbenchSurfaces(survivor!).map((s) => s.regionId)).toEqual(['region-a2'])
  })

  it('moves only the pointed-at projection when a Session projects into multiple Views', () => {
    const first = agentTab('view-1', 'region-1', 'workspace-a', 'agent-1')
    const second = agentTab('view-2', 'region-2', 'workspace-a', 'agent-1')
    const layout = addTab(createWorkspaceLayout('group-a', ['view-1']), 'group-a', 'view-2')
    const result = moveSessionViewToWorkspace(baseInput({
      tabs: { 'view-1': first, 'view-2': second },
      layouts: { 'workspace-a': layout },
      regionId: 'region-2'
    }))
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return

    // The untouched projection stays exactly where it was, in its original workspace.
    const untouched = findWorkbenchRegion(result.tabs, 'region-1')
    expect(untouched?.tab.id).toBe('view-1')
    expect(untouched?.surface).toMatchObject({ workspaceId: 'workspace-a' })
    // The pointed-at projection moved.
    expect(findWorkbenchRegion(result.tabs, 'region-2')).toBeNull()
    expect(result.target.workspaceId).toBe('workspace-b')
  })

  it('reuses an existing target View that already projects the Session instead of minting a duplicate', () => {
    const source = agentTab('view-a', 'region-a', 'workspace-a', 'agent-1')
    const targetExisting = agentTab('view-b', 'region-b', 'workspace-b', 'agent-1')
    const result = moveSessionViewToWorkspace(baseInput({
      tabs: { 'view-a': source, 'view-b': targetExisting },
      layouts: {
        'workspace-a': createWorkspaceLayout('group-a', ['view-a']),
        'workspace-b': createWorkspaceLayout('group-b', ['view-b'])
      }
    }))
    expect(result.kind).toBe('moved')
    if (result.kind !== 'moved') return

    expect(result.createdView).toBe(false)
    expect(result.target.tabId).toBe('view-b')
    expect(result.tabs['view-new']).toBeUndefined()
  })

  it('returns unchanged when target equals the source workspace', () => {
    expect(moveSessionViewToWorkspace(baseInput({ targetWorkspaceId: 'workspace-a' })).kind).toBe('unchanged')
  })

  it('returns unchanged when the region is not found', () => {
    expect(moveSessionViewToWorkspace(baseInput({ regionId: 'ghost' })).kind).toBe('unchanged')
  })

  it('returns unchanged when the sessionId does not match the projection', () => {
    expect(moveSessionViewToWorkspace(baseInput({ sessionId: 'someone-else' })).kind).toBe('unchanged')
  })

  it('returns unchanged when the target workspace does not exist', () => {
    expect(moveSessionViewToWorkspace(baseInput({ targetWorkspaceId: 'ghost-workspace' })).kind).toBe('unchanged')
  })

  it('does not mutate the input tabs or layouts', () => {
    const input = baseInput()
    const tabsBefore: Record<string, WorkbenchTab> = { ...input.tabs }
    const layoutsBefore: Record<string, WorkspaceLayout> = { ...input.layouts }
    moveSessionViewToWorkspace(input)
    expect(input.tabs).toEqual(tabsBefore)
    expect(input.layouts).toEqual(layoutsBefore)
  })
})

// The reducer above enforces the projection-move behaviour in code; this guards the *contract* that the
// interaction SSOT must state, so the next reader can tell "move the projection" apart from "change the
// Agent's cwd". Without that statement in the doc the exact misimplementation this feature exists to
// prevent has no written line to point at. Precedent: surface-radius-contract.test.ts guards a design
// clause the same way. If the contract paragraph is deleted or gutted, every token below disappears and
// this goes red.
describe('projection-move contract in the interaction SSOT', () => {
  const doc = readFileSync(
    new URL('../../../docs/design/agentmux-desktop-interaction.md', import.meta.url),
    'utf8'
  )

  // Scope every assertion to the "Session、Run 与 View" section so the contract lives next to the
  // existing "投影到多个 View" line, not dumped in an unrelated part of the doc.
  function sessionRunViewSection(): string {
    const start = doc.indexOf('### Session、Run 与 View')
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = doc.slice(start + 1)
    const nextHeading = rest.search(/\n#{2,3} /)
    return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest
  }

  it('keeps the projection-move contract in the same section as the multi-View line', () => {
    const section = sessionRunViewSection()
    // The anchor the contract must sit beside.
    expect(section).toContain('投影到多个 View')

    // 1. A projection can be explicitly relocated to another workspace's View.
    expect(section).toContain('显式移动')
    expect(section).toContain('另一个 Workspace')

    // 2. Core's session.workspacePath (the Agent's cwd) is untouched by the move.
    expect(section).toContain('session.workspacePath')
    expect(section).toMatch(/session\.workspacePath[^。]*(?:绝不改变|不改变|不变)/)

    // 3. After the move the Tab still truthfully shows the Session's own working directory.
    expect(section).toMatch(/仍[^。]*(?:工作目录|cwd)/)

    // 4. Creating a worktree triggers no automatic move.
    expect(section).toContain('worktree')
    expect(section).toMatch(/(?:绝不|不)[^。]*自动移动/)
  })
})

const storeInitialState = useAppStore.getState()

const twoWorkspaceConfig: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'workspace-a', name: 'Main', hostId: 'local', path: '/repo', kind: 'folder' },
    { id: 'workspace-b', name: 'Feature Worktree', hostId: 'local', path: '/repo/.wt/feature', kind: 'worktree', repoPath: '/repo', branch: 'feature' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

// The Agent's real cwd is /repo — it was launched from Main and never moved, even though its View is
// about to be relocated to display under workspace-b.
function agentSessionAt(id: string, workspacePath: string): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: false,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: false,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath,
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id } }
  }
}

describe('useAppStore.moveSessionViewToWorkspace', () => {
  afterEach(() => {
    useAppStore.setState(storeInitialState, true)
  })

  function seedSingleView() {
    const tab = agentTab('view-a', 'region-a', 'workspace-a', 'agent-1')
    useAppStore.setState({
      config: twoWorkspaceConfig,
      activeWorkspaceId: 'workspace-a',
      sessions: [agentSessionAt('agent-1', '/repo')],
      tabs: { [tab.id]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('group-a', [tab.id]) },
      error: null
    })
  }

  it('relocates the projection through the reducer and navigates to the target with existing focus', () => {
    seedSingleView()
    useAppStore.getState().moveSessionViewToWorkspace('region-a', 'workspace-b')

    const state = useAppStore.getState()
    // The move landed: a View in workspace-b now projects agent-1, the source View is gone.
    expect(state.tabs['view-a']).toBeUndefined()
    const landed = Object.values(state.tabs).find((tab) =>
      workbenchSurfaces(tab).some((surface) => 'sessionId' in surface && surface.sessionId === 'agent-1')
    )
    expect(landed?.workspaceId).toBe('workspace-b')
    const landedLayout = state.layouts['workspace-b']
    expect(findGroupForTab(landedLayout!, landed!.id)?.tabOrder).toContain(landed!.id)

    // Navigation reused the existing focus path: the target workspace is active and shown in the workbench.
    expect(state.activeWorkspaceId).toBe('workspace-b')
    expect(state.mainSurface).toBe('workbench')
    // The target tab is the active tab of its group (focus landed there).
    expect(findGroupForTab(landedLayout!, landed!.id)?.activeTabId).toBe(landed!.id)
  })

  it('keeps the moved Session showing its own workspacePath, not the target workspace name', () => {
    seedSingleView()
    useAppStore.getState().moveSessionViewToWorkspace('region-a', 'workspace-b')

    const session = useAppStore.getState().sessions.find((candidate) => candidate.id === 'agent-1')!
    // Core's cwd is untouched by a projection move — the Session still reports /repo.
    expect(session.workspacePath).toBe('/repo')
    const tooltip = sessionTabTooltip(session)
    expect(tooltip).toContain('Working directory: /repo')
    // It never adopts the target workspace's on-disk path as the working directory.
    expect(tooltip).not.toContain('Working directory: /repo/.wt/feature')
  })

  it('surfaces a move of a closing View through reportError and leaves the layout untouched', () => {
    seedSingleView()
    const before = useAppStore.getState()
    useAppStore.setState({
      closingWorkbenchViews: {
        'view-a': {
          workspaceId: 'workspace-a',
          tabGroupId: 'group-a',
          tabId: 'view-a',
          closesView: true,
          surfaces: [],
          resources: [],
          reservedSessionIds: ['agent-1']
        }
      }
    })

    useAppStore.getState().moveSessionViewToWorkspace('region-a', 'workspace-b')

    const state = useAppStore.getState()
    expect(state.error).toBeTruthy()
    // No half-moved state: the source View and its layout are exactly as before.
    expect(state.tabs['view-a']).toEqual(before.tabs['view-a'])
    expect(state.layouts).toEqual(before.layouts)
    expect(state.tabs['view-new']).toBeUndefined()
  })

  it('does nothing when the region is unknown', () => {
    seedSingleView()
    const before = useAppStore.getState()
    useAppStore.getState().moveSessionViewToWorkspace('ghost-region', 'workspace-b')
    const state = useAppStore.getState()
    expect(state.tabs).toEqual(before.tabs)
    expect(state.layouts).toEqual(before.layouts)
    expect(state.error).toBeNull()
  })

  // The explicit entry point. Without a call site the reducer, the menu model and the store action are
  // all unreachable — the user has no way to ask for the move, which is the whole Feature. This asserts
  // the component actually consumes both, so deleting the wiring goes red rather than quietly shipping
  // a feature nobody can trigger.
  it('offers the move through the Tab context menu, wired to the store action', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
      'utf8'
    )
    const menu = readFileSync(
      new URL('../src/renderer/src/components/WorkbenchTabContextMenu.tsx', import.meta.url),
      'utf8'
    )

    // The destinations come from the pure model, never re-derived in the component.
    expect(source).toContain('moveSessionViewTargets(')
    // Selecting a destination calls the store action with the projection's own Region.
    expect(source).toContain('moveSessionViewToWorkspace(')
    // The menu renders the destinations it is given rather than inventing its own list.
    expect(menu).toContain('moveSessionViewTargets')
  })
})

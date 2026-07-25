import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout, type WorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  replaceWorkbenchRegion,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  applyWorkbenchViewCloseTopology,
  planWorkbenchViewClose,
  reconcileWorkbenchViewClose
} from '../src/renderer/src/lib/workbench-view-close.js'

function terminalSession(id: string): SessionSnapshot {
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
    control: {
      kind: 'terminal',
      hostId: 'local',
      runId: id,
      run: { runId: id }
    }
  }
}

function agentSession(id: string, runId = id): SessionSnapshot {
  return {
    ...terminalSession(id),
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    label: 'Codex',
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId }
    }
  }
}

function terminalTab(tabId: string, regionId: string, sessionId: string) {
  return createWorkbenchTab(tabId, {
    regionId,
    kind: 'terminal',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId
  })
}

function browserSurface(regionId: string, browserId: string) {
  return {
    id: browserId,
    regionId,
    kind: 'browser' as const,
    workspaceId: 'workspace',
    browserId,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null
  }
}

function planFor(tab: ReturnType<typeof terminalTab>, sessions: SessionSnapshot[]) {
  return planWorkbenchViewClose({
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) },
    sessions,
    workspaceId: 'workspace',
    tabGroupId: 'pane',
    tabId: tab.id,
    keepAgentSessions: false
  })!
}

describe('Workbench View close ownership', () => {
  it('freezes the exact Surface owners and resource controls captured by the plan', () => {
    const session = terminalSession('run-1')
    const terminal = terminalTab('view', 'terminal-region', session.id)
    const tab = addWorkbenchRegion(
      terminal,
      'terminal-region',
      'right',
      browserSurface('browser-region', 'browser-1')
    )

    const plan = planFor(tab, [session])

    expect(plan.resources.map((resource) => resource.key)).toEqual([
      'session:run-1',
      'browser:browser-1'
    ])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.surfaces)).toBe(true)
    expect(plan.surfaces.every((surface) => Object.isFrozen(surface.owner))).toBe(true)
    const sessionResource = plan.resources.find((resource) => resource.kind === 'session')
    expect(Object.isFrozen(sessionResource)).toBe(true)
    expect(Object.isFrozen(sessionResource?.kind === 'session' ? sessionResource.control : null)).toBe(true)
    expect(Object.isFrozen(sessionResource?.kind === 'session' ? sessionResource.control.run : null)).toBe(true)
  })

  it('fails closed and keeps a Surface when its resource receipt is missing', () => {
    const session = terminalSession('run-1')
    const tab = terminalTab('view', 'terminal-region', session.id)
    const plan = planFor(tab, [session])

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab: tab,
      currentSessions: [session],
      receipts: []
    })

    expect(result.tab).toBe(tab)
    expect(result.failures).toEqual([
      expect.objectContaining({ key: 'session:run-1', status: 'rejected' })
    ])
  })

  it('does not report a rejected receipt after the exact owner already disappeared', () => {
    const session = terminalSession('run-1')
    const tab = terminalTab('view', 'terminal-region', session.id)
    const plan = planFor(tab, [session])

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab: undefined,
      currentSessions: [],
      receipts: [{ key: 'session:run-1', status: 'rejected', reason: new Error('already gone') }]
    })

    expect(result.tab).toBeNull()
    expect(result.failures).toEqual([])
    expect(result.changedWhileClosing).toBe(false)
  })

  it('removes a fulfilled Session Surface while retaining a rejected Browser Surface', () => {
    const session = terminalSession('run-1')
    const tab = addWorkbenchRegion(
      terminalTab('view', 'terminal-region', session.id),
      'terminal-region',
      'right',
      browserSurface('browser-region', 'browser-1')
    )
    const plan = planFor(tab, [session])
    const browserFailure = new Error('browser close failed')

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab: tab,
      currentSessions: [session],
      receipts: [
        { key: 'session:run-1', status: 'fulfilled' },
        { key: 'browser:browser-1', status: 'rejected', reason: browserFailure }
      ]
    })

    expect(result.tab && workbenchSurfaces(result.tab)).toEqual([
      expect.objectContaining({ kind: 'browser', browserId: 'browser-1' })
    ])
    expect(result.failures).toEqual([
      { key: 'browser:browser-1', status: 'rejected', reason: browserFailure }
    ])
    expect(result.changedWhileClosing).toBe(false)
  })

  it('keeps a new Region while removing the fulfilled owner captured by the plan', () => {
    const session = terminalSession('run-1')
    const tab = terminalTab('view', 'terminal-region', session.id)
    const plan = planFor(tab, [session])
    const currentTab = addWorkbenchRegion(tab, 'terminal-region', 'right', {
      regionId: 'new-region',
      kind: 'launcher',
      workspaceId: 'workspace'
    })

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab,
      currentSessions: [session],
      receipts: [{ key: 'session:run-1', status: 'fulfilled' }]
    })

    expect(result.tab && workbenchSurfaces(result.tab)).toEqual([
      expect.objectContaining({ kind: 'launcher', regionId: 'new-region' })
    ])
    expect(result.changedWhileClosing).toBe(true)
  })

  it('keeps a same-id Region whose owner changes from launching to attached', () => {
    const tab = createWorkbenchTab('view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'launching',
      workspaceId: 'workspace',
      sessionId: 'agent-1'
    })
    const plan = planFor(tab, [])
    const currentTab = replaceWorkbenchRegion(tab, 'agent-region', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: 'agent-1'
    })

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab,
      currentSessions: [],
      receipts: []
    })

    expect(result.tab?.regions['agent-region']).toMatchObject({ phase: 'attached' })
    expect(result.changedWhileClosing).toBe(true)
  })

  it('keeps a same-Session Surface when its exact Run changes while closing', () => {
    const previous = agentSession('agent-1', 'old-run')
    const recovered = agentSession('agent-1', 'new-run')
    const tab = createWorkbenchTab('view', {
      regionId: 'agent-region',
      kind: 'agent',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: previous.id
    })
    const plan = planFor(tab, [previous])

    const result = reconcileWorkbenchViewClose({
      plan,
      currentTab: tab,
      currentSessions: [recovered],
      receipts: [{ key: 'session:agent-1', status: 'fulfilled' }]
    })

    expect(result.tab).toBe(tab)
    expect(result.changedWhileClosing).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('assigns shared Session Stop ownership to the final concurrent close plan', () => {
    const session = terminalSession('shared-run')
    const first = terminalTab('first-view', 'first-region', session.id)
    const second = terminalTab('second-view', 'second-region', session.id)
    const tabs = { [first.id]: first, [second.id]: second }
    const layouts = { workspace: createWorkspaceLayout('pane', [first.id, second.id]) }

    const firstPlan = planWorkbenchViewClose({
      tabs,
      layouts,
      sessions: [session],
      workspaceId: 'workspace',
      tabGroupId: 'pane',
      tabId: first.id,
      keepAgentSessions: false
    })!
    const finalPlan = planWorkbenchViewClose({
      tabs,
      layouts,
      sessions: [session],
      workspaceId: 'workspace',
      tabGroupId: 'pane',
      tabId: second.id,
      keepAgentSessions: false,
      closingViewIds: new Set([first.id])
    })!

    expect(firstPlan.resources).toEqual([])
    expect(finalPlan.resources).toEqual([
      expect.objectContaining({ key: 'session:shared-run', kind: 'session' })
    ])
  })

  it('removes only a non-final Layout occurrence without planning resource cleanup', () => {
    const session = terminalSession('run-1')
    const tab = terminalTab('view', 'terminal-region', session.id)
    const layout: WorkspaceLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      },
      groups: [
        { id: 'left', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] },
        { id: 'right', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }
      ],
      activeGroupId: 'left'
    }
    const state = { tabs: { [tab.id]: tab }, layouts: { workspace: layout } }
    const plan = planWorkbenchViewClose({
      ...state,
      sessions: [session],
      workspaceId: 'workspace',
      tabGroupId: 'left',
      tabId: tab.id,
      keepAgentSessions: false
    })!

    const next = applyWorkbenchViewCloseTopology(state, plan, null)

    expect(plan.closesView).toBe(false)
    expect(plan.resources).toEqual([])
    expect(next.tabs).toBe(state.tabs)
    expect(next.layouts.workspace.groups).toEqual([
      { id: 'right', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }
    ])
  })
})

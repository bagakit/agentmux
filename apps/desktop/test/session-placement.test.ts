import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab, type WorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { resolveSessionPlacement } from '../src/renderer/src/lib/session-placement'

function session(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    hostId: 'host-a',
    workspacePath: `/workspaces/${id}`,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    providerId: null,
    control: {
      kind: 'terminal',
      hostId: 'host-a',
      sessionId: id,
      run: { runId: `run-${id}` }
    }
  } as unknown as SessionSnapshot
}

function surface(sessionId: string, workspaceId: string, regionId: string): WorkbenchSurface {
  return {
    kind: 'terminal',
    phase: 'attached',
    sessionId,
    workspaceId,
    regionId
  }
}

describe('resolveSessionPlacement', () => {
  it('uses the explicit target Session owner when ambient focus points at another Agent', () => {
    const target = createWorkbenchTab('target-tab', surface('forked', 'target-workspace', 'target-region'))
    const focused = createWorkbenchTab('focused-tab', surface('focused', 'focused-workspace', 'focused-region'))
    const result = resolveSessionPlacement({
      sessionId: 'forked',
      sessions: [session('forked'), session('focused')],
      tabs: { [target.id]: target, [focused.id]: focused },
      layouts: {
        'target-workspace': createWorkspaceLayout('target-group', [target.id]),
        'focused-workspace': createWorkspaceLayout('focused-group', [focused.id])
      },
      origin: {
        workspaceId: 'target-workspace',
        tabGroupId: 'target-group',
        tabId: target.id,
        regionId: 'target-region'
      }
    })

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'forked',
      workspaceId: 'target-workspace',
      tabId: 'target-tab',
      regionId: 'target-region',
      tabGroupId: 'target-group'
    })
  })

  it('does not fall back to another surface when the explicit target is stale', () => {
    const live = createWorkbenchTab('live-tab', surface('resumed', 'workspace', 'live-region'))
    const result = resolveSessionPlacement({
      sessionId: 'resumed',
      sessions: [session('resumed')],
      tabs: { [live.id]: live },
      layouts: { workspace: createWorkspaceLayout('group', [live.id]) },
      origin: {
        workspaceId: 'workspace',
        tabGroupId: 'group',
        tabId: 'closed-tab',
        regionId: 'closed-region'
      }
    })

    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.reason).toBe('origin-mismatch')
      expect(result.message).toContain('choose the Session again')
    }
  })

  it('resolves an existing same-Session surface when it is the only owner', () => {
    const tab = createWorkbenchTab('same-session-tab', surface('same-session', 'workspace', 'region'))
    const result = resolveSessionPlacement({
      sessionId: 'same-session',
      sessions: [session('same-session')],
      tabs: { [tab.id]: tab },
      layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }
    })

    expect(result).toMatchObject({
      kind: 'resolved',
      sessionId: 'same-session',
      tabId: 'same-session-tab',
      regionId: 'region',
      tabGroupId: 'group'
    })
  })

  it('reports an unresolved target instead of inventing a placement', () => {
    const result = resolveSessionPlacement({
      sessionId: 'missing',
      sessions: [],
      tabs: {},
      layouts: {}
    })

    expect(result).toEqual({
      kind: 'unresolved',
      sessionId: 'missing',
      reason: 'session-not-found',
      message: 'The target Session is no longer available.'
    })
  })

  it('resolves the requested foreign second occurrence without borrowing the resource Workspace or first Group', () => {
    const tab = createWorkbenchTab('resource-tab', surface('healthy', 'resource', 'original-region'))
    const first = createWorkspaceLayout('first', [tab.id])
    const displayed = { ...first, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5,
      first: first.root, second: { type: 'leaf' as const, groupId: 'second' } },
      groups: [...first.groups, { ...first.groups[0]!, id: 'second' }] }
    const input = { sessionId: 'healthy', sessions: [session('healthy')], tabs: { [tab.id]: tab },
      layouts: { resource: createWorkspaceLayout('home', [tab.id]), foreign: displayed } }
    expect(resolveSessionPlacement({ ...input, origin: { workspaceId: 'foreign', tabGroupId: 'second', tabId: tab.id, regionId: 'original-region' } })).toEqual({
      kind: 'resolved', sessionId: 'healthy', workspaceId: 'foreign', tabGroupId: 'second', tabId: tab.id, regionId: 'original-region' })
    expect(resolveSessionPlacement(input)).toMatchObject({ kind: 'unresolved', reason: 'surface-ambiguous' })
  })

  it('rejects a Group entry that is absent from the original layout tree', () => {
    const tab = createWorkbenchTab('resource-tab', surface('healthy', 'resource', 'original-region'))
    const layout = createWorkspaceLayout('live', [tab.id])
    const result = resolveSessionPlacement({ sessionId: 'healthy', sessions: [session('healthy')], tabs: { [tab.id]: tab },
      layouts: { foreign: { ...layout, groups: [...layout.groups, { ...layout.groups[0]!, id: 'orphan' }] } },
      origin: { workspaceId: 'foreign', tabGroupId: 'orphan', tabId: tab.id, regionId: 'original-region' } })
    expect(result).toMatchObject({ kind: 'unresolved', reason: 'origin-mismatch' })
  })

  it('rejects a retained Session Region entry that is absent from its original region tree', () => {
    const tab = createWorkbenchTab('resource-tab', surface('healthy', 'resource', 'original-region'))
    const retained = { ...tab, regions: { ...tab.regions, orphan: surface('healthy', 'resource', 'orphan') } }
    const result = resolveSessionPlacement({ sessionId: 'healthy', sessions: [session('healthy')], tabs: { [tab.id]: retained },
      layouts: { foreign: createWorkspaceLayout('group', [tab.id]) },
      origin: { workspaceId: 'foreign', tabGroupId: 'group', tabId: tab.id, regionId: 'orphan' } })
    expect(result).toMatchObject({ kind: 'unresolved', reason: 'origin-mismatch' })
  })
})

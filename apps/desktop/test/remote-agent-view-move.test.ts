import { expect, it } from 'vitest'
import { createWorkspaceLayout, findGroupForTab } from '@agentmux/layout'
import { createWorkbenchTab, findWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { moveSessionViewToWorkspace, type MoveSessionViewInput } from '../src/renderer/src/lib/move-session-view'

function input(kind: 'agent' | 'terminal' = 'agent'): MoveSessionViewInput {
  const source = { ...createWorkbenchTab('source-view', {
    kind, phase: 'attached', regionId: 'source-region', workspaceId: 'remote-resource', sessionId: 'remote-session'
  }), workspaceId: 'local-display-a' }
  return {
    tabs: { [source.id]: source },
    layouts: { 'local-display-a': createWorkspaceLayout('source-group', [source.id]) },
    regionId: 'source-region', sessionId: 'remote-session', targetWorkspaceId: 'local-display-b',
    workspaceIds: ['remote-resource', 'local-display-a', 'local-display-b'],
    mint: { tabId: 'target-view', tabGroupId: 'target-group', regionId: 'target-region' }
  }
}

it('GUI view move retains the remote Agent resource while changing the local display Workspace', () => {
  const before = input()
  const result = moveSessionViewToWorkspace(before)
  expect(result.kind).toBe('moved')
  if (result.kind !== 'moved') throw new Error('The Agent projection did not move')
  expect(result.target).toEqual({ workspaceId: 'local-display-b', tabId: 'target-view', regionId: 'target-region' })
  const landed = findWorkbenchRegion(result.tabs, result.target.regionId)!
  expect(landed.tab.workspaceId).toBe('local-display-b')
  expect(landed.surface).toMatchObject({ kind: 'agent', workspaceId: 'remote-resource', sessionId: 'remote-session' })
  expect(findGroupForTab(result.layouts['local-display-b']!, 'target-view')?.tabOrder).toContain('target-view')
  expect(result.tabs['source-view']).toBeUndefined()
  expect(before.tabs['source-view']!.regions['source-region']!.workspaceId).toBe('remote-resource')
})

it('view move keeps the established Terminal surface Workspace behavior', () => {
  const result = moveSessionViewToWorkspace(input('terminal'))
  expect(result.kind).toBe('moved')
  if (result.kind !== 'moved') throw new Error('The Terminal projection did not move')
  const landed = findWorkbenchRegion(result.tabs, result.target.regionId)!
  expect(landed.tab.workspaceId).toBe('local-display-b')
  expect(landed.surface).toMatchObject({ kind: 'terminal', workspaceId: 'local-display-b', sessionId: 'remote-session' })
})

it('reuses an existing target Agent view without changing its execution resource', () => {
  const before = input()
  const target = { ...createWorkbenchTab('existing-view', {
    kind: 'agent', phase: 'attached', regionId: 'existing-region', workspaceId: 'remote-resource', sessionId: 'remote-session'
  }), workspaceId: 'local-display-b' }
  before.tabs = { ...before.tabs, [target.id]: target }
  before.layouts = { ...before.layouts, 'local-display-b': createWorkspaceLayout('existing-group', [target.id]) }
  const result = moveSessionViewToWorkspace(before)
  expect(result.kind).toBe('moved')
  if (result.kind !== 'moved') throw new Error('The Agent projection did not move')
  expect(result.createdView).toBe(false)
  expect(result.target).toEqual({ workspaceId: 'local-display-b', tabId: 'existing-view', regionId: 'existing-region' })
  expect(result.tabs['existing-view']).toBe(target)
  expect(result.tabs['target-view']).toBeUndefined()
})

// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectWorkbenchProjection, selectWorkbenchProjectionTab, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { composerConfig } from './helpers/composer-dom-fixture'

function fixture() {
  const workspaceId = composerConfig.workspaces[0]!.id
  const tab = createWorkbenchTab('original', { kind: 'launcher', workspaceId, regionId: 'original-region' })
  const first = createWorkspaceLayout('first', [tab.id]), second = createWorkspaceLayout('second', [tab.id])
  const layout = { ...first, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.5, first: first.root, second: second.root }, groups: [...first.groups, ...second.groups] }
  const tabs = { [tab.id]: tab }
  const catalog = spatialCatalog({ config: composerConfig, sessions: [], tabs, layouts: { [workspaceId]: layout }, spaceZoneBindings: {} }, [])
  const reference = { displayWorkspaceId: workspaceId, groupId: 'second', tabId: tab.id, regionId: 'original-region' }
  const onSelect = vi.fn()
  const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId: catalog.tabs[0]!.zoneId! }, presentationId: 'explicit-reader', displayWorkspaceId: workspaceId, catalog, selectionMode: 'occurrence', selection: [reference], onSelect }
  return { tab, tabs, layout, catalog, reference, onSelect, scope }
}

describe('original Zone workbench explicit occurrence selection', () => {
  it('keeps both legal bindings and members while selecting only the confirmed Group', () => {
    const f = fixture(), before = JSON.stringify(f.layout)
    const result = projectWorkbenchProjection(f.layout, f.tabs, f.scope)
    expect(result.layout?.groups.map(group => [group.id, group.tabOrder, group.activeTabId])).toEqual([
      ['first', [f.tab.id], null], ['second', [f.tab.id], f.tab.id]
    ])
    expect(result.selection).toEqual([f.reference])
    expect(result.layout?.activeGroupId).toBe('second')
    expect(projectWorkbenchProjection(f.layout, f.tabs, f.scope, 'first').layout?.activeGroupId).toBe('second')
    expect(result.unsupportedTabIds.size).toBe(0)
    expect(f.catalog.locations).toHaveLength(2)
    expect(JSON.stringify(f.layout)).toBe(before)
    expect(f.tabs[f.tab.id]).toBe(f.tab)
  })

  it.each(['wrong-region', 'wrong-display', 'duplicate'] as const)('does not borrow a %s reference to choose another Group', wrong => {
    const f = fixture()
    const selection = wrong === 'duplicate' ? [f.reference, f.reference] : [{ ...f.reference,
      ...(wrong === 'wrong-region' ? { regionId: 'missing' } : { displayWorkspaceId: 'other' }) }]
    const result = projectWorkbenchProjection(f.layout, f.tabs, { ...f.scope, selection })
    expect(result.selection).toEqual([])
    expect(result.layout?.groups.map(group => group.activeTabId)).toEqual([null, null])
    expect(result.layout?.activeGroupId).toBe('')
    expect(f.catalog.locations).toHaveLength(2)
    expect(f.onSelect).not.toHaveBeenCalled()
  })

  it('checks explicit clicks against the exact original occurrence while keeping composition selection available', () => {
    const f = fixture()
    selectWorkbenchProjectionTab(f.scope, 'missing', f.tab)
    selectWorkbenchProjectionTab(f.scope, 'second', f.tab, 'missing')
    expect(f.onSelect).not.toHaveBeenCalled()
    selectWorkbenchProjectionTab(f.scope, 'second', f.tab)
    expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(f.reference)
    const { selectionMode: _mode, ...composition } = f.scope
    selectWorkbenchProjectionTab(composition, 'synthetic-composition-group', f.tab)
    expect(f.onSelect).toHaveBeenCalledTimes(2)
  })

  it('keeps a legal catalog reference unconfirmed when its Group is absent from the rendered tree', () => {
    const f = fixture(), firstOnly = { ...f.layout, root: createWorkspaceLayout('first', [f.tab.id]).root }
    const result = projectWorkbenchProjection(firstOnly, f.tabs, f.scope)
    expect(result.selection).toEqual([])
    expect(result.layout?.groups.map(group => group.activeTabId)).toEqual([null, null])
    expect(result.issues.join(' ')).toContain('still restoring')
    expect(f.catalog.locations).toHaveLength(2)
  })

  it('retains honest unsupported live display when two explicit selections request the same Tab', () => {
    const f = fixture()
    const result = projectWorkbenchProjection(f.layout, f.tabs, { ...f.scope, selection: [{ ...f.reference, groupId: 'first' }, f.reference] })
    expect(result.selection).toHaveLength(2)
    expect([...result.unsupportedTabIds]).toEqual([f.tab.id])
    expect(f.catalog.locations).toHaveLength(2)
  })
})

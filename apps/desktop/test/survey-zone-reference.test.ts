// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout, removeTab } from '@agentmux/layout'
import { resolveWorkbenchZone, projectWorkbenchProjection, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { persistedSurveyZoneSelection, restoredSurveyZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig } from './helpers/composer-dom-fixture'

function fixture() {
  const workspace = composerConfig.workspaces[0]!
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: workspace.id })
  const layouts = { [workspace.id]: createWorkspaceLayout('actual-group', [tab.id]) }
  const state = { config: composerConfig, sessions: [], tabs: { [tab.id]: tab }, layouts, spaceZoneBindings: {} }
  const catalog = spatialCatalog(state, []), zoneId = catalog.tabs[0]!.zoneId!
  const resolve = (preferences: WorkbenchProjection['selection'] = []) => resolveWorkbenchZone(zoneId, catalog, layouts, state.tabs, 'test-zone', preferences, () => {})
  return { ...state, workspace, tab, catalog, zoneId, resolve }
}

describe('Zone identity loading', () => {
  it('opens original composition after every saved display coordinate has become invalid', () => {
    const f = fixture(), stale = { displayWorkspaceId: 'deleted-workspace', groupId: 'deleted-group', tabId: f.tab.id, regionId: 'deleted-region' }
    const views = f.resolve([stale])
    expect(views).not.toBeNull()
    expect(views!.selection).toEqual([{ displayWorkspaceId: f.workspace.id, groupId: 'actual-group', tabId: f.tab.id, regionId: 'original-region' }])
    const projected = projectWorkbenchProjection(f.layouts[f.workspace.id], f.tabs, views!)
    expect(projected.layout?.groups[0]!.activeTabId).toBe(f.tab.id)
    expect(projected.issues).toEqual([])
    expect(f.tabs[f.tab.id]).toBe(f.tab)
    expect(f.layouts[f.workspace.id].groups[0]!.tabOrder).toEqual([f.tab.id])
  })

  it('loads one Zone independent of its foreign display aliases and preserves every binding', () => {
    const f = fixture(), layouts = { foreign: createWorkspaceLayout('foreign-group', [f.tab.id]), other: createWorkspaceLayout('other-group', [f.tab.id]) }
    const catalog = spatialCatalog({ ...f, layouts }, [])
    const views = resolveWorkbenchZone(f.zoneId, catalog, layouts, f.tabs, 'test-zone', [], () => {})
    expect(views!.displayWorkspaceId).toBe(f.workspace.id)
    expect(views!.selection).toHaveLength(1)
    expect(views!.selection[0]!.tabId).toBe(f.tab.id)
    expect(layouts.foreign.groups[0]!.tabOrder).toEqual([f.tab.id])
    expect(layouts.other.groups[0]!.tabOrder).toEqual([f.tab.id])
    expect(f.tabs[f.tab.id]).toBe(f.tab)
  })

  it('loads the original Tab after its final display binding is removed without recreating that binding', () => {
    const f = fixture(), layouts = { [f.workspace.id]: removeTab(f.layouts[f.workspace.id]!, 'actual-group', f.tab.id) }
    const catalog = spatialCatalog({ ...f, layouts }, [])
    expect(catalog.locations).toEqual([])
    const views = resolveWorkbenchZone(f.zoneId, catalog, layouts, f.tabs, 'test-zone', [], () => {})
    expect(views).not.toBeNull()
    const projected = projectWorkbenchProjection(layouts[f.workspace.id], f.tabs, views!)
    expect(projected.layout?.groups[0]?.tabOrder).toEqual([f.tab.id])
    expect(projected.selection[0]?.regionId).toBe('original-region')
    expect(projected.issues).toEqual([])
    expect(f.tabs[f.tab.id]).toBe(f.tab)
    expect(layouts[f.workspace.id]?.groups[0]?.tabOrder).toEqual([])
    expect(spatialCatalog({ ...f, layouts }, []).locations).toEqual([])
    const saved = persistedSurveyZoneSelection({ zoneId: f.zoneId, selection: projected.selection, active: projected.selection[0]! })
    expect(restoredSurveyZoneSelection(saved)?.active?.tabId).toBe(f.tab.id)
  })

  it('does not depend on the redundant catalog location index to load a known Zone', () => {
    const f = fixture()
    const views = resolveWorkbenchZone(f.zoneId, { ...f.catalog, locations: [] }, f.layouts, f.tabs, 'test-zone', [], () => {})
    expect(views!.selection[0]!.tabId).toBe(f.tab.id)
  })

  it('saves member preferences only and resolves them against the original restored topology', () => {
    const f = fixture(), reference = f.resolve()!.selection[0]!
    const saved = persistedSurveyZoneSelection({ zoneId: f.zoneId, selection: [reference], active: reference })!
    expect(saved).toEqual({ zoneId: f.zoneId, selection: [{ tabId: f.tab.id, regionId: 'original-region' }], active: { tabId: f.tab.id, regionId: 'original-region' } })
    expect(restoredSurveyZoneSelection(saved)?.active).toEqual({ tabId: f.tab.id, regionId: 'original-region' })
    useAppStore.setState({ ...f, surveyZoneSelection: { zoneId: f.zoneId, selection: [reference], active: reference } })
    const actual = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
    expect(actual.surveyZoneSelection).toEqual(saved)
    expect(actual.restoredWorkbench?.tabs[f.tab.id]?.regions['original-region']).toBeDefined()
    expect(actual.restoredWorkbench?.layouts).toEqual(f.layouts)
  })

  it('keeps a missing Zone reference without inventing an entity or erasing content', () => {
    const f = fixture(), before = f.tabs
    expect(resolveWorkbenchZone('unavailable-zone', f.catalog, f.layouts, f.tabs, 'test-zone', [], () => {})).toBeNull()
    expect(restoredSurveyZoneSelection({ zoneId: 'unavailable-zone' })).toEqual({ zoneId: 'unavailable-zone', selection: [], active: null })
    expect(f.tabs).toBe(before)
  })
})

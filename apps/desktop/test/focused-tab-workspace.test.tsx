import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection.js'

import { projectWorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { spatialCatalog, selectSpatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { api } from '../src/renderer/src/lib/api'

const workbenchSource = readFileSync(new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url), 'utf8')

function tab(id: string, sessionId: string): WorkbenchTab {
  return createWorkbenchTab(id, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId })
}

describe('Focus Tab projection', () => {
  it('resolves the complete durable Tab for the focused session', async () => {
    const complete = tab('second', 'session-2')
    complete.regions['second:terminal'] = { regionId: 'second:terminal', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'terminal-2' }
    const original = { first: tab('first', 'session-1'), second: complete }
    const restored = JSON.parse(JSON.stringify(original)) as typeof original
    const selected = tabForFocusedSession(restored, 'session-2')
    expect(selected?.id).toBe('second')
    expect(Object.keys(selected?.regions ?? {})).toEqual(['second:region', 'second:terminal'])
    const durable = { root: { type: 'leaf' as const, groupId: 'original-group' }, groups: [{ id: 'original-group', activeTabId: 'first', tabOrder: ['first', 'second'], recentTabIds: ['first', 'second'] }], activeGroupId: 'original-group' }
    const config = await api.config.get()
    const catalog = spatialCatalog({ config: { ...config, workspaces: [{ id: 'workspace', kind: 'folder', hostId: 'local', path: '/private/workspace', name: 'Workspace' }] },
      sessions: [], tabs: restored, layouts: { workspace: durable }, spaceZoneBindings: {}, spatialRequests: {} }, [])
    const reference = { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: 'second', regionId: 'second:region' }
    expect(catalog.locations.filter(location => location.tabId === 'second').map(location => location.regionId)).toEqual(['second:region'])
    const projected = projectWorkbenchProjection(durable, restored, { entity: { kind: 'tab', tabId: selected!.id },
      presentationId: 'test-focus', displayWorkspaceId: 'workspace', catalog: selectSpatialCatalog(catalog, reference), selection: [reference], onSelect() {} })
    expect(projected.issues).toEqual([])
    expect(projected.layout?.groups[0]).toEqual({ ...durable.groups[0], activeTabId: 'second', tabOrder: ['second'], recentTabIds: ['second'] })
    expect(projected.layout?.activeGroupId).toBe('original-group')
    expect(durable.groups[0]?.tabOrder).toEqual(['first', 'second'])
    expect(tabForFocusedSession(restored, null)).toBeNull()
  })

  it('keeps the normal interactive Region tree as the only Focus owner', () => {
    const start = workbenchSource.indexOf("{viewOwnership === 'owner' && Object.values(tabs)")
    const end = workbenchSource.indexOf('</StableWorkbenchView>', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const owner = workbenchSource.slice(start, end)
    expect(owner).toContain('<StableWorkbenchView key={tab.id}')
    expect(owner).toContain('<WorkbenchRegionTree')
    expect(owner).toContain('const targetId = projection?.hostId ?? null')
    const view = readFileSync(new URL('../src/renderer/src/components/StableWorkbenchView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('createPortal(children, host)')
    expect(view).toContain('destination.append(host)')
    expect(view).toContain('observer.disconnect()')
  })
})

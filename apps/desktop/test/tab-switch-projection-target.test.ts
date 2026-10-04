import { expect, it, vi } from 'vitest'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { selectWorkbenchProjectionTab, workbenchProjectionTabReference, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'

it('uses the same held exact Region for projection navigation and click observation', () => {
  const tab = addWorkbenchRegion(createWorkbenchTab('tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace',
    regionId: 'agent', sessionId: 'agent' }), 'agent', 'horizontal', {
    kind: 'terminal', phase: 'attached', workspaceId: 'workspace', regionId: 'raw', sessionId: 'terminal'
  })
  expect(tab.layout.activeRegionId).toBe('raw')
  const held = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'agent' }
  const onSelect = vi.fn()
  // Controlled catalog port: these are the original exact references consumed by the selector.
  const scope = { entity: { kind: 'tab', tabId: 'tab' }, presentationId: 'focus', displayWorkspaceId: 'workspace',
    selection: [held], catalog: { locations: [held] }, onSelect } as unknown as WorkbenchProjection
  expect(workbenchProjectionTabReference(scope, 'group', tab)).toEqual(held)
  selectWorkbenchProjectionTab(scope, 'group', tab)
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(held)
  const region = { ...scope, entity: { kind: 'region' as const, regionId: 'agent' }, selection: [] }
  expect(workbenchProjectionTabReference(region, 'group', tab)).toEqual(held)
})

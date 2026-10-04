import { expect, it } from 'vitest'
import { addWorkbenchRegion, assertRegionInvariant, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { reducePersistedTab, hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'

it('an Agent retains its remote resource Workspace when split below a local Tab', () => {
  const local = createWorkbenchTab('local-tab', { kind: 'agent', phase: 'attached', workspaceId: 'local-resource', regionId: 'local-region', sessionId: 'local-session' })
  const split = addWorkbenchRegion(local, 'local-region', 'down', { kind: 'agent', phase: 'launching', workspaceId: 'remote-resource', regionId: 'remote-region', sessionId: 'remote-session' })
  expect(split).not.toBe(local)
  expect(split.workspaceId).toBe('local-resource')
  expect(split.regions['local-region']).toMatchObject({ workspaceId: 'local-resource', sessionId: 'local-session' })
  expect(split.regions['remote-region']).toMatchObject({ workspaceId: 'remote-resource', sessionId: 'remote-session' })
  expect(split.layout.root).toMatchObject({ type: 'split', direction: 'vertical', first: { regionId: 'local-region' }, second: { regionId: 'remote-region' } })
  assertRegionInvariant(split)
  expect(hydratePersistedTab(reducePersistedTab(split)).regions['remote-region']).toMatchObject({ workspaceId: 'remote-resource', sessionId: 'remote-session' })
})

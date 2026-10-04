import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { spatialCatalog, zoneContext, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'

const config = { workspaces: [{ id: 'resource', hostId: 'local', name: 'Resource', kind: 'folder', path: _hygiene_fixturePath("moved") }] } as AppConfig
function state(kind: 'folder' | 'worktree'): SpatialWorkbench {
  return { config: { ...config, workspaces: config.workspaces.map(workspace => ({ ...workspace, kind })) },
    sessions: [], tabs: {}, layouts: {}, spatialRequests: {},
    spaceZoneBindings: { 'zone:original': { workspaceId: 'resource', spaceId: directoryIdentity('local', _hygiene_fixturePath("birth")), directoryPath: _hygiene_fixturePath("moved") } } }
}
it.each(['folder', 'worktree'] as const)('keeps a %s Zone with a confirmed moved resource in its original birth context', kind => {
  const original = state(kind), zone = spatialCatalog(original, []).zones.find(zone => zone.zoneId === 'zone:original')!
  expect(zone).toMatchObject({ kind: kind === 'folder' ? 'directory' : 'worktree', directoryPath: _hygiene_fixturePath("moved") })
  expect(zoneContext(original, [], zone)).toBe(directoryIdentity('local', _hygiene_fixturePath("birth")))
  expect(original.spaceZoneBindings['zone:original']?.directoryPath).toBe(_hygiene_fixturePath("moved"))
})
it('retains the Home classification and rejects a contradictory saved Home resource context', () => {
  const original = state('folder'), birth = directoryIdentity('local', _hygiene_fixturePath("birth")), zoneId = homeZoneId(birth)
  original.config = { ...config, workspaces: [{ ...config.workspaces[0]!, id: '__scratch__', path: _hygiene_fixturePath("scratch") }] }
  original.spaceZoneBindings = { [zoneId]: { workspaceId: '__scratch__', spaceId: birth, directoryPath: _hygiene_fixturePath("different") } }
  const zone = spatialCatalog(original, []).zones.find(zone => zone.zoneId === zoneId)!
  expect(zone).toMatchObject({ kind: 'home', directoryPath: _hygiene_fixturePath("different") })
  expect(() => zoneContext(original, [], zone)).toThrow('The saved home context contradicts')
  expect(original.spaceZoneBindings[zoneId]?.spaceId).toBe(birth)
})

import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { spatialCatalog } from '../../../packages/core/src/spatial-graph'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { composerConfig } from './helpers/composer-dom-fixture'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('the public space receipt carries the acknowledged native user save through the real JSON codec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-public-save-')); roots.push(root)
  const user = new WorkbenchUserStateStore(join(root, 'user-state.json'))
  const userAck = await user.write(JSON.stringify({ state: { agentComposerDrafts: { original: 'Retained original' } }, version: 1 }))
  const config = { ...structuredClone(composerConfig), workspaces: [{ id: 'original-project', hostId: 'local', path: root, name: 'Private proof', kind: 'folder' as const }] }
  const owner = new AgentMuxSpatialStateStore(join(root, 'spatial-state.json'))
  const state = await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [], tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const zone = state.graph.zones[0]!, space = state.graph.spaces[0]!
  const report = { operationId: 'original-bind', binding: { kind: 'zone-space', spaceId: space.spaceId, zoneId: zone.zoneId }, outcome: 'linked',
    catalog: spatialCatalog(state.graph), save: { layoutApplied: true, clientStateWritten: userAck.diskDurability === 'confirmed',
      storageFlushRequested: true, diskDurability: 'confirmed', reason: null }, issues: [] }
  const parsed = parseRpcControlResult('space.bind', JSON.parse(JSON.stringify(report)))
  expect(parsed).toMatchObject({ save: { clientStateWritten: true, diskDurability: 'confirmed' } })
  expect(JSON.stringify(parsed)).not.toContain('localStorageWritten')
  expect(JSON.parse((await user.read())!).state.agentComposerDrafts.original).toBe('Retained original')
  const old = { ...report, save: { ...report.save, localStorageWritten: true } }
  delete (old.save as Partial<typeof old.save>).clientStateWritten
  expect(() => parseRpcControlResult('space.bind', old)).toThrow()
})

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc'
import { buildStoragePublicCli } from '../scripts/fixtures/durable-workbench-storage/build-public-cli.mjs'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { spatialCatalog } from '../../../packages/core/src/spatial-graph'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { composerConfig } from './helpers/composer-dom-fixture'

let cliRoot: string, cli: string
beforeAll(async () => { cliRoot = await mkdtemp(join(tmpdir(), 'amux-storage-cli-')); cli = await buildStoragePublicCli(join(cliRoot, 'agentmux.mjs')) }, 30000)
afterAll(async () => { await rm(cliRoot, { recursive: true, force: true }) })
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
  // The actual current source CLI uses its public RPC client and strict codec.
  // Its private server returns the real file owners' receipt, with no lifecycle client.
  const probe = new ObjectCliProbe(request => {
    expect(request.method).toBe('space.bind')
    return report
  })
  await probe.start()
  try {
    const result = await promisify(execFile)(process.execPath, [cli, 'space', 'bind', '--zone', zone.zoneId,
      '--space', space.spaceId, '--operation-id', report.operationId], { env: probe.environment(), timeout: 15000 })
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { save: { clientStateWritten: true, diskDurability: 'confirmed' } } })
    expect(result.stdout).not.toContain('localStorageWritten')
    expect(probe.requests).toHaveLength(1)
  } finally { await probe.stop() }
})

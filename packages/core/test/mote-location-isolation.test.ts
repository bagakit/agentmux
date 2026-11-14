import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { ScratchTopics } from '../../../apps/host/src/mote-resources.js'
import { createHostSpatialPresentation } from '../../../apps/host/src/spatial-presentation.js'
import { createHostContent } from '../../../apps/host/src/content-owner.js'
import { directoryIdentity, homeZoneId, serializeMoteQuickMode } from '../../../apps/host/src/mote-model.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

type MissingSource = 'missing-home' | 'foreign-home-id' | 'foreign-home-host' | 'missing-workspace'
async function fixture(mode?: MissingSource) {
  const original = await rpcOwnerFixture([]); cleanup.push(original.close)
  const workspace = { id: '__scratch__', hostId: 'local', name: 'Original Scratch', path: join(original.root, 'scratch') }
  await mkdir(workspace.path)
  const topics = new ScratchTopics()
  const snapshots = await Promise.all(['AbCdEfGh1234', 'BcDeFgHi2345'].map(id => topics.ensureMote(workspace, id)))
  await Promise.all(snapshots.map(topic => writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), serializeMoteQuickMode('', {}))))
  const spaces = snapshots.map(topic => ({ spaceId: directoryIdentity('local', topic.identityDirectoryPath!), kind: 'mote' as const,
    name: topic.title, topicId: topic.id, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null }))
  const graph = { spaces, zones: spaces.map(space => ({ zoneId: homeZoneId(space.spaceId), workspaceId: workspace.id,
    kind: 'home' as const, hostId: 'local', directoryPath: space.directoryPath, branch: null })),
    bindings: spaces.map(space => ({ spaceId: space.spaceId, zoneId: homeZoneId(space.spaceId) })),
    tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: { original: { draft: 'Keep original unsent work' } } }
  if (mode === 'missing-home') { graph.zones.splice(0, 1); graph.bindings.splice(0, 1) }
  if (mode === 'foreign-home-id') { graph.zones[0]!.zoneId = 'another-original-home'; graph.bindings[0]!.zoneId = 'another-original-home' }
  if (mode === 'foreign-home-host') graph.zones[0]!.hostId = 'another-host'
  const spatial = new AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph })
  const configurationPath = join(original.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: mode === 'missing-workspace' ? [] : [workspace], executors: {} }))
  const content = createHostContent({ configurationPath, spatial })
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'presentation.sock'), coreClients: original.coreClients,
    spatialState: spatial, ...content, spatialPresentation: createHostSpatialPresentation({ configurationPath, clients: original.coreClients }) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const cli = async (action: 'inspect' | 'ls', spaceId?: string) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'space', action,
      ...(spaceId ? ['--space', spaceId] : []), '--presentation'], objectCliEnvironment(original.root), '', 30_000,
      new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
    expect(result.code, result.stderr || result.stdout).toBe(0)
    return JSON.parse(result.stdout).result.catalog
  }
  return { original, workspace, snapshots, graph, spatial, configurationPath, rpc, cli }
}

it('the original public CLI retains confirmed content through a Quick failure and a fresh read recovers', async () => {
  const f = await fixture(), space = f.graph.spaces[0]!, other = f.graph.spaces[1]!
  const before = await f.spatial.read(), originalFile = await readFile(join(space.directoryPath, 'MOTE.md'), 'utf8')
  const healthy = (await f.cli('inspect', space.spaceId)).motePresentation[0]
  const expected = { zoneId: homeZoneId(space.spaceId), hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.workspace.path }
  expect(healthy, JSON.stringify(healthy)).toMatchObject({ spaceId: space.spaceId, content: expected, quickMode: { status: 'saved' } })
  const read = ScratchTopics.prototype.read
  vi.spyOn(ScratchTopics.prototype, 'read').mockImplementation(function (workspace, topicId) {
    if (topicId === space.topicId) throw Error('Original Quick observation unavailable')
    return read.call(this, workspace, topicId)
  })
  const failed = await f.cli('ls'), row = failed.motePresentation.find((value: { spaceId: string }) => value.spaceId === space.spaceId)
  expect(row.content).toEqual(expected)
  expect(row).toMatchObject({ quickMode: { status: 'unconfirmed', message: 'Original Quick observation unavailable' },
    conversation: null, issue: 'Original Quick observation unavailable' })
  expect(failed.motePresentation.find((value: { spaceId: string }) => value.spaceId === other.spaceId)).toMatchObject({
    content: { zoneId: homeZoneId(other.spaceId), hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.workspace.path }, quickMode: { status: 'saved' } })
  const { zoneId, ...expectedResource } = row.content
  const identity = await f.rpc.call('file.read', { spaceId: space.spaceId, zoneId, expectedResource, path: 'SOUL.md' })
  expect(identity.result.status).toBe('read')
  expect(identity.resource).toMatchObject({ zoneId, ...expectedResource })
  if (identity.result.status === 'read') expect(identity.result.document.content).toBe(await readFile(join(space.directoryPath, 'SOUL.md'), 'utf8'))
  vi.restoreAllMocks()
  const recovered = await f.rpc.call('space.inspect', { target: { spaceId: space.spaceId }, presentation: true })
  expect(recovered.catalog.motePresentation?.[0]).toMatchObject({ content: expected, quickMode: { status: 'saved' } })
  expect(await f.spatial.read()).toEqual(before)
  expect(await readFile(join(space.directoryPath, 'MOTE.md'), 'utf8')).toBe(originalFile)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.original.rawInput).not.toHaveBeenCalled()
})

it.each(['missing-home', 'foreign-home-id', 'foreign-home-host', 'missing-workspace'] as const)(
  'the public original owner never invents content with %s', async mode => {
    const f = await fixture(mode), space = f.graph.spaces[0]!
    const result = await f.rpc.call('space.inspect', { target: { spaceId: space.spaceId }, presentation: true })
    expect(result.catalog.motePresentation?.[0]).toMatchObject({ spaceId: space.spaceId, content: null })
  })

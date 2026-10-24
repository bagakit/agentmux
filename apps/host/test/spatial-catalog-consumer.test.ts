import { appendFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const witness = (value: unknown) => {
  if (process.env.HOST_SPATIAL_FACTS) appendFileSync(process.env.HOST_SPATIAL_FACTS, JSON.stringify(value) + '\n')
}

async function fixture() {
  const original = await rpcOwnerFixture(['original-catalog-agent'], core)
  cleanup.push(original.close)
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  const graph: core.AgentMuxSpatialGraph = {
    spaces: [{ spaceId: 'original-mote', name: 'Original Mote', kind: 'mote', hostId: 'local',
      directoryPath: join(original.root, 'resource'), projectId: null, topicId: 'original-topic' }],
    zones: [{ zoneId: 'original-home', workspaceId: 'original-workspace', kind: 'home', hostId: 'local',
      directoryPath: join(original.root, 'resource'), branch: null }],
    bindings: [{ spaceId: 'original-mote', zoneId: 'original-home' }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-home', workspaceId: 'original-workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'original-catalog-agent',
      runId: 'run-original-catalog-agent', execution: { hostId: 'local', cwd: original.root } }],
    layouts: {}, tabLayouts: {}, resources: {}
  }
  await spatial.commit({ expectedRevision: 0, graph })
  // The catalog is the real durable Core graph. No File/Mote directory identity
  // or platform capability is asserted by these spatial read consumers.
  const before = await readFile(spatial.path, 'utf8'), native = original.inner.kernel
  await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'identity', 'status', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const socketPath = join(original.root, 'host.sock'), desktopSocketPath = join(original.root, 'absent-desktop.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath,
      mobileBuildDirectory: join(original.root, 'absent-mobile'),
      connections: { directory: join(original.root, 'connections'), spatial, adapters: [] } })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const client = async (credentials?: NonNullable<Parameters<typeof core.connectAgentMuxRpc>[0]>['credentials']) => {
    const value = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath }, ...(credentials ? { credentials } : {}) })
    cleanup.push(() => value.dispose()); return value
  }
  return { original, spatial, graph, before, host, client, desktopSocketPath }
}

it('the actual Host SDK reads its registered original catalog despite an available Desktop forward route', async () => {
  const f = await fixture(), client = await f.client()
  const outcome = await client.call('space.ls', { target: {} }).then(value => ({ catalog: value.catalog }), error => ({ error: error.code }))
  witness({ case: 'headless-original-catalog', outcome, expectedSpaceIds: ['original-mote'] })
  expect(outcome, 'the registered Host catalog must remain readable without Desktop').toEqual({ catalog: core.spatialCatalog(f.graph) })
  expect(await client.call('space.inspect', { target: { spaceId: 'original-mote' } })).toEqual({ catalog: core.spatialCatalog(f.graph, { spaceId: 'original-mote' }) })
  expect(await client.call('space.inspect', { target: { regionId: 'original-region' }, presentation: false })).toEqual({ catalog: core.spatialCatalog(f.graph, { regionId: 'original-region' }) })
  expect(await readFile(f.spatial.path, 'utf8')).toBe(f.before)
  await expect(stat(f.desktopSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('the original selector parser and retained capability still qualify a Headless catalog read', async () => {
  const f = await fixture(), user = await f.client()
  await expect(user.call('space.ls', { target: { spaceId: 'original-mote', zoneId: 'original-home' } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(user.call('space.inspect', { target: { spaceId: 'original-mote', hostId: 'another-host' } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect((await user.call('space.inspect', { target: { spaceId: 'another-mote' } })).catalog.spaces).toEqual([])
  const invalid = await f.client({ ...f.original.credentials, capability: 'invalid-original-capability' })
  await expect(invalid.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const valid = await f.client(f.original.credentials)
  expect((await valid.call('space.ls', { target: {} })).catalog).toEqual(core.spatialCatalog(f.graph))
  expect(await readFile(f.spatial.path, 'utf8')).toBe(f.before)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('domain presentation remains with the Host while self screen and mutation inspection retain their exact owner', async () => {
  const f = await fixture(), client = await f.client()
  const presentation = await client.call('space.inspect', { target: { spaceId: 'original-mote' }, presentation: true })
  expect(presentation.catalog.spaces).toEqual(f.graph.spaces)
  expect(presentation.catalog.agentPresentation).toMatchObject([{ agentSessionId: 'original-catalog-agent' }])
  await expect(client.call('space.inspect', { target: { operationId: 'original-mutation' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(client.call('space.inspect', { target: { regionId: 'self' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await client.call('space.ls', { target: {} })).catalog).toEqual(core.spatialCatalog(f.graph))
  expect(await readFile(f.spatial.path, 'utf8')).toBe(f.before)
})

it('registered spatial reads keep the Core owner while an unregistered endpoint preserves its declared forwarding', async () => {
  const f = await fixture(), catalog = core.spatialCatalog(f.graph)
  const execute = vi.fn<NonNullable<core.AgentMuxControlServerOptions['execute']>>(async () => ({ operation: 'space.ls', catalog }))
  const rich = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'rich.sock'), coreClients: () => [], spatialState: f.spatial, execute })
  cleanup.push(() => rich.stop()); await rich.start()
  const richClient = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: rich.path } })
  cleanup.push(() => richClient.dispose())
  expect((await richClient.call('space.ls', { target: {} })).catalog).toEqual(catalog)
  expect(execute).not.toHaveBeenCalled()
  const forward = vi.fn(async () => ({ catalog }))
  const bare = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'bare.sock'), coreClients: () => [],
    forwardControl: forward as NonNullable<core.AgentMuxControlServerOptions['forwardControl']> })
  cleanup.push(() => bare.stop()); await bare.start()
  const bareClient = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: bare.path } })
  cleanup.push(() => bareClient.dispose())
  expect((await bareClient.call('space.ls', { target: {} })).catalog).toEqual(catalog)
  expect(forward).toHaveBeenCalledExactlyOnceWith('space.ls', { target: {} }, expect.any(Object))
})

import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeLocationSource } from '../src/node-location-source.js'
import { parseNodePublishingResult } from '../src/node-publishing.js'
import { NodePublishingOwner } from '../src/node-publishing-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

const publicPolicy = { label: '', coordinates: '', estimatePublicEgress: true }
const fixtureSite = { label: 'North site', latitude: 51, longitude: -2 }
const egress = () => vi.fn(async () => ({ latitude: '31.48', longitude: '121.49', city: 'Example city', accuracy: 120, ip: '198.51.100.17' }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('prefers a declaration and an exact site registration over private subnet and outward exit estimates', async () => {
  const lookup = egress()
  const source = new NodeLocationSource({
    readSites: async () => [{ ...fixtureSite, runtimeIds: ['original'] }, { label: 'Subnet site', latitude: 0, longitude: 0, subnets: ['fd00::/64'] }],
    addresses: () => ['fd00::4'], egress: lookup,
  })
  expect(await source.read('original', { ...publicPolicy, label: 'Office', coordinates: '0, 0' })).toEqual({ latitude: 0, longitude: 0, source: 'node', label: 'Office' })
  expect(await source.read('original', publicPolicy)).toEqual({ ...fixtureSite, source: 'site' })
  expect(await source.read('different')).toEqual({ source: 'site', latitude: 0, longitude: 0, label: 'Subnet site' })
  expect(lookup).not.toHaveBeenCalled()
})

it('keeps unrelated or ambiguous sites unknown and rounds only an enabled original egress observation', async () => {
  const lookup = egress(), addresses = ['10.123.0.10']
  const source = new NodeLocationSource({ addresses: () => addresses, readSites: async () => [
    { ...fixtureSite, subnets: ['10.123.0.0/24'] }, { ...fixtureSite, label: 'Other', subnets: ['10.123.0.0/16'] },
  ], egress: lookup })
  expect(await source.read('original')).toBeNull()
  addresses[0] = '192.0.2.10'
  expect(await source.read('original')).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
  const result = { source: 'public-egress', latitude: 31, longitude: 121, label: 'Example city', accuracyKm: 120 }
  expect(await source.read('original', publicPolicy)).toEqual(result)
  expect(await source.read('original', publicPolicy)).toEqual(result)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(await source.read('original')).toBeNull()
})

it('cancels the caller’s current egress read and never records a cancelled estimate', async () => {
  const started = Promise.withResolvers<void>()
  const lookup = vi.fn((signal: AbortSignal) => { started.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const source = new NodeLocationSource({ readSites: async () => [], addresses: () => [], egress: lookup })
  const cancel = new AbortController()
  const read = source.read('original', publicPolicy, cancel.signal)
  await started.promise
  cancel.abort()
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  expect(await source.read('original')).toBeNull()
})

it('serves only a published location through the real RPC endpoint and preserves the declaration across owner restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-location-')), socket = join(root, 'rpc.sock')
  const owner = () => new NodePublishingOwner({ stateDirectory: root, runtimeId: 'original', ownerInstanceId: 'instance', meshPeer: () => ({ networkId: 'network', peerId: 'this-peer' }) })
  const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [], nodePublishing: owner() })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    const path = join(root, 'sites.json')
    await writeFile(path, JSON.stringify([{ ...fixtureSite, runtimeIds: ['original'] }]))
    vi.stubEnv('AGENTMUX_NODE_SITE_CATALOG', path)
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    const input = { hostId: 'local', expectedRuntimeId: 'original' }
    expect(await rpc.call('node.location', input)).toMatchObject({ location: { ...fixtureSite, source: 'site' }, meshPeer: { networkId: 'network', peerId: 'this-peer' } })
    const initial = await rpc.call('settings.node.inspect', {})
    const mapLocation = { coordinates: '25, -45', label: 'Field office', estimatePublicEgress: false }
    const saved = await rpc.call('settings.node.configure', { operationId: 'set-map', expectedRevision: initial.policyRevision, policy: { ...initial.policy, mapLocation } })
    expect(saved.operation?.status).toBe('confirmed')
    const after = await owner().call('node.location', input)
    expect(after.location).toEqual({ latitude: 25, longitude: -45, source: 'node', label: 'Field office' })
    await expect(rpc.call('node.location', { ...input, expectedRuntimeId: 'elsewhere' })).rejects.toMatchObject({ code: 'NODE_RUNTIME_MISMATCH' })
    expect(() => parseNodePublishingResult('node.location', after, { ...input, expectedRuntimeId: 'elsewhere' })).toThrow()
    expect(await rpc.call('node.inspect', input)).not.toHaveProperty('location')
    const lookup = vi.fn(async () => Response.json({ latitude: '35.3102', longitude: '139.8265', city: 'Example', accuracy: 20, ip: '198.51.100.23' }))
    vi.stubGlobal('fetch', lookup)
    await writeFile(path, '[]')
    const next = await rpc.call('settings.node.configure', { operationId: 'allow-egress', expectedRevision: saved.policyRevision, policy: { ...saved.policy, mapLocation: publicPolicy } })
    expect(lookup).not.toHaveBeenCalled()
    expect((await rpc.call('node.location', input)).location).toEqual({ latitude: 35, longitude: 140, label: 'Example', source: 'public-egress', accuracyKm: 80 })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('https://get.geojs.io/v1/ip/geo.json', expect.objectContaining({ signal: expect.anything() }))
    await rpc.call('settings.node.configure', { operationId: 'stop-egress', expectedRevision: next.policyRevision, policy: { ...next.policy, mapLocation: { ...publicPolicy, estimatePublicEgress: false } } })
    expect((await rpc.call('node.location', input)).location).toBeNull()
    expect(lookup).toHaveBeenCalledTimes(1)
  } finally { await rpc?.dispose(); await server.stop(); await rm(root, { recursive: true, force: true }) }
})

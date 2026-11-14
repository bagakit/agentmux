import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, vi } from 'vitest'
const leases = vi.hoisted(() => new Map<string, { forwardRpc: ReturnType<typeof vi.fn>; subscribeRpc: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>())
vi.mock('@agentmux/core', async () => {
  const { AgentMuxError } = await import('../../../packages/core/src/errors.js')
  const { hostRouteTransport } = await import('../../../packages/core/src/host-route-rpc.js')
  return { AgentMuxError, hostRouteTransport, connectSshAgentMux: vi.fn(async (options: { target: { hostId: string }; expectedRuntimeId: string }) => {
    const client = { forwardRpc: vi.fn(async () => ({ runtimeId: options.expectedRuntimeId, publicKey: 'original-key', fingerprint: 'original-fingerprint' })),
      subscribeRpc: vi.fn(), dispose: vi.fn(async () => {}) }
    leases.set(options.target.hostId, client); return client
  }) }
})
import { configuredHostClients } from '../src/configured-host-clients.js'
import { configuredRouteEdge } from '../src/host-route-edges.js'

test('the actual configured Host owner serves the exact route edge without materializing unrelated leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-route-hosts-')), path = join(root, 'config.json')
  const hosts = Array.from({ length: 1000 }, (_, index) => ({ id: 'host-' + index, kind: 'ssh', label: 'Host ' + index, hostname: 'private-' + index, runtimeId: 'runtime-' + index }))
  await writeFile(path, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Local' }, ...hosts] }))
  const owner = configuredHostClients(path)
  try {
    owner.start(); await vi.waitFor(() => expect(owner.clients()).toHaveLength(1000), { timeout: 5000 })
    const scopes: (string | undefined)[] = []
    const edge = configuredRouteEdge(hostId => { scopes.push(hostId); const selected = owner.clients(hostId); expect(selected).toHaveLength(1); return selected }, 'host-555')
    expect(await edge.identity()).toEqual({ runtimeId: 'runtime-555', publicKey: 'original-key', fingerprint: 'original-fingerprint' })
    expect(scopes).toEqual(['host-555'])
    expect(leases.get('host-555')!.forwardRpc).toHaveBeenCalledOnce()
    expect(leases.get('host-556')!.forwardRpc).not.toHaveBeenCalled()
    expect(owner.clients('missing')).toEqual([])
    expect(owner.clients()).toHaveLength(1000)
    for (const lease of leases.values()) expect(lease.dispose).not.toHaveBeenCalled()
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); leases.clear() }
})

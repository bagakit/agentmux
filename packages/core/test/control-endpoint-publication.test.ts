import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
it('contains a throwing publication consumer while the real endpoint remains available', async () => {
  const root = await mkdtemp(fixturePath("tmp/amcp-")), path = join(root, 'a')
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const server = new AgentMuxControlServer({ socketPath: path, onControlEndpointState: () => { throw new Error('Observer failed') } })
  cleanup.push(async () => { await server.stop(); await rm(root, { recursive: true }) })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  expect((await rpc.call('system.endpoint', {})).publication).toEqual({ state: 'available' })
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTROL_OBSERVER_FAILED' }))
})
it('cancels initial publication without a late Unix or HTTP listener appearing after stop', async () => {
  const root = await mkdtemp(fixturePath("tmp/amcp-")), path = join(root, 'a')
  const server = new AgentMuxControlServer({ socketPath: path, http: { host: '127.0.0.1', port: 0, token: 'private-stop-fixture' } })
  cleanup.push(async () => { await server.stop(); await rm(root, { recursive: true }) })
  const started = server.start().then(() => ({ started: true }), error => ({ error }))
  await server.stop()
  expect(await started).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  expect(server.httpAddress).toBeNull()
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('delivers only the latest cached fact after registration and respects release and disposal', async () => {
  const publisher = new AgentMuxClientEventPublisher(), events: AgentMuxClientEvent[] = []
  let current: AgentMuxClientEvent = { type: 'control-endpoint-state', state: 'unavailable', diagnostic: { code: 'ENOSPC', message: 'pressure' }, evidence: { source: 'agentmux', observedAt: 1 } }
  const first = vi.fn(), disposed = vi.fn()
  const release = publisher.onEvent(first, {}, () => current); release()
  publisher.onEvent(event => events.push(event), {}, () => current)
  current = { type: 'control-endpoint-state', state: 'available', evidence: { source: 'agentmux', observedAt: 2 } }
  await Promise.resolve()
  expect(first).not.toHaveBeenCalled()
  expect(events).toEqual([current])
  publisher.onEvent(disposed, {}, () => current); publisher.dispose()
  await Promise.resolve()
  expect(disposed).not.toHaveBeenCalled()
})

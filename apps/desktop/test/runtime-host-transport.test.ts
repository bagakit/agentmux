import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, type AgentMuxClientEvent } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import type { AppConfig, HostConfig, HostTransportSnapshot, RuntimeEvent } from '../src/shared/contracts'
import type { DesktopRuntimeClient } from '../src/main/desktop-host'

const controllers: RuntimeController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose() })
const observation = (transport: 'ssh' | 'tailcat'): HostTransportSnapshot => ({ state: 'connected', transport, fallback: transport === 'tailcat', establishedAt: 1793773800000, observedAt: 1793773800010 })
function originalClient(initial: HostTransportSnapshot | null) {
  let current = initial, receive: (event: AgentMuxClientEvent) => void = () => {}
  return { client: { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    connectRuntime: vi.fn(async () => {}), agentSessions: () => [], providers: { get: () => { throw new Error('No Provider requested') } },
    onEvent: (listener: typeof receive) => { receive = listener; return () => { receive = () => {} } },
    remoteTransportObservation: vi.fn(() => current), runtimeProjection: vi.fn(async () => ({ hostId: 'fixture', subjects: [] })),
    runtimeIdentity: vi.fn(() => ({ ownership: 'verified' })) } as unknown as DesktopRuntimeClient,
    update(value: HostTransportSnapshot | null) { current = value }, emit(event: AgentMuxClientEvent) { receive(event) } }
}
function configured(hosts: Array<{ config: HostConfig; source: ReturnType<typeof originalClient> }>) {
  const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw new Error('A passive read must not create a client') }); controllers.push(controller)
  const config: AppConfig = { version: 9, hosts: hosts.map(item => item.config), workspaces: [], executors: {}, appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  controller.commit({ hosts: hosts.map(({ config, source }) => ({ id: config.id, config, client: source.client, executionHost: { id: config.id, kind: 'ssh', label: config.label, dispose: async () => {} } as never })), configs: config.hosts,
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  return { controller, config }
}

it('snapshot reads the original exact clients even when the semantic Runtime owner has not been confirmed', async () => {
  const first = originalClient(observation('ssh')), second = originalClient(observation('tailcat'))
  const { controller, config } = configured([
    { config: { id: 'first', kind: 'ssh', label: 'Same name', hostname: 'first.invalid', transport: 'tailcat' }, source: first },
    { config: { id: 'second', kind: 'ssh', label: 'Same name', hostname: 'second.invalid' }, source: second } ])
  const snapshot = await controller.snapshot(config)
  expect(snapshot.hostTransports).toEqual({ first: observation('ssh'), second: observation('tailcat') })
  expect(snapshot.runtimeEndpointWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 'first' }), expect.objectContaining({ hostId: 'second' })]))
  expect(first.client.runtimeProjection).not.toHaveBeenCalled(); expect(second.client.runtimeProjection).not.toHaveBeenCalled()
})

it('existing connection events carry the exact current channel cut, while unrelated events never read transport metadata', async () => {
  const source = originalClient(observation('tailcat'))
  const { controller, config } = configured([{ config: { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'remote.invalid' }, source }])
  const sent: RuntimeEvent[] = []
  const sender = Object.assign(new EventEmitter(), { id: 777, isDestroyed: () => false, send: (_channel: string, event: RuntimeEvent) => sent.push(event) })
  const detach = controller.attach(sender as never)
  source.emit({ type: 'terminal-output', run: { runId: 'original-run' }, data: 'continued output', startByte: 0, endByte: 16 } as AgentMuxClientEvent)
  expect(source.client.remoteTransportObservation).not.toHaveBeenCalled()
  expect(sent[0]).not.toHaveProperty('hostTransport')
  source.update({ ...observation('tailcat'), state: 'disconnected' })
  source.emit({ type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 1793773800020 } })
  expect(sent.at(-1)).toMatchObject({ hostId: 'remote', hostTransport: { state: 'disconnected', transport: 'tailcat' }, hostTransportSequence: 1 })
  expect(source.client.remoteTransportObservation).toHaveBeenCalledTimes(1)
  expect(source.client.dispose).not.toHaveBeenCalled()
  const snapshot = await controller.snapshot(config)
  expect(snapshot.hostTransportCut).toBe(sent.at(-1)!.hostTransportSequence)
  expect(snapshot.hostTransports?.remote).toEqual(sent.at(-1)!.hostTransport)
  detach()
})

it('failure of optional metadata remains unknown without rejecting the original Runtime snapshot or disposing its client', async () => {
  const source = originalClient(null)
  vi.mocked(source.client.remoteTransportObservation).mockImplementation(() => { throw new Error('private diagnostic') })
  const { controller, config } = configured([{ config: { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'remote.invalid' }, source }])
  expect((await controller.snapshot(config)).hostTransports).toEqual({ remote: null })
  expect(source.client.dispose).not.toHaveBeenCalled()
})


it('a snapshot delayed on an old client reads channel metadata from the current adopted client', async () => {
  const old = originalClient(observation('ssh')), replacement = originalClient(observation('tailcat'))
  Object.assign(old.client, { runtimeOwnerIdentity: () => ({ availability: 'connected', runtimeId: 'original-runtime' }) })
  let release!: () => void
  vi.mocked(old.client.runtimeProjection).mockImplementation(() => new Promise(resolve => { release = () => resolve({ hostId: 'remote', subjects: [] } as never) }))
  const host: HostConfig = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'remote.invalid' }
  const { controller, config } = configured([{ config: host, source: old }])
  const reading = controller.snapshot(config)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  controller.commit({ hosts: [{ id: host.id, config: host, client: replacement.client, executionHost: { dispose: async () => {} } as never }], configs: [host], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  release()
  expect((await reading).hostTransports).toEqual({ remote: observation('tailcat') })
  expect(old.client.remoteTransportObservation).not.toHaveBeenCalled()
})

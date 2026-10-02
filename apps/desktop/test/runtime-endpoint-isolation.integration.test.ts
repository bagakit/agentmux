const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { privateRuntimeConnector, runtimeOwnerIdentity } from './helpers/private-runtime-connector.js'
import { ConfigStore } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { configWithRuntimeBindings, saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'
import type { AppConfig, RuntimeEvent, SshHostConfig } from '../src/shared/contracts.js'

const controlled = vi.hoisted(() => ({ paths: new Map<string, string>(), home: _hygiene_fixturePath("tmp/agentmux-test-unused") }))
// This is a real Runtime client and protocol. Only the transport selector substitutes a private
// Unix endpoint for SSH; these tests qualify Main isolation, not SSH/Farm connectivity.

vi.mock('electron', () => ({ app: { getPath: () => controlled.home } }))

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
const controllers: RuntimeController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  for (const scope of scopes.splice(0)) await scope.cleanup()
  controlled.paths.clear(); vi.unstubAllEnvs()
})
async function setup() {
  const local = await headlessFixture(); scopes.push(local)
  const remote = await headlessFixture(); scopes.push(remote)
  for (const [key, value] of Object.entries(local.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, value!)
  controlled.home = local.root
  controlled.paths.set('reachable.fixture', remote.socketPath)
  controlled.paths.set('unreachable.fixture', join(local.root, 'missing.sock'))
  const controller = new RuntimeController(new AgentMuxFileAgentSessionStore(join(local.root, 'main-sessions.json')),
    privateRuntimeConnector(local.socketPath, hostname => controlled.paths.get(hostname)!))
  controllers.push(controller)
  const store = new ConfigStore(join(local.root, 'desktop-config.json'))
  const config = await store.get()
  return { local, remote, controller, store, config }
}
function ssh(hostname = 'reachable.fixture'): SshHostConfig {
  return { id: 'build-host', kind: 'ssh', label: 'Build host', hostname }
}

describe('Main uses original Core owners with per-endpoint failure isolation', () => {
  it('returns a real healthy local Run and new input while a remote handshake is unverified', async () => {
    const { local, controller, config } = await setup()
    const next: AppConfig = { ...config, hosts: [config.hosts[0]!, ssh('unreachable.fixture')] }
    controller.commit(await controller.prepare(next))
    const created = await controller.launchTerminal({ hostId: 'local', workspacePath: local.root,
      shellCommand: `exec '${process.execPath}' -e 'process.stdin.on("data",b=>process.stdout.write(b))'` }, next)
    const [reading] = await Promise.allSettled([controller.snapshot(next)])
    expect(reading!.status).toBe('fulfilled')
    if (reading!.status === 'rejected') throw reading!.reason
    const snapshot = reading!.value
    expect(snapshot.sessions.map(session => [session.id, session.hostId])).toEqual([[created.id, 'local']])
    expect(snapshot.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'build-host', step: 'Connecting to Runtime' })])
    const events: RuntimeEvent[] = []
    const contents = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false,
      send: (_channel: string, event: RuntimeEvent) => events.push(event) }) as unknown as WebContents
    const detach = controller.attach(contents)
    const attached = await controller.attachSession(contents.id, created.control, 0, next)
    await controller.write(created.control, 'local-still-live\n', 'user')
    await until(() => events, values => values.some(value => value.type === 'core' && value.hostId === 'local' &&
      value.event.type === 'terminal-output' && value.event.data.includes('local-still-live')), 'actual local Run output')
    expect((await controller.resolveSession(created.id, next))?.hostId).toBe('local')
    await expect(controller.resolveSession('unknown-session', next)).rejects.toBeTruthy()
    await controller.detachSession(contents.id, attached.attachmentId); detach()
    await controller.stopSession(created.control)
  }, 90_000)

  it('saves the trusted semantic binding through the existing Config owner and keeps it across owner restart and relabel', async () => {
    const { remote, controller, store, config } = await setup()
    let current = config
    const owner = new ConfigOwner({ read: () => current,
      save: next => saveRuntimeConfig({ runtime: controller, configWriter: store, next }), publish: saved => { current = saved } })
    await owner.update(value => ({ ...value, hosts: [value.hosts[0]!, ssh()] }))
    await until(() => runtimeOwnerIdentity(controller.rpcClients().find(entry => entry.hostId === 'build-host')?.client),
      identity => identity?.availability === 'connected', 'trusted background connection')
    await owner.update(value => ({ ...value, hosts: value.hosts.map(host => host.id === 'build-host'
      ? { ...host, label: 'Connected build host' } : host) }))
    const bound = current.hosts.find(host => host.id === 'build-host')!
    expect(bound).toMatchObject({ runtimeId: remote.owner.runtimeId })
    expect(JSON.parse(await readFile(join(scopes[0]!.root, 'desktop-config.json'), 'utf8')).hosts)
      .toContainEqual(expect.objectContaining({ id: 'build-host', runtimeId: remote.owner.runtimeId }))
    const instance = controller.rpcClients().find(entry => entry.hostId === 'build-host')!.client
    await owner.update(value => ({ ...value, hosts: value.hosts.map(host => host.id === 'build-host' ? { ...host, label: 'Renamed endpoint' } : host) }))
    expect(controller.rpcClients().find(entry => entry.hostId === 'build-host')!.client).toBe(instance)
    controller.reportBindingSaveFailure({ runtimeBindings: new Map([['build-host', remote.owner.runtimeId]]) }, new Error('Disk binding save failed'))
    const degraded = await controller.snapshot(current)
    expect(degraded.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'build-host',
      step: 'Saving Runtime binding', availability: 'connected' })])
    expect(runtimeOwnerIdentity(instance)?.availability).toBe('connected')
    await owner.update(value => ({ ...value, hosts: value.hosts.map(host => host.id === 'build-host' ? { ...host, label: 'Retried binding' } : host) }))
    await owner.update(value => ({ ...value, hosts: value.hosts.map(host => host.id === 'build-host' ? { ...host, label: 'Renamed endpoint' } : host) }))
    expect(controller.endpointWarningSnapshot()).toEqual([])
    const oldOwner = remote.owner.ownerInstanceId
    await remote.restart()
    const fresh = await until(() => controller.snapshot(current), value => !value.runtimeEndpointWarnings?.length, 'fresh owner generation')
    expect(fresh.runtimeEndpointWarnings).toEqual([])
    expect(runtimeOwnerIdentity(instance)).toMatchObject({ runtimeId: remote.owner.runtimeId, availability: 'connected' })
    expect(remote.owner.ownerInstanceId).not.toBe(oldOwner)
    expect(current.hosts.find(host => host.id === 'build-host')).toEqual({ ...bound, label: 'Renamed endpoint' })
    const [rebound] = await Promise.allSettled([owner.update(value => ({ ...value, hosts: value.hosts.map(host => host.id === 'build-host'
      ? { ...host, runtimeId: 'another-owner' } : host) }))])
    expect(rebound!.status).toBe('rejected')
    if (rebound!.status === 'fulfilled') throw new Error('Foreign semantic binding was accepted')
    expect(rebound!.reason).toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(current.hosts.find(host => host.id === 'build-host')).toEqual({ ...bound, label: 'Renamed endpoint' })
  }, 90_000)

  it('projects route aliases without changing remote Session facts and rejects a foreign semantic owner', async () => {
    const { remote, controller, config } = await setup()
    const client = await remote.client()
    const run = await client.createTerminal({ workspacePath: remote.root, command: process.execPath,
      args: ['-e', 'process.stdin.resume()'], cols: 80, rows: 24 })
    const next: AppConfig = { ...config, hosts: [config.hosts[0]!, { ...ssh(), runtimeId: remote.owner.runtimeId }] }
    controller.commit(await controller.prepare(next))
    const snapshot = await until(() => controller.snapshot(next), value => value.runtimeEndpointWarnings?.length === 0, 'actual remote route projection')
    expect(snapshot.sessions.map(session => session.hostId)).toEqual(['build-host'])
    expect(snapshot.sessions[0]?.control.hostId).toBe('build-host')
    expect((await client.runtimeProjection()).hostId).toBe('local')
    expect((await controller.resolveSession(run.runId, next))?.hostId).toBe('build-host')
    expect(configWithRuntimeBindings(next, { runtimeBindings: new Map([['build-host', remote.owner.runtimeId]]) })).toBe(next)
    await client.stopTerminal({ runId: run.runId })

    const foreign = new RuntimeController(new AgentMuxFileAgentSessionStore(join(scopes[0]!.root, 'foreign-main.json')),
      privateRuntimeConnector(scopes[0]!.socketPath, hostname => controlled.paths.get(hostname)!))
    controllers.push(foreign)
    const pinned: AppConfig = { ...config, hosts: [config.hosts[0]!, { ...ssh(), runtimeId: 'original-unavailable-owner' }] }
    foreign.commit(await foreign.prepare(pinned))
    const unverified = await until(() => foreign.snapshot(pinned), value => value.runtimeEndpointWarnings?.[0]?.code === 'RUNTIME_OWNER_MISMATCH', 'foreign identity warning')
    expect(unverified.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'build-host', code: 'RUNTIME_OWNER_MISMATCH' })])
    expect(foreign.runtimeBindings()).toEqual(new Map())
    expect(pinned.hosts[1]).toMatchObject({ runtimeId: 'original-unavailable-owner' })
    await expect(foreign.resolveSession('old-session', pinned)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  }, 90_000)
})

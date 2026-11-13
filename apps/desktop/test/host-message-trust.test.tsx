// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxCreationAuthority, connectAgentMuxRpc } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { HostMessageTrustPanel } from '../src/renderer/src/components/settings/HostMessageTrustPanel'
import { approveHostMessageTrust, readHostMessageTrust } from '../src/main/settings-host-message-trust'
import { api } from '../src/renderer/src/lib/api'
import type { HostMessageTrustSnapshot, SshHostConfig } from '../src/shared/contracts'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
const host: SshHostConfig = { id: 'remote', kind: 'ssh', label: 'Build server', hostname: 'remote.invalid', runtimeId: 'remote-runtime' }
const snapshot: HostMessageTrustSnapshot = {
  local: { routeHostId: 'local', authority: { runtimeId: 'local-runtime', publicKey: 'local-key', fingerprint: 'a'.repeat(64) }, sources: [] },
  remote: { routeHostId: host.id, authority: { runtimeId: host.runtimeId!, publicKey: 'remote-key', fingerprint: 'b'.repeat(64) }, sources: [] }
}
let read: ReturnType<typeof vi.spyOn>, approve: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  read = vi.spyOn(api.hosts, 'messageTrust').mockResolvedValue(snapshot)
  approve = vi.spyOn(api.hosts, 'trustMessageSource').mockImplementation(async (_host, expected, direction) => {
    const source = direction === 'outbound' ? expected.local.authority : expected.remote.authority
    const side = direction === 'outbound' ? 'remote' : 'local', target = expected[side]
    return { ...expected, [side]: { ...target, sources: [{ purpose: 'agent-message', sourceRuntimeId: source.runtimeId,
      publicKey: source.publicKey, fingerprint: source.fingerprint, targetRuntimeId: target.authority.runtimeId,
      registeredAt: 1, registeredBy: { kind: 'user', id: 'actual-user' } }] } }
  })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const render = (draft = host, saved: SshHostConfig | undefined = host, active = true) => dom.render(<HostMessageTrustPanel host={draft} committed={saved} active={active} />)
const direction = (index: number) => dom.container.querySelectorAll<HTMLElement>('.host-message-trust__direction')[index]!
async function allow(index: number) {
  await act(async () => direction(index).querySelector<HTMLInputElement>('input')!.click())
  await act(async () => direction(index).querySelector<HTMLButtonElement>('button')!.click())
}

it('requires separate explicit approval for each direction and shows both original fingerprints', async () => {
  await render()
  expect(read).toHaveBeenCalledExactlyOnceWith(host)
  expect(approve).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain(snapshot.local.authority.fingerprint)
  expect(dom.container.textContent).toContain(snapshot.remote.authority.fingerprint)
  expect(direction(0).querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  await allow(0)
  expect(approve).toHaveBeenCalledExactlyOnceWith(host, snapshot, 'outbound')
  expect(direction(0).textContent).toContain('Messages from this source are trusted')
  expect(direction(1).textContent).toContain('approval required')
  await allow(1)
  expect(approve.mock.calls.map(call => call[2])).toEqual(['outbound', 'inbound'])
  expect(direction(1).textContent).toContain('Messages from this source are trusted')
})
it('does not read hidden or unsaved connections or reuse a verified replacement route', async () => {
  await render(host, host, false); expect(read).not.toHaveBeenCalled()
  await render({ ...host, hostname: 'draft.invalid' }); expect(read).not.toHaveBeenCalled()
  await render(); await act(async () => direction(0).querySelector<HTMLInputElement>('input')!.click())
  await render({ ...host, hostname: 'replacement.invalid' }, { ...host, hostname: 'replacement.invalid' })
  expect(direction(0).querySelector<HTMLInputElement>('input')!.checked).toBe(false)
  expect(approve).not.toHaveBeenCalled()
})
it('retains a conflicting purpose pin and offers no replacement approval', async () => {
  read.mockResolvedValue({ ...snapshot, remote: { ...snapshot.remote, sources: [{ purpose: 'agent-message',
    sourceRuntimeId: snapshot.local.authority.runtimeId, publicKey: 'other-key', fingerprint: 'c'.repeat(64),
    targetRuntimeId: host.runtimeId!, registeredAt: 1, registeredBy: { kind: 'user', id: 'original-user' } }] } })
  await render()
  expect(direction(0).textContent).toContain('original trust is retained')
  expect(direction(0).querySelector('input')).toBeNull()
  expect(approve).not.toHaveBeenCalled()
})
it('keeps unknown approval through hiding and read failure; only a successful read reconciles it', async () => {
  approve.mockRejectedValueOnce(new Error('Reply lost'))
  await render(); await allow(0)
  expect(dom.container.textContent).toContain('Approval result unconfirmed')
  await render(host, host, false); await render()
  expect(approve).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1)
  read.mockRejectedValueOnce(new Error('Read unavailable'))
  await dom.click('.host-message-trust > .host-creation-trust__actions button')
  expect(dom.container.textContent).toContain('Reply lost')
  expect(dom.container.textContent).toContain('Read unavailable')
  expect(direction(0).querySelector('input')).toBeNull()
  read.mockResolvedValue(snapshot)
  await dom.click('.host-message-trust > .host-creation-trust__actions button')
  expect(dom.container.querySelector('[role=alert]')).toBeNull()
  expect(direction(0).querySelector<HTMLInputElement>('input')!.checked).toBe(false)
  expect(approve).toHaveBeenCalledTimes(1)
})
it('carries real user approval through Unix RPC to each original durable purpose pin owner', async () => {
  const a = await rpcOwnerFixture(), b = await rpcOwnerFixture(); cleanup.push(a.close, b.close)
  const authorityA = new AgentMuxCreationAuthority({ stateDirectory: join(a.root, 'message-source'), runtimeId: 'local-runtime' })
  const authorityB = new AgentMuxCreationAuthority({ stateDirectory: join(b.root, 'message-target'), runtimeId: host.runtimeId! })
  Object.assign(a.client, { creationAuthority: authorityA }); Object.assign(b.client, { creationAuthority: authorityB })
  vi.spyOn(a.client, 'connect').mockResolvedValue(); vi.spyOn(b.client, 'connect').mockResolvedValue()
  const server = new AgentMuxControlServer({ socketPath: join(a.root, 'trust.sock'), coreClients: () => [
    { hostId: 'local', client: a.client }, { hostId: host.id, client: b.client }
  ] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  let saved = host
  const ports = { savedHost: (id: string) => id === host.id ? saved : undefined, call: rpc.call.bind(rpc) }
  const original = await readHostMessageTrust(host, ports)
  const changed = { ...original, remote: { ...original.remote, authority: { ...original.remote.authority, fingerprint: 'f'.repeat(64) } } }
  await expect(approveHostMessageTrust(host, changed, 'outbound', ports)).rejects.toThrow('identity changed')
  expect(await b.client.listTrustedMessageSources()).toEqual([])
  let reading!: Promise<HostMessageTrustSnapshot>, approving!: Promise<HostMessageTrustSnapshot>
  read.mockImplementation(input => reading = readHostMessageTrust(input, ports))
  approve.mockImplementation((input, expected, direction) => approving = approveHostMessageTrust(input, expected, direction, ports))
  await render(); await act(async () => { await reading })
  await act(async () => direction(0).querySelector<HTMLInputElement>('input')!.click())
  await act(async () => { direction(0).querySelector<HTMLButtonElement>('button')!.click(); await approving })
  const outbound = await approving
  expect(outbound.remote.sources[0]).toMatchObject({ purpose: 'agent-message', sourceRuntimeId: 'local-runtime', targetRuntimeId: host.runtimeId, registeredBy: { kind: 'user' } })
  expect(await a.client.listTrustedMessageSources()).toEqual([])
  await act(async () => direction(1).querySelector<HTMLInputElement>('input')!.click())
  await act(async () => { direction(1).querySelector<HTMLButtonElement>('button')!.click(); await approving })
  expect((await a.client.listTrustedMessageSources())[0]).toMatchObject({ sourceRuntimeId: host.runtimeId, targetRuntimeId: 'local-runtime' })
  expect(await a.client.listTrustedCreationSources()).toEqual([]); expect(await b.client.listTrustedCreationSources()).toEqual([])
  saved = { ...host, hostname: 'rebound.invalid' }
  await expect(approveHostMessageTrust(host, original, 'outbound', ports)).rejects.toThrow('Save this exact connection')
})

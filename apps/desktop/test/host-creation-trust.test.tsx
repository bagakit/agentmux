// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { HostCreationTrustPanel } from '../src/renderer/src/components/settings/HostCreationTrustPanel'
import { api } from '../src/renderer/src/lib/api'
import type { HostCreationTrustSnapshot, SshHostConfig } from '../src/shared/contracts'
import { approveHostCreationTrust, readHostCreationTrust } from '../src/main/settings-host-creation-trust'
import { AgentMuxControlServer, AgentMuxCreationAuthority, connectAgentMuxRpc } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanups: Array<() => unknown | Promise<unknown>> = []
const host: SshHostConfig = { id: 'remote', kind: 'ssh', label: 'Build server', hostname: 'remote.invalid', runtimeId: 'target-runtime' }
const snapshot: HostCreationTrustSnapshot = {
  source: { runtimeId: 'source-runtime', publicKey: 'source-key', fingerprint: 'a'.repeat(64) },
  target: { routeHostId: host.id, authority: { runtimeId: 'target-runtime', publicKey: 'target-key', fingerprint: 'b'.repeat(64) }, sources: [] }
}
let read: ReturnType<typeof vi.spyOn>, approve: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  read = vi.spyOn(api.hosts, 'creationTrust').mockResolvedValue(snapshot)
  approve = vi.spyOn(api.hosts, 'trustCreationSource').mockResolvedValue({ ...snapshot, target: { ...snapshot.target, sources: [{
    sourceRuntimeId: snapshot.source.runtimeId, publicKey: snapshot.source.publicKey, fingerprint: snapshot.source.fingerprint,
    targetRuntimeId: snapshot.target.authority.runtimeId, registeredAt: 1, registeredBy: { kind: 'user', id: 'transport-user' }
  }] } })
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const render = (draft = host, committed: SshHostConfig | undefined = host, active = true) =>
  dom.render(<HostCreationTrustPanel host={draft} committed={committed} active={active} />)

it('reads source and target fingerprints, and approves only after explicit verification and click', async () => {
  await render()
  expect(read).toHaveBeenCalledExactlyOnceWith(host)
  expect(approve).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain(snapshot.source.fingerprint)
  expect(dom.container.textContent).toContain(snapshot.target.authority.fingerprint)
  expect(dom.container.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true)
  await dom.click('input[type=checkbox]'); await dom.click('.primary-button')
  expect(approve).toHaveBeenCalledExactlyOnceWith(host, snapshot)
  expect(dom.container.textContent).toContain('This source is trusted on Build server')
  expect(dom.container.querySelector('.primary-button')).toBeNull()
})
it('does not observe hidden or unsaved connections and does not borrow a previous identity', async () => {
  await render(host, host, false)
  expect(read).not.toHaveBeenCalled()
  await render({ ...host, hostname: 'edited.invalid' })
  expect(read).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Save this connection')
  expect(dom.container.textContent).not.toContain(snapshot.source.fingerprint)
  expect(approve).not.toHaveBeenCalled()
})
it('keeps a conflicting original key and never offers a replacement approval', async () => {
  read.mockResolvedValue({ ...snapshot, target: { ...snapshot.target, sources: [{ sourceRuntimeId: snapshot.source.runtimeId,
    publicKey: 'another-key', fingerprint: 'c'.repeat(64), targetRuntimeId: host.runtimeId!, registeredAt: 1,
    registeredBy: { kind: 'user', id: 'original-user' } }] } })
  await render()
  expect(dom.container.textContent).toContain('original key will be retained')
  expect(dom.container.querySelector('.primary-button')).toBeNull()
  expect(approve).not.toHaveBeenCalled()
})
it('discards late observations and verification when the same saved route is replaced', async () => {
  let resolve!: (value: HostCreationTrustSnapshot) => void
  read.mockReturnValueOnce(new Promise<HostCreationTrustSnapshot>(done => { resolve = done }))
  await render()
  const nextHost = { ...host, hostname: 'replacement.invalid' }
  const replacement = { ...snapshot, source: { ...snapshot.source, fingerprint: 'c'.repeat(64) } }
  read.mockResolvedValue(replacement)
  await render(nextHost, nextHost)
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => resolve(snapshot))
  expect(dom.container.textContent).toContain('c'.repeat(64))
  expect(dom.container.textContent).not.toContain('a'.repeat(64))
  expect(approve).not.toHaveBeenCalled()
})
it('reconciles a lost approval response by reading saved pins without replaying approval', async () => {
  approve.mockRejectedValue(new Error('Response lost'))
  await render(); await dom.click('input[type=checkbox]'); await dom.click('.primary-button')
  expect(dom.container.textContent).toContain('Approval result unconfirmed')
  expect(dom.container.querySelector('.primary-button')).toBeNull()
  await dom.click('.small-button')
  expect(read).toHaveBeenCalledTimes(2)
  expect(approve).toHaveBeenCalledTimes(1)
})
it('retains the last trust facts after a read fails and requires a fresh review before approval', async () => {
  await render(); await dom.click('input[type=checkbox]')
  read.mockRejectedValue(new Error('Target unavailable'))
  await dom.click('.small-button')
  expect(dom.container.textContent).toContain(snapshot.target.authority.fingerprint)
  expect(dom.container.textContent).toContain('Target unavailable')
  expect(dom.container.querySelector('.primary-button')).toBeNull()
  expect(approve).not.toHaveBeenCalled()
})

it('uses the production UI orchestration through real Unix user transport and the target durable pin owner', async () => {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  const source = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'source'), runtimeId: 'source-runtime' })
  const target = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'target'), runtimeId: 'target-runtime' })
  Object.assign(f.client, { creationAuthority: target })
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const local = { connect: async () => {}, agentCreationAuthority: () => source.identity(), listTrustedCreationSources: () => source.listTrusted() }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'trust.sock'), coreClients: () => [
    { hostId: 'local', client: local as never }, { hostId: host.id, client: f.client }
  ] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  let saved = host
  const ports = { savedHost: (id: string) => id === host.id ? saved : undefined, call: rpc.call.bind(rpc) }
  let reading!: Promise<HostCreationTrustSnapshot>, approving!: Promise<HostCreationTrustSnapshot>
  read.mockImplementation(input => reading = readHostCreationTrust(input, ports))
  approve.mockImplementation((input, expected) => approving = approveHostCreationTrust(input, expected, ports))
  await render()
  await act(async () => { await reading })
  const shown = await readHostCreationTrust(host, ports)
  expect(await target.listTrusted()).toEqual([])
  const changed = { ...shown, target: { ...shown.target, authority: { ...shown.target.authority, fingerprint: 'f'.repeat(64) } } }
  await expect(approveHostCreationTrust(host, changed, ports)).rejects.toThrow('identity changed')
  expect(await target.listTrusted()).toEqual([])
  await dom.click('input[type=checkbox]')
  await act(async () => { dom.container.querySelector<HTMLButtonElement>('.primary-button')!.click(); await approving })
  expect((await target.listTrusted())[0]).toMatchObject({ sourceRuntimeId: shown.source.runtimeId, publicKey: shown.source.publicKey,
    targetRuntimeId: host.runtimeId, registeredBy: { kind: 'user' } })
  expect(dom.container.textContent).toContain('This source is trusted')
  saved = { ...host, hostname: 'rebound.invalid' }
  await expect(approveHostCreationTrust(host, shown, ports)).rejects.toThrow('Save this exact connection')
})

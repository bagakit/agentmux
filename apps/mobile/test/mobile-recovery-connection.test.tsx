import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectHostedAgentMux, type AgentMuxHostedClient } from '../../../packages/core/src/hosted-client'
import { hostedTransfer } from '../../../packages/core/src/hosted-value'
import type { AgentMuxHostedBootstrap, AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import type { MobileConnection } from '../src/conversation/use-hosted-conversation'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, mount, mounted } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

const ports = vi.hoisted(() => ({ connect: vi.fn(), observation: null as MobileConnection | null }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(32).fill(4) }) }))
vi.mock('../src/MobileApp', () => ({ MobileApp: ({ connection, connectionPanel }: { connection: MobileConnection; connectionPanel: ReactNode }) => {
  ports.observation = connection
  return <main data-connection={connection.state}><p>{connection.message}</p>{connection.issue && <p>{connection.issue}</p>}{connectionPanel}</main>
} }))

const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
const clients: AgentMuxHostedClient[] = []
function originalHostedConsumer() {
  const owner: AgentMuxHostedBootstrap['owner'] = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2, processId: 123, availability: 'connected', ctxmux: null }
  const bootstrap: AgentMuxHostedBootstrap = { owner, connection: null, storePath: null, hostProcessId: 123, catalog: [], sessions: [], messageQueuePath: fixturePath('mobile-recovery/messages.ndjson') }
  let denied = false, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2] | undefined
  const calls: string[] = []
  const rpc = {
    call: async (method: string) => {
      calls.push(method)
      if (denied) throw new AgentMuxError('Original device authorization requires confirmation.', 'AGENT_CAPABILITY_INVALID')
      if (method === 'runtime.owner.identity') return { owner }
      if (method === 'runtime.invoke') return { value: { hostId: 'local', subjects: [] } }
      throw Error('Unexpected original Hosted call: ' + method)
    },
    subscribe: async (method: string, _params: unknown, next: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      expect(method).toBe('runtime.events'); handlers = next
      next.onInitial({ owner, transferId: 'original-opening' })
      for (const data of hostedTransfer({ kind: 'initial', value: bootstrap }, 'original-opening')) next.onEvent({ type: 'snapshot', data })
      return { dispose: async () => {} }
    }
  } as AgentMuxHostedRpcPort
  return { calls,
    async connect() { const client = await connectHostedAgentMux({ rpc }); clients.push(client); return client },
    deny() { denied = true; handlers!.onEnd?.(new AgentMuxError('Private original channel ended.', 'CONTROL_UNAVAILABLE')) },
    nativeFailure() {
      for (const data of hostedTransfer({ kind: 'event', event: { type: 'connection-state', state: 'unrecoverable',
        observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, diagnostic: { code: 'CTXMUX_DISCONNECTED', message: 'Original Native observation unavailable.' }, evidence: { source: 'agentmux', observedAt: 1 } } }, 'native-observation')) handlers!.onEvent({ type: 'snapshot', data })
    }
  }
}
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/')
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['original-session', 'Original unsent draft']], attempts: [], responses: [] } })
  ports.observation = null; ports.connect.mockReset()
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  vi.restoreAllMocks()
})

describe('Mobile recovery usability connection', () => {
  it('uses the actual Hosted unrecoverable state without automatic retries or identity replacement', async () => {
    const f = originalHostedConsumer(); ports.connect.mockImplementation(() => f.connect())
    await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
    await vi.waitFor(() => expect(ports.observation?.state).toBe('connected'))
    const saved = getDeviceWorkface().snapshot().record, savedOffer = localStorage.getItem('agentmux.connection-offer.v2')
    await act(async () => { f.deny() })
    await act(async () => { await vi.waitFor(() => expect(ports.observation?.state).toBe('unavailable')) })
    expect(document.body.textContent).toContain('自动重连已暂停')
    expect(ports.observation?.issue).toContain('AGENT_CAPABILITY_INVALID')
    expect(ports.observation?.issue).toContain('Original device authorization')
    const requests = f.calls.length
    await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve() })
    expect(f.calls).toHaveLength(requests)
    expect(ports.connect).toHaveBeenCalledTimes(1)
    expect(getDeviceWorkface().snapshot().record).toEqual(saved)
    expect(localStorage.getItem('agentmux.connection-offer.v2')).toBe(savedOffer)
    expect(button(document.body, '重新检查原连接').disabled).toBe(false)
    const repaired = originalHostedConsumer(); ports.connect.mockImplementation(() => repaired.connect())
    await click(button(document.body, '重新检查原连接'))
    await vi.waitFor(() => expect(ports.observation?.state).toBe('connected'))
    expect(ports.connect).toHaveBeenCalledTimes(2)
    expect(getDeviceWorkface().snapshot().record).toEqual(saved)
    expect(localStorage.getItem('agentmux.connection-offer.v2')).toBe(savedOffer)
  })

  it('does not replace an unrecoverable observation with a late first workface save', async () => {
    const f = originalHostedConsumer(), saving = deferred<void>(), owner = getDeviceWorkface(), save = owner.confirmHost.bind(owner)
    ports.connect.mockImplementation(() => f.connect())
    vi.spyOn(owner, 'confirmHost').mockImplementation(async host => { await saving.promise; await save(host) })
    await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
    await vi.waitFor(() => expect(clients).toHaveLength(1))
    await act(async () => { f.deny() })
    await act(async () => { await vi.waitFor(() => expect(ports.observation?.state).toBe('unavailable')) })
    await act(async () => { saving.resolve(); await saving.promise })
    await vi.waitFor(() => expect(owner.snapshotIdentity().host?.hostId).toBe('original-host'))
    expect(ports.observation).toMatchObject({ state: 'unavailable', issue: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
  })

  it('keeps the original semantic connection available when Native observation needs attention', async () => {
    const f = originalHostedConsumer(); ports.connect.mockImplementation(() => f.connect())
    await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
    await vi.waitFor(() => expect(ports.observation?.state).toBe('connected'))
    await act(async () => { f.nativeFailure() })
    expect(ports.observation).toMatchObject({ state: 'connected' })
    expect(document.body.textContent).not.toContain('自动重连已暂停')
    expect(ports.connect).toHaveBeenCalledTimes(1)
  })
})

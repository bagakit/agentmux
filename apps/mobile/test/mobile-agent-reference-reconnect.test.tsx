import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { encodeHostedValue, hostedTransfer } from '../../../packages/core/src/hosted-value'
import type { AgentMuxHostedBootstrap, AgentMuxHostedRpcPort } from '@agentmux/core/hosted'
import type { AgentMuxClientEvent } from '@agentmux/core'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted, session } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

it('reconciles the original Hosted SDK bootstrap after its actual observation lease reconnects', async () => {
  const companion = fixture(), firstPeer = { ...session('old-peer'), providerId: 'old-provider' }, nextPeer = { ...session('new-peer'), providerId: 'new-provider' }
  const bootstrap: AgentMuxHostedBootstrap = { connection: null, owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2,
    processId: 123, availability: 'connected', ctxmux: { instanceId: 'original-daemon', ownership: 'owned', hostId: 'local', buildIdentity: 'fixture', protocolVersion: 1, processId: 123 } },
    storePath: fixturePath('private-store/sessions.json'), messageQueuePath: fixturePath('private-store/messages.ndjson'), hostProcessId: 123, catalog: [], sessions: [session(), firstPeer] }
  type Events = { onInitial(value: any): void; onEvent(value: any): void; onEnd(error?: unknown): void }
  const streams: Events[] = [], disposed = vi.fn(async () => {})
  const port = { call: async (method: string, params: any) => {
    if (method === 'runtime.owner.identity') return { owner: bootstrap.owner }
    if (method === 'runtime.release-consumer') return { released: true }
    if (method === 'runtime.invoke' && params.invocation.method === 'runtimeProjection') return { value: encodeHostedValue({ hostId: 'local', subjects: [] }) }
    throw new Error(`Unexpected RPC ${method}`)
  }, subscribe: async (method: string, _params: unknown, handlers: Events) => {
    if (method !== 'runtime.events') throw new Error(`Unexpected stream ${method}`)
    streams.push(handlers)
    const transferId = `original-lease-${streams.length}`
    handlers.onInitial({ owner: bootstrap.owner, transferId })
    for (const data of hostedTransfer({ kind: 'initial', value: structuredClone(bootstrap) }, transferId)) handlers.onEvent({ type: 'snapshot', data })
    return { dispose: disposed }
  } } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  // Keep the true Hosted event lease, bootstrap and metadata methods. Only unrelated
  // conversation reading ports use the controlled fixture, so no Provider is started.
  const preserved = new Set(['onEvent', 'agentSessions', 'agentSession', 'runtimeOwnerIdentity'])
  for (const [key, value] of Object.entries(companion.client)) if (!preserved.has(key)) Object.assign(client, { [key]: value })
  const events: AgentMuxClientEvent[] = [], stopEvents = client.onEvent(value => events.push(value))
  try {
    const view = await mount(<MobileConversationSurface client={client} agentSessionId="session-original" connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />)
    const input = (view.element.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    await act(async () => { input.commands.setContent('@'); input.commands.focus('end') })
    const choices = () => [...document.querySelectorAll('[role="option"]')].map(value => value.textContent ?? '')
    await vi.waitFor(() => expect(choices().some(value => value.includes('old-provider'))).toBe(true))
    bootstrap.sessions = [session(), nextPeer]
    await act(async () => streams[0]!.onEnd(new Error('original observation lost')))
    expect(choices().some(value => value.includes('old-provider'))).toBe(true)
    await vi.waitFor(async () => { await act(async () => {}); expect(streams).toHaveLength(2); expect(events.some(value => value.type === 'connection-state' && value.state === 'restored')).toBe(true); expect(choices().some(value => value.includes('new-provider'))).toBe(true); expect(choices().some(value => value.includes('old-provider'))).toBe(false) }, { timeout: 3000 })
    const stale: AgentMuxClientEvent = { type: 'agent-session', session: { ...session('late-peer'), providerId: 'late-old-provider' } }
    await act(async () => { for (const data of hostedTransfer({ kind: 'event', event: stale }, 'late-old-event')) streams[0]!.onEvent({ type: 'snapshot', data }) })
    expect(choices().some(value => value.includes('late-old-provider'))).toBe(false)
    expect(choices().some(value => value.includes('new-provider'))).toBe(true)
    expect(disposed).toHaveBeenCalled()
  } finally { stopEvents(); await client.dispose() }
}, 10000)

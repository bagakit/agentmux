import { expect, vi } from 'vitest'
import { rpcOwnerFixture } from '../helpers/public-rpc-owner.js'
import { withInteractionOperation } from './interaction-client.js'
import type { AgentHookServer } from '../../src/hook-server.js'
import type { AgentMuxStoredAgentSession, AgentNativeSessionHandle, AgentProviderSessionStatus } from '../../src/types.js'

export const originalNativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'native-original' } as const

/** Original authenticated HTTP/Store/Core owners; only Runtime and native observation ports are controlled. */
export async function nativeTurnEndFixture() {
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ nativeHandle: originalNativeHandle }))
  const provider = h.client.providers.get('codex')
  let witness: Extract<AgentNativeSessionHandle, { kind: 'provider' }> = originalNativeHandle
  provider.discoverNativeSession = async () => ({ handle: witness, assertCurrent: async () => {} })
  const observers: Array<(status: AgentProviderSessionStatus) => void> = []
  provider.observeSessionStatus = async context => { observers.push(context.onStatus); return { dispose() {} } }
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 123 }))
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  await server.start()
  const binding = server.createBinding('recipient', 'codex'); await binding.bindRun('run-recipient')
  const read = (id: string) => {
    const pending = h.client.agentSession('recipient').pendingInteraction
    return [pending?.request, ...(pending?.additionalRequests ?? [])].find(request => request?.id === id)
  }
  const open = async (id: string, nativeTurnId = 'turn-original') => {
    const pending = fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
      body: JSON.stringify({ receiptId: id, eventName: 'PermissionRequest', decision: true,
        payload: { hook_event_name: 'PermissionRequest', session_id: witness.sessionId, turn_id: nativeTurnId,
          tool_name: 'Bash', tool_input: { command: 'private fixture command' } } }) })
    await expect.poll(() => read(id)?.kind === 'permission' && read(id)?.evidence.hookReceiptId === id).toBe(true)
    const bindings = Reflect.get(server, 'bindings') as Map<string, { tail: Promise<void> }>
    await bindings.get(binding.endpoint.token)!.tail
    return { pending }
  }
  const input = (id: string) => withInteractionOperation(h.client, { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
    response: { kind: 'permission', requestId: id, decision: { outcome: 'selected', optionId: 'allow-once' } } })
  const settle = async () => {
    const watches = Reflect.get(h.client, 'nativeStatusWatches') as Map<string, { pending: Promise<void> }>
    await watches.get('recipient')?.pending
  }
  const observe = async (status: AgentProviderSessionStatus, observer = observers.at(-1)) => {
    if (!observer) throw new Error('The original Provider status port is not attached.')
    observer(status); await settle()
  }
  const change = async (update: (session: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => {
    const current = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(current, update(current)); await h.inner.registry.load('local')
  }
  await h.client.statusAgent('recipient')
  return { ...h, provider, server, binding, observers, read, open, input, observe, settle, change,
    witness: (handle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>) => { witness = handle } }
}

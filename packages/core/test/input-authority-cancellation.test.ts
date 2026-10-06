import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import type { AgentInputSubmissionReceipt, AgentMuxAgentPromptInput } from '../src/index.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
function barrier() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { pending, resolve, reject }
}

async function eventually<T>(read: () => T | Promise<T>, expected: T): Promise<void> {
  try { await expect.poll(read).toBe(expected) }
  catch {
    // Report the business state itself, not just the polling deadline. A read
    // failure still throws its actual error; no setup/timeout counts as proof.
    expect(await read(), 'The original input owner must reach this business state.').toBe(expected)
  }
}

// Production Core/Store/journal/coordinator/public service. Only Runtime and
// Provider machine ports are controlled; this does not prove vendor admission.
async function fixture() {
  const h = await rpcOwnerFixture()
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-thread' },
    nativeBinding: { source: 'process-witness', run: original.run, observedAt: 1 } })
  await h.inner.registry.load('local')
  const provider = (Reflect.get(h.client, 'providers') as AgentProviderRegistry).get('codex')
  const dispatch = vi.fn(async (_body: string, operationId: string) => ({ outcome: 'admitted' as const, turnId: operationId }))
  vi.spyOn(provider, 'prepareNativePromptInput').mockResolvedValue({
    plan: { kind: 'native-rpc', operation: 'start-or-steer', protocolId: 'controlled-contract',
      sourceId: 'original-source', actorId: 'original-actor', threadId: 'original-thread' },
    assertCurrent: async signal => signal.throwIfAborted(), dispatch, close: async () => {} })
  const input = (id: string): AgentMuxAgentPromptInput => ({ agentSessionId: 'recipient', expectedRun: original.run,
    operationId: id, prompt: 'Original body ' + id, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  const read = async (id: string) => (await h.client.inspectAgentInput({ key: {
    kind: 'prompt', agentSessionId: 'recipient', expectedRun: original.run, submissionId: id } }))!
  return { ...h, input, read, dispatch }
}

it.each(['resolve', 'reject'] as const)('Stop releases a held author read and its late %s cannot dispatch the old input', async late => {
  const h = await fixture(), entered = barrier(), held = barrier()
  try {
    const first = await h.client.submitAgentPrompt(h.input('A'), { assertCurrent: async () => { entered.resolve(); await held.pending } }) as AgentInputSubmissionReceipt
    await entered.pending
    expect(await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'stop-A' }))
      .toMatchObject({ outcome: 'stopped-before-dispatch' })
    const freshAuthor = vi.fn(async () => {})
    await h.client.submitAgentPrompt(h.input('B'), { assertCurrent: freshAuthor })
    await eventually(async () => (await h.read('B')).status, 'admitted')
    expect(freshAuthor).toHaveBeenCalled()
    expect(h.dispatch.mock.calls.map(call => call[1])).toEqual(['B'])
    if (late === 'resolve') held.resolve()
    else held.reject(new AgentMuxError('Late original authority read failed.', 'AUDIT_LATE_AUTHOR'))
    await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
    expect((await h.read('A')).status).toBe('stopped')
    expect(h.dispatch.mock.calls.map(call => call[1])).toEqual(['B'])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { held.resolve(); await h.close() }
})

it('SDK observation cancellation releases a held read without cancelling the next input or replaying the original', async () => {
  const h = await fixture(), entered = barrier(), held = barrier(), controller = new AbortController()
  try {
    await h.client.submitAgentPrompt({ ...h.input('A'), signal: controller.signal }, {
      assertCurrent: async () => { entered.resolve(); await held.pending } })
    await entered.pending; controller.abort(new Error('Original SDK reader stopped.'))
    await h.client.submitAgentPrompt(h.input('B'), { assertCurrent: async () => {} })
    await eventually(async () => (await h.read('B')).status, 'admitted')
    expect(await h.read('A')).toMatchObject({ status: 'waiting', control: { waiting: { phase: 'observer' } } })
    expect(h.dispatch.mock.calls.map(call => call[1])).toEqual(['B'])
  } finally { held.resolve(); await h.close() }
})

it('disposing Core abandons only its held pre-gate author observation', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  try {
    await h.client.submitAgentPrompt(h.input('A'), { assertCurrent: async () => { entered.resolve(); await held.pending } })
    await entered.pending
    let disposed = false
    const disposing = h.client.dispose().then(() => { disposed = true })
    await eventually(() => disposed, true)
    await disposing
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { held.resolve(); await h.close() }
})

it('the next input still needs its own current author after the stopped read releases', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  try {
    const first = await h.client.submitAgentPrompt(h.input('A'), { assertCurrent: async () => { entered.resolve(); await held.pending } }) as AgentInputSubmissionReceipt
    await entered.pending
    await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'stop-A' })
    const denied = vi.fn(async () => { throw new AgentMuxError('Current author revoked.', 'AGENT_CAPABILITY_INVALID') })
    await h.client.submitAgentPrompt(h.input('B'), { assertCurrent: denied })
    await eventually(async () => (await h.read('B')).control.waiting?.phase, 'authorization')
    expect(denied).toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
    expect((await h.read('B')).admission).toBeNull()
  } finally { held.resolve(); await h.close() }
})

it('Stop after the dispatch gate does not cancel the operation through its held final author read', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  let checks = 0
  try {
    const first = await h.client.submitAgentPrompt(h.input('A'), { assertCurrent: async () => {
      if (++checks === 3) { entered.resolve(); await held.pending }
    } }) as AgentInputSubmissionReceipt
    await entered.pending
    expect(await h.client.stopAgentInputWaiting({ ref: first.ref, cancelOperationId: 'stop-after-gate' }))
      .toMatchObject({ outcome: 'observation-stopped' })
    expect(h.dispatch).not.toHaveBeenCalled()
    held.resolve()
    await eventually(async () => (await h.read('A')).status, 'admitted')
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  } finally { held.resolve(); await h.close() }
})

it('the actual public input owner releases a stopped transport authority before the next send', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  const service = new AgentMuxRpcService({ coreClients: h.coreClients })
  const input = (id: string) => ({ target: { kind: 'agent-session' as const, agentSessionId: 'recipient' },
    operationId: id, messageId: 'message-' + id, execution: 'immediate' as const, text: 'Public body ' + id })
  try {
    const first = await service.call('agent.send', input('A'), { assertCurrent: async () => { entered.resolve(); await held.pending } })
    await entered.pending
    await service.call('agent.input.stop', { ref: first.inputReceipt!.ref, cancelOperationId: 'stop-public-A' },
      { principal: { kind: 'user', id: 'private-local-user' } })
    const second = await service.call('agent.send', input('B'), { assertCurrent: async () => {} })
    await eventually(async () => (await service.call('agent.input.inspect', { key: second.inputReceipt!.key })).input?.status, 'admitted')
    expect(h.dispatch.mock.calls.map(call => call[1])).toEqual(['message-B'])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { held.resolve(); await h.close() }
})

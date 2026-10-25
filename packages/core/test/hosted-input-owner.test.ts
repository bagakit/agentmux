import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxHostedRpcPort, AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

/** Production SDK → Hosted service → Core; only transport and Native bytes are deterministic ports. */
async function fixture() {
  const core = await rpcOwnerFixture(['input-agent'])
  cleanups.push(core.close)
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'original-input-runtime', ownerInstanceId: 'original-input-owner',
    protocolVersion: 2, processId: process.pid, ctxmux: core.client.runtimeIdentity(), availability: 'connected' }
  const service = new AgentMuxHostedRuntimeService(core.client, null, () => owner)
  cleanups.push(() => service.dispose())
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let subscriptionError: Error | undefined
  let replyError: AgentMuxError | undefined
  let identityError: AgentMuxError | undefined
  let holdFailure: ((error: unknown) => Promise<void>) | undefined
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      calls.push({ method, params: structuredClone(params) as Record<string, unknown> })
      if (method === 'runtime.owner.identity' && identityError) {
        const error = identityError; identityError = undefined; throw error
      }
      let result: unknown
      try { result = await service.call(method, structuredClone(params), options) }
      catch (error) { await holdFailure?.(error); throw error }
      if (method === 'runtime.invoke' && replyError) {
        const error = replyError; replyError = undefined; throw error
      }
      return structuredClone(result) as never
    },
    subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void }) => {
      if (subscriptionError) throw subscriptionError
      const subscription = await service.subscribe(method, structuredClone(params), event => handlers.onEvent(structuredClone(event)))
      handlers.onInitial(structuredClone(subscription.initial)); await subscription.start?.()
      return { dispose: () => subscription.dispose() }
    }
  }
  const client = await connectHostedAgentMux({ rpc: port })
  cleanups.push(() => client.dispose())
  const agent = { agentSessionId: 'input-agent', expectedRun: { runId: 'run-input-agent' } }
  const ordinary = { runId: 'ordinary-terminal' }
  const identities = () => calls.filter(call => call.method === 'runtime.owner.identity')
  const invocations = () => calls.filter(call => call.method === 'runtime.invoke')
  return { ...core, client, owner, agent, ordinary, calls, identities, invocations,
    failObservation: () => { subscriptionError = new Error('Original event observation unavailable') },
    failNextReply: (error: AgentMuxError) => { replyError = error },
    failNextIdentity: (error: AgentMuxError) => { identityError = error },
    holdFailure: (hold?: (error: unknown) => Promise<void>) => { holdFailure = hold } }
}

describe('Hosted live input owner fence', () => {
  it('discovers cold input once and sends sequential Agent typing, paste and Terminal bytes once each', async () => {
    const f = await fixture()
    f.client.disconnect(); f.calls.length = 0
    expect(await f.client.writeAgent({ ...f.agent, data: 'a', source: 'user' })).toMatchObject({
      runId: f.agent.expectedRun.runId, appliedByteRange: { startByte: 0, endByte: 1 } })
    expect(await f.client.writeAgent({ ...f.agent, data: 'b', source: 'user' })).toMatchObject({ appliedByteRange: { startByte: 1, endByte: 2 } })
    const paste = '\u001b[200~c\u001b[201~'
    const pasteEnd = 2 + Buffer.byteLength(paste)
    expect(await f.client.pasteAgent({ ...f.agent, text: 'c', terminalData: 'c' })).toMatchObject({ appliedByteRange: { startByte: 2, endByte: pasteEnd } })
    const bytes = Uint8Array.of(0, 255, 120)
    expect(await f.client.writeTerminalBytes(f.ordinary, bytes)).toEqual({ runId: f.ordinary.runId,
      appliedByteRange: { startByte: 0, endByte: 3 }, acceptedThroughByte: 3 })
    expect(await f.client.writeAgent({ ...f.agent, data: 'd', source: 'terminal-protocol' })).toMatchObject({ appliedByteRange: { startByte: pasteEnd, endByte: pasteEnd + 1 } })
    expect(f.identities(), 'one cold discovery, no per-key identity round trips').toHaveLength(1)
    expect(f.invocations()).toHaveLength(5)
    expect(f.rawInput.mock.calls).toEqual([
      [f.agent.expectedRun.runId, 'a'], [f.agent.expectedRun.runId, 'b'], [f.agent.expectedRun.runId, paste],
      [f.ordinary.runId, bytes], [f.agent.expectedRun.runId, 'd']
    ])
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })

  it('keeps healthy input available after its independent event observation fails', async () => {
    const f = await fixture()
    f.client.disconnect(); f.failObservation()
    await expect(f.client.connect()).rejects.toThrow('Original event observation unavailable')
    f.calls.length = 0
    await expect(f.client.writeAgent({ ...f.agent, data: 'available', source: 'user' })).resolves.toMatchObject({
      appliedByteRange: { startByte: 0, endByte: 9 } })
    expect(f.identities()).toHaveLength(0); expect(f.invocations()).toHaveLength(1)
    expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.agent.expectedRun.runId, 'available')
  })

  it('rejects a stale owner once and discovers only for a later independent input, retaining the Runtime identity', async () => {
    const f = await fixture()
    f.calls.length = 0; f.owner.ownerInstanceId = 'replacement-input-owner'
    await expect(f.client.writeTerminalBytes(f.ordinary, 'refused')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect(f.invocations()).toHaveLength(1); expect(f.identities()).toHaveLength(0)
    expect(f.rawInput).not.toHaveBeenCalled()
    expect(f.client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: 'original-input-runtime', availability: 'unverified' })
    f.owner.runtimeId = 'different-runtime-at-same-endpoint'
    await expect(f.client.writeTerminalBytes(f.ordinary, 'wrong-runtime')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(f.identities()[0]?.params).toEqual({ expectedRuntimeId: 'original-input-runtime' })
    expect(f.rawInput).not.toHaveBeenCalled()
    f.owner.runtimeId = 'original-input-runtime'
    await expect(f.client.writeTerminalBytes(f.ordinary, 'new-intent')).resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 10 } })
    expect(f.identities()).toHaveLength(2); expect(f.invocations()).toHaveLength(2)
    expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.ordinary.runId, 'new-intent')
  })

  it('does not revoke a newly observed owner when an older owner refusal arrives late', async () => {
    const f = await fixture()
    f.owner.ownerInstanceId = 'replacement-input-owner'
    let release!: () => void, held = false
    f.holdFailure(async error => {
      if (!(error instanceof AgentMuxError) || error.code !== 'RUNTIME_OWNER_CHANGED') return
      held = true; await new Promise<void>(resolve => { release = resolve })
    })
    const old = f.client.writeTerminalBytes(f.ordinary, 'old-refused')
    const rejection = expect(old).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    try {
      await vi.waitFor(() => expect(held).toBe(true))
      await f.client.connectRuntime()
      const identityCount = f.identities().length
      expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: f.owner.ownerInstanceId, availability: 'connected' })
      release(); await rejection
      await f.client.writeTerminalBytes(f.ordinary, 'later')
      expect(f.identities()).toHaveLength(identityCount)
      expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: f.owner.ownerInstanceId, availability: 'connected' })
      expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.ordinary.runId, 'later')
    } finally { release?.(); await rejection }
  })

  it('keeps an unknown original input effect without replay or speculative owner invalidation', async () => {
    const f = await fixture()
    f.calls.length = 0
    f.failNextReply(new AgentMuxError('Original reply unavailable after dispatch', 'CONTROL_TIMEOUT', 'unknown'))
    await expect(f.client.writeTerminalBytes(f.ordinary, 'original')).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT', detail: 'unknown' })
    expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.ordinary.runId, 'original')
    expect(f.invocations()).toHaveLength(1); expect(f.identities()).toHaveLength(0)
    await expect(f.client.writeTerminalBytes(f.ordinary, 'independent')).resolves.toMatchObject({ appliedByteRange: { startByte: 8, endByte: 19 } })
    expect(f.rawInput).toHaveBeenCalledTimes(2)
    expect(f.invocations()).toHaveLength(2); expect(f.identities()).toHaveLength(0)
  })

  it('retains a definite owner refusal across an intervening failed identity observation of that same owner', async () => {
    const f = await fixture()
    f.owner.ownerInstanceId = 'replacement-input-owner'
    let release!: () => void, held = false
    f.holdFailure(async error => {
      if (!(error instanceof AgentMuxError) || error.code !== 'RUNTIME_OWNER_CHANGED') return
      held = true; await new Promise<void>(resolve => { release = resolve })
    })
    const refused = expect(f.client.writeTerminalBytes(f.ordinary, 'refused')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    try {
      await vi.waitFor(() => expect(held).toBe(true))
      f.failNextIdentity(new AgentMuxError('Independent identity observation timed out', 'CONTROL_TIMEOUT'))
      await expect(f.client.connectRuntime()).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
      expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: 'original-input-owner', availability: 'unverified' })
      f.holdFailure(); release(); await refused
      const identityCount = f.identities().length
      await expect(f.client.writeTerminalBytes(f.ordinary, 'independent')).resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 11 } })
      expect(f.identities()).toHaveLength(identityCount + 1)
      expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.ordinary.runId, 'independent')
      expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: f.owner.ownerInstanceId, availability: 'connected' })
    } finally { f.holdFailure(); release?.(); await refused }
  })

  it('retains exact Agent Run refusal without invalidating an otherwise healthy owner', async () => {
    const f = await fixture()
    f.calls.length = 0
    await expect(f.client.writeAgent({ ...f.agent, expectedRun: { runId: 'wrong-original-run' }, data: 'refused', source: 'user' }))
      .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(f.rawInput).not.toHaveBeenCalled()
    await expect(f.client.writeAgent({ ...f.agent, data: 'exact', source: 'user' })).resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 5 } })
    expect(f.identities()).toHaveLength(0); expect(f.invocations()).toHaveLength(2)
    expect(f.rawInput).toHaveBeenCalledExactlyOnceWith(f.agent.expectedRun.runId, 'exact')
  })
})

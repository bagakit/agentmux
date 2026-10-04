import { fixturePath } from './helpers/fixture-values.js'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '../src/performance-diagnostics.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

it('reads through actual Hosted client/service without reconnect, forwards cancellation, and keeps disconnected diagnostics unknown', async () => {
  const facts = { processId: 101, observedAt: 1000, input: createInputPerformanceRecorder().snapshot(), carrier: hostedCarrierPerformance.snapshot() }
  const read = vi.fn(async (options?: { signal?: AbortSignal }) => { options?.signal?.throwIfAborted(); return facts })
  const core = { connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}), onEvent: () => () => {},
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'original-daemon', buildIdentity: 'synthetic', protocolVersion: 1, processId: 123, ownership: 'owned' as const }),
    catalog: () => [], agentSessions: () => [], agentMessageQueuePath: () => fixturePath("synthetic/messages.ndjson"), clientPerformanceDiagnostics: read }
  const service = new AgentMuxHostedRuntimeService(core as unknown as AgentMuxClient, fixturePath("synthetic/sessions.json"), () => hostedTestOwner(core as unknown as AgentMuxClient))
  let end!: () => void
  const subscribe = vi.fn(async (method, params, handlers) => {
    const owner = await service.subscribe(method, params, event => handlers.onEvent(event))
    handlers.onInitial(owner.initial); await owner.start?.()
    end = () => handlers.onEnd?.(new Error('diagnostic endpoint unavailable'))
    return { dispose: () => owner.dispose() }
  })
  const call = vi.fn(async (method, params, options) => JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), options))))
  const client = await connectHostedAgentMux({ rpc: { call, subscribe } as unknown as AgentMuxHostedRpcPort })
  try {
    core.connect.mockClear(); core.connectRuntime.mockClear()
    expect(await client.clientPerformanceDiagnostics()).toEqual(facts)
    expect(core.connect).not.toHaveBeenCalled(); expect(core.connectRuntime).not.toHaveBeenCalled()
    const controller = new AbortController()
    await client.clientPerformanceDiagnostics({ signal: controller.signal })
    expect(read.mock.calls.at(-1)?.[0]?.signal).toBe(controller.signal)
    expect(call.mock.calls.at(-1)?.[2]?.signal).toBe(controller.signal)
    controller.abort(new Error('cancelled readonly query'))
    await expect(client.clientPerformanceDiagnostics({ signal: controller.signal })).rejects.toThrow('cancelled readonly query')
    expect(read).toHaveBeenCalledTimes(2)
    const subscriptions = subscribe.mock.calls.length, calls = call.mock.calls.length
    end()
    await expect(client.clientPerformanceDiagnostics()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(subscribe).toHaveBeenCalledTimes(subscriptions); expect(call).toHaveBeenCalledTimes(calls)
    expect(core.connect).not.toHaveBeenCalled(); expect(core.connectRuntime).not.toHaveBeenCalled()
  } finally { await client.dispose() }
})

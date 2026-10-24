// @vitest-environment happy-dom
import { AgentMuxError } from '../../../packages/core/src/errors'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { CapsuleRuntimeSettings } from '../src/renderer/src/components/settings/CapsuleRuntimeSettings'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { capsuleRecoveryFixture } from '../../../packages/core/test/helpers/capsule-recovery-fixture'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { callCapsuleFromApp } from '../src/main/capsule-ipc'

it('allows a new explicit Settings Start after exact original nonapplication through the real public owner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await capsuleRecoveryFixture(); f.failStart(f.notApplied)
  const server = new AgentMuxControlServer({ coreClients: () => [], capsuleRuntime: f.manager.runtime }, f.directory + '/ui.sock')
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const calls: Array<{method:string;params: any}> = [], flights = new Set<Promise<unknown>>()
  const bridge = <M extends import('@agentmux/core').AgentMuxRpcMethod>(_host: string, method: M, params: import('@agentmux/core').AgentMuxRpcParams<M>) => rpc.call(method, params)
  vi.spyOn(api.capsuleRuntime, 'call').mockImplementation((method, params) => {
    calls.push({method,params})
    const promise = callCapsuleFromApp(bridge, method, params) as any
    flights.add(promise); void promise.finally(() => flights.delete(promise))
    return promise
  })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  const settle = async () => { while (flights.size) await act(async () => { await Promise.allSettled([...flights]) }) }
  const button = (text: string) => [...host.querySelectorAll('button')].find(x => x.textContent === text)!
  try {
    await act(async () => root.render(<CapsuleRuntimeSettings active observed={() => {}} />)); await settle()
    await act(async () => button('Start service').click()); await settle()
    expect(host.textContent, host.textContent ?? 'Missing mounted content').toContain('Exact Native storage refusal')
    expect(button('Try Start again'), 'Typed original rejection must expose a new explicit recovery action').toBeDefined()
    expect(f.calls.creates).toHaveLength(1)
    f.failStart(undefined)
    await act(async () => button('Try Start again').click()); await settle()
    expect(host.textContent).toContain('Running')
    const starts = calls.filter(x => x.method === 'capsule.runtime.start')
    expect(starts).toHaveLength(2)
    expect(starts[1]!.params.operationId).not.toBe(starts[0]!.params.operationId)
    expect(starts[1]!.params.expectedRevision).toBe(1)
    expect(f.calls.creates).toHaveLength(2)
    f.failStop(new AgentMuxError('Original Stop refused', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: null }))
    await act(async () => button('Stop service').click()); await settle()
    expect(button('Try Stop again'), 'Typed original Stop rejection must expose a new exact Stop action').toBeDefined()
    f.failStop(undefined)
    await act(async () => button('Try Stop again').click()); await settle()
    const stops = calls.filter(x => x.method === 'capsule.runtime.stop')
    expect(stops).toHaveLength(2)
    expect(stops[1]!.params.operationId).not.toBe(stops[0]!.params.operationId)
    expect(stops[1]!.params.expectedRevision).toBe(stops[0]!.params.expectedRevision + 1)
    expect(stops[1]!.params.expectedRun).toEqual(stops[0]!.params.expectedRun)
    expect(host.textContent).toContain('Stopped')
    expect((await rpc.call('capsule.runtime.inspect',{operationId:starts[0]!.params.operationId})).operation?.phase).toBe('not_applied')
  } finally {
    await act(async () => root.unmount()); host.remove(); await rpc.dispose(); await server.stop(); await f.close()
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  }
})

// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { transientHistoryFixture } from '../../../packages/core/test/helpers/transient-history-fixture.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod } from '../../../packages/core/src/hosted-client-contract.js'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
vi.setConfig({ testTimeout: 20_000 })
beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
const natives: Array<Awaited<ReturnType<typeof transientHistoryFixture>>> = []
afterEach(async () => { for (const native of natives.splice(0)) await native.close(); delete window.agentmux; vi.restoreAllMocks() })

async function fixture() {
  const native = await transientHistoryFixture(), core = native.client
  natives.push(native)
  const service = new AgentMuxHostedRuntimeService(core, native.storePath, () => hostedTestOwner(core))
  const rpc = {
    call: async (method: string, params: unknown, context?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), context))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const subscription = await service.subscribe(method, JSON.parse(JSON.stringify(params)), event => handlers.onEvent(event),
        handlers.signal ? { signal: handlers.signal } : {})
      try { handlers.onInitial(subscription.initial as AgentMuxHostedStreamInitial<AgentMuxHostedStreamMethod>); await subscription.start?.() }
      catch (error) { await subscription.dispose(); throw error }
      return { dispose: async () => { await subscription.dispose() } }
    }
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc })
  const control = { hostId: 'local', agentSessionId: native.retained.agentSessionId, kind: 'agent' as const, run: native.retained.run }
  const observe = vi.fn<AgentMuxPreloadApi['sessions']['observeHistory']>(async (reference, listener, config) => {
    const controller = new AbortController(), remove = config?.onAbort?.(() => controller.abort())
    const handle = await client.observeSessionHistory(reference.agentSessionId, listener, { signal: controller.signal })
    return { source: handle.source, dispose: () => { remove?.(); handle.dispose() } }
  })
  const historyPage = vi.fn<AgentMuxPreloadApi['sessions']['historyPage']>((reference, options) => client.sessionHistoryPage(reference.agentSessionId, options))
  window.agentmux = { control: {}, sessions: { observeHistory: observe, historyPage, onEvent: () => () => {} } } as unknown as AgentMuxPreloadApi
  const { useSessionUserMessages } = await import('../src/renderer/src/lib/session-user-messages')
  const { ActivityView } = await import('../src/renderer/src/components/ActivityView')
  const { createClientUiRoot } = await import('./helpers/client-ui-render')
  let reading!: ReturnType<typeof useSessionUserMessages>
  function Reader() {
    reading = useSessionUserMessages(control)
    return <><span data-observation-error>{reading.observationError?.message}</span>
      <ActivityView sessionId={control.agentSessionId} items={[]} userMessages={reading.messages}
        nativeHistoryPage={reading.nativeHistoryPage} capability="complete-events" displayState="done" /></>
  }
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  await act(async () => root.render(<Reader />))
  return { ...native, core, client, control, service, host, observe, historyPage, reading: () => reading,
    close: async () => { await act(async () => root.unmount()); host.remove(); await client.dispose(); await service.dispose() }
  }
}

it.each(['metadata', 'witness'] as const)('recovers the mounted original reader after a real Core transient-binding %s failure through Hosted and SDK', async kind => {
  const f = await fixture()
  try {
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="original"]')).not.toBeNull())
    const original = f.host.querySelector('[data-native-record-id="original"]')!
    expect(f.reading().nativeHistoryPage?.source).toEqual(f.source)
    const range = document.createRange(); range.selectNodeContents(original)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const reads = f.historyPage.mock.calls.length
    await act(async () => { f.fail(kind); f.invalidate() })
    await vi.waitFor(() => expect(f.reading().observationError?.message).toContain(kind === 'metadata' ? 'metadata read EIO' : 'witness is busy'))
    expect(f.changes).toEqual([expect.objectContaining({ kind: 'unavailable', source: f.source })])
    expect(f.released).not.toHaveBeenCalled(); expect(f.historyPage).toHaveBeenCalledTimes(reads)
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(f.input).not.toHaveBeenCalled()
    await expect(f.client.writeAgent({ agentSessionId: f.control.agentSessionId, expectedRun: f.control.run, source: 'user', data: 'x' }))
      .resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 1 } })
    expect(f.input).toHaveBeenCalledOnce()
    await f.append()
    await act(async () => { f.invalidate(); await new Promise(resolve => setTimeout(resolve, 100)) })
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="later"]')?.textContent).toContain('later native reply'))
    expect(f.reading().observationError).toBeNull()
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(range.startContainer).toBe(original)
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.released).not.toHaveBeenCalled(); expect(f.input).toHaveBeenCalledOnce()
    expect(f.core.agentSession(f.control.agentSessionId).run).toEqual(f.control.run)
    expect(f.core.agentSession(f.control.agentSessionId).nativeHandle?.sessionId).toBe('retained-old')
    expect(await readFile(f.storePath)).toEqual(f.before)
  } finally { await f.close() }
})

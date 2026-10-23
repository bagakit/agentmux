// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { transientHistoryFixture } from '../../../packages/core/test/helpers/transient-history-fixture.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import type { AgentProvider } from '../../../packages/core/src/agent-provider.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod } from '../../../packages/core/src/hosted-client-contract.js'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'

vi.setConfig({ testTimeout: 20_000 })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
const natives: Array<Awaited<ReturnType<typeof transientHistoryFixture>>> = []
afterEach(async () => { for (const native of natives.splice(0)) await native.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function hasNativeHistoryPage(provider: AgentProvider): provider is AgentProvider & Required<Pick<AgentProvider, 'readSessionHistoryPage'>> {
  return typeof provider.readSessionHistoryPage === 'function'
}

async function fixture(beforeRender?: (native: Awaited<ReturnType<typeof transientHistoryFixture>>) => void) {
  const native = await transientHistoryFixture(), core = native.client
  beforeRender?.(native)
  const originalSessions = await native.store.loadMetadata()
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
  const bridgeCloses: Array<() => unknown | Promise<unknown>> = []
  await desktopConversationReadBridge({ root: native.root, client }, bridgeCloses)
  const currentWatch = vi.spyOn(core, 'observeConversation')
  const provider = core.providers.get('claude')
  if (!hasNativeHistoryPage(provider)) throw new Error('The original built-in Provider must own native history page reading')
  const historyPage = vi.spyOn(provider, 'readSessionHistoryPage')
  const { ActivityView } = await import('../src/renderer/src/components/ActivityView')
  const { createClientUiRoot } = await import('./helpers/client-ui-render')
  const reading = () => inspectConversationConsumers(control).consumers[0]
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control })} displayState="done" />))
  return { ...native, originalSessions, core, client, control, service, host, currentWatch, historyPage, reading,
    close: async () => { await act(async () => root.unmount()); host.remove(); for (const close of bridgeCloses.reverse()) await close(); await client.dispose(); await service.dispose() }
  }
}

it.each(['metadata', 'witness'] as const)('recovers the mounted original reader after a real Core transient-binding %s failure through Hosted and SDK', async kind => {
  const f = await fixture()
  try {
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="original"]')).not.toBeNull())
    const original = f.host.querySelector('[data-native-record-id="original"]')!
    expect(f.reading()?.accepted?.scope.sources).toContainEqual({ kind: 'native', ...f.source })
    const range = document.createRange(); range.selectNodeContents(original)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const reads = f.historyPage.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(f.historyPage.mock.calls.every(([input]) => input.source.providerId === f.source.providerId &&
      input.source.nativeSessionId === f.source.nativeSessionId)).toBe(true)
    await act(async () => { f.fail(kind); f.invalidate() })
    await vi.waitFor(() => expect(f.reading()?.observationError?.message).toContain(kind === 'metadata' ? 'metadata read EIO' : 'witness is busy'))
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
    expect(f.reading()?.observationError).toBeNull()
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(range.startContainer).toBe(original)
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.released).not.toHaveBeenCalled(); expect(f.input).toHaveBeenCalledOnce()
    expect(f.core.agentSession(f.control.agentSessionId).run).toEqual(f.control.run)
    expect(f.core.agentSession(f.control.agentSessionId).nativeHandle?.sessionId).toBe('retained-old')
    expect(await f.store.loadMetadata()).toEqual(f.originalSessions)
  } finally { await f.close() }
})

it('the first mounted current reader hands its original no-view watch to its accepted view with one physical native observation', async () => {
  const f = await fixture()
  try {
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="original"]')).not.toBeNull())
    await vi.waitFor(() => expect(f.reading()?.watch).toMatchObject({ binding: false, bound: true, closed: false }))
    expect(f.reading()?.accepted?.scope.sources).toContainEqual({ kind: 'native', ...f.source })
    expect(f.currentWatch.mock.calls).toHaveLength(2)
    expect(f.currentWatch.mock.calls[0]![0]).toEqual({ hostId: 'local', agentSessionId: f.control.agentSessionId })
    expect(f.currentWatch.mock.calls[1]![0]).toMatchObject({ hostId: 'local', agentSessionId: f.control.agentSessionId, view: expect.any(String) })
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.released).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
    expect(f.core.agentSession(f.control.agentSessionId).run).toEqual(f.control.run)
    expect(f.core.agentSession(f.control.agentSessionId).nativeHandle?.sessionId).toBe('retained-old')
    expect(await f.store.loadMetadata()).toEqual(f.originalSessions)
  } finally { await f.close() }
  expect(f.released).toHaveBeenCalledOnce()
})

it('explicit Current recovers an accepted saved frame after its original native watch resolved a different current source', async () => {
  const f = await fixture(native => native.observe.mockRejectedValueOnce(
    new AgentMuxError('Original current observation is temporarily unavailable', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE')))
  try {
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="old"]')).not.toBeNull())
    await vi.waitFor(() => expect(f.reading()?.observationError?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
    const saved = f.host.querySelector('[data-native-record-id="old"]')!
    expect(f.reading()?.accepted?.scope.sources).toContainEqual({ kind: 'native', providerId: 'claude', nativeSessionId: 'retained-old' })
    expect(saved.isConnected).toBe(true)
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBeNull()
    expect(f.observe).toHaveBeenCalledTimes(2); expect(f.discover).toHaveBeenCalledTimes(2)
    expect(f.released).toHaveBeenCalledOnce()
    const current = f.host.querySelector<HTMLButtonElement>('button[data-message-tool-control="jump-to-latest"]')
    expect(current).not.toBeNull()
    await act(async () => current!.click())
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="original"]')).not.toBeNull())
    await vi.waitFor(() => expect(f.reading()?.observationError).toBeNull())
    const original = f.host.querySelector('[data-native-record-id="original"]')!
    expect(f.reading()?.accepted?.scope.sources).toContainEqual({ kind: 'native', ...f.source })
    expect(f.host.querySelector('[data-native-record-id="old"]')).toBeNull()
    expect(f.observe).toHaveBeenCalledTimes(3); expect(f.discover).toHaveBeenCalledTimes(3)
    expect(f.released).toHaveBeenCalledOnce()
    const range = document.createRange(); range.selectNodeContents(original)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    await f.append()
    await act(async () => { f.invalidate(); await new Promise(resolve => setTimeout(resolve, 100)) })
    await vi.waitFor(() => expect(f.host.querySelector('[data-native-record-id="later"]')?.textContent).toContain('later native reply'))
    expect(f.host.querySelector('[data-native-record-id="original"]')).toBe(original)
    expect(range.startContainer).toBe(original)
    await expect(f.client.writeAgent({ agentSessionId: f.control.agentSessionId, expectedRun: f.control.run, source: 'user', data: 'x' }))
      .resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 1 } })
    expect(f.input).toHaveBeenCalledOnce()
    expect(f.core.agentSession(f.control.agentSessionId).run).toEqual(f.control.run)
    expect(f.core.agentSession(f.control.agentSessionId).nativeHandle?.sessionId).toBe('retained-old')
    expect(await f.store.loadMetadata()).toEqual(f.originalSessions)
  } finally { window.getSelection()?.removeAllRanges(); await f.close() }
})

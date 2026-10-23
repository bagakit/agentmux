import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../../../packages/core/src/client'
import { AgentMuxFileAgentSessionStore, type AgentCapturedTimelineStream, type AgentSessionHistoryPage, type AgentTimelineItem } from '@agentmux/core'
import { desktopConversationReadBridge } from './conversation-read-bridge'
import { inspectConversationConsumers } from '../../src/renderer/src/lib/conversation-consumer-observation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


/** Real Core Reader/Store/IPC; only the original typed native page and fixed same-source change-cut leaves are controlled. */
export async function conversationPagePortFixture(reference: { hostId: string; agentSessionId: string },
  source: AgentSessionHistoryPage['source'], read: AgentMuxClient['readSessionHistoryPage']) {
  const root = await mkdtemp(join(tmpdir(), 'amux-conversation-page-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: reference.agentSessionId, providerId: source.providerId,
    executorId: source.providerId, hostId: reference.hostId, workspacePath: root, run: { runId: 'original-page-fixture-run' }, retiredRuns: [],
    hookBindingId: 'page-fixture-binding', hookToken: 'page-fixture-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId } })
  const client = new AgentMuxClient({ store }), closes: Array<() => unknown | Promise<unknown>> = []
  const checkpoint={agentSessionId:reference.agentSessionId,source,cursor:'original-page-cut'}
  const originalRead = client['readSessionHistoryPage'], originalChanges = client['nativeHistoryChangesPage']
  const readDescriptor = Object.getOwnPropertyDescriptor(client, 'readSessionHistoryPage')
  const changesDescriptor = Object.getOwnPropertyDescriptor(client, 'nativeHistoryChangesPage')
  const nativeRead = vi.fn<typeof originalRead>(async (...args) => ({ ...await read.call(client, ...args), changesCursor: checkpoint.cursor }))
  const nativeCheckpoint = vi.fn<typeof originalChanges>(async () => ({ ...reference, source, items: [], checkpoint, more: false }))
  const nativeChanges = vi.fn<typeof originalChanges>(async () => ({ ...reference, source, items: [], checkpoint, more: false }))
  // These are Core's exact native port owners. Public window reads still pass
  // through Core/Unix/IPC/Preload, including the original source argument.
  client['readSessionHistoryPage'] = nativeRead
  client['nativeHistoryChangesPage'] = (...args) => (args[1].tail ? nativeCheckpoint : nativeChanges)(...args)
  vi.spyOn(client, 'observeSessionHistory').mockResolvedValue({ source, dispose() {} })
  const kernel = client['kernel']
  const controls = (['start', 'input', 'resize', 'stop', 'attach', 'status'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('A page reading fixture cannot control Runtime') }))
  await desktopConversationReadBridge({ root, client }, closes, () => [{ hostId: reference.hostId, client }])
  return { client, store, nativeRead, nativeCheckpoint, nativeChanges, controls,
    // Test source injection uses the original persisted publisher, not raw Activity props.
    // The UI still reads its original Core/Unix/IPC/Preload conversation window.
    publishCaptured: async (items: readonly AgentTimelineItem[]) => {
      for (const item of items) {
        if (item.agentSessionId !== reference.agentSessionId) throw new Error('Captured fixture belongs to another original Session')
        await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: reference.agentSessionId, item },
          { source: 'agentmux', observedAt: item.updatedAt }, reference.hostId)
      }
      return (await store.readCapturedHistory(reference.agentSessionId, { limit: 1 })).stream
    },
    acceptedCaptured: (stream: AgentCapturedTimelineStream) => inspectConversationConsumers(reference).consumers.some(consumer =>
      consumer.accepted?.checkpoint.frontier.cuts.some(cut => cut.kind === 'captured' && cut.epoch === stream.epoch && cut.sequence === stream.sequence)),
    close: async () => {
    const failures: unknown[] = []
    try {
      for (const close of closes.splice(0).reverse()) {
        try { await close() } catch (error) { failures.push(error) }
      }
      try { await client.dispose() } catch (error) { failures.push(error) }
      try { await rm(root, { recursive: true }) } catch (error) { failures.push(error) }
    } finally {
      if (readDescriptor) Object.defineProperty(client, 'readSessionHistoryPage', readDescriptor)
      else Reflect.deleteProperty(client, 'readSessionHistoryPage')
      if (changesDescriptor) Object.defineProperty(client, 'nativeHistoryChangesPage', changesDescriptor)
      else Reflect.deleteProperty(client, 'nativeHistoryChangesPage')
    }
    if (failures.length) throw new AggregateError(failures, 'Original page-port fixture cleanup failed')
  } }
}

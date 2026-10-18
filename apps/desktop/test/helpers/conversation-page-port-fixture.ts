import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentCapturedTimelineStream, type AgentSessionHistoryPage, type AgentTimelineItem } from '@agentmux/core'
import { desktopConversationReadBridge } from './conversation-read-bridge'
import { inspectConversationConsumers } from '../../src/renderer/src/lib/conversation-consumer-observation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


/** Real Core Reader/Store/IPC; only the original typed native page and fixed same-source change-cut leaves are controlled. */
export async function conversationPagePortFixture(reference: { hostId: string; agentSessionId: string },
  source: AgentSessionHistoryPage['source'], read: AgentMuxClient['sessionHistoryPage']) {
  const root = await mkdtemp(join(tmpdir(), 'amux-conversation-page-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: reference.agentSessionId, providerId: source.providerId,
    executorId: source.providerId, hostId: reference.hostId, workspacePath: root, run: { runId: 'original-page-fixture-run' }, retiredRuns: [],
    hookBindingId: 'page-fixture-binding', hookToken: 'page-fixture-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId } })
  const client = new AgentMuxClient({ store }), closes: Array<() => unknown | Promise<unknown>> = []
  const checkpoint={agentSessionId:reference.agentSessionId,source,cursor:'original-page-cut'}
  const nativeRead = vi.spyOn(client, 'sessionHistoryPage').mockImplementation(async(...args)=>({...await read(...args),changesCursor:checkpoint.cursor}))
  vi.spyOn(client, 'sessionHistoryCheckpoint').mockResolvedValue(checkpoint)
  vi.spyOn(client, 'readSessionHistoryChanges').mockResolvedValue({...reference,source,items:[],checkpoint,more:false})
  vi.spyOn(client, 'observeSessionHistory').mockResolvedValue({ source, dispose() {} })
  const kernel = (client as unknown as { kernel: Record<string, () => unknown> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('A page reading fixture cannot control Runtime') }))
  await desktopConversationReadBridge({ root, client }, closes, () => [{ hostId: reference.hostId, client }])
  return { client, store, nativeRead, controls,
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
    for (const close of closes.reverse()) await close()
    await client.dispose(); await rm(root, { recursive: true, force: true })
  } }
}

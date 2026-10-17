import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'
import { act } from 'react'
import { AgentMuxClient } from '../../../../packages/core/src/client'
import { AgentMuxFileAgentSessionStore } from '../../../../packages/core/src/agent-session-store'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl } from '../../src/shared/contracts'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { desktopConversationReadBridge } from './conversation-read-bridge'

export const waitForAgentCardReading = (check: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  check()
}, { timeout: 2000, interval: 20 })

/** Component tests control typed native leaves; the production shared Reader still
 * travels through real Core, public transport, IPC, preload and strict Renderer API. */
export async function agentCardConversationFixture(sourceFor: (control: AgentSessionControl) => AgentSessionHistoryPage['source']) {
  const root = await mkdtemp(join(tmpdir(), 'agent-card-reading-'))
  const hosts = new Map<string, { client: AgentMuxClient; store: AgentMuxFileAgentSessionStore }>()
  const controls = new Map<string, AgentSessionControl>(), captured = new Map<string, string>(), seeded = new Set<string>()
  const key = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])
  const controlFor = (hostId: string, sessionId: string) => controls.get(key(hostId, sessionId))!
  function host(hostId: string) {
    let owner = hosts.get(hostId)
    if (owner) return owner
    const store = new AgentMuxFileAgentSessionStore(join(root, `sessions-${hosts.size}.json`))
    const client = new AgentMuxClient({ store })
    vi.spyOn(client, 'sessionHistoryPage').mockImplementation(async (id, options) => ({
      ...await api.sessions.historyPage(controlFor(hostId, id), options), changesCursor: 'original-card-source-cut'
    }))
    vi.spyOn(client, 'sessionHistoryCheckpoint').mockImplementation(async id => ({ agentSessionId: id,
      source: sourceFor(controlFor(hostId, id)), cursor: 'original-card-source-cut' }))
    vi.spyOn(client, 'readSessionHistoryChanges').mockImplementation(async id => ({ hostId, agentSessionId: id,
      source: sourceFor(controlFor(hostId, id)), items: [], checkpoint: { agentSessionId: id,
        source: sourceFor(controlFor(hostId, id)), cursor: 'original-card-source-cut' }, more: false }))
    vi.spyOn(client, 'observeSessionHistory').mockImplementation((id, listener, options) => api.sessions.observeHistory(controlFor(hostId, id), listener, options))
    owner = { client, store }; hosts.set(hostId, owner); return owner
  }
  let closing = false, seedTail = Promise.resolve()
  async function writeSeed(reference?: { hostId: string; agentSessionId: string }) {
    const sessions = useAppStore.getState().sessions.filter(session => session.kind === 'agent' && (!reference ||
      session.control.hostId === reference.hostId && session.control.agentSessionId === reference.agentSessionId))
    for (const session of reference ? sessions : sessions.slice(0, 1)) {
      if (session.kind !== 'agent') continue
      const control = session.control, source = sourceFor(control), owner = host(control.hostId)
      const identity = key(control.hostId, control.agentSessionId)
      controls.set(identity, control)
      if (!seeded.has(identity)) { await owner.store.compareAndSwap(null, { kind: 'agent', agentSessionId: control.agentSessionId,
        hostId: control.hostId, providerId: source.providerId, executorId: source.providerId,
        workspacePath: session.workspacePath, run: control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt: session.updatedAt,
        hookBindingId: 'original-card-reading', hookToken: 'private-card-token',
        nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId } }); seeded.add(identity) }
      for (const item of useAppStore.getState().timelines[session.id]?.items ?? []) {
        const itemKey = JSON.stringify([identity, item.id]), version = JSON.stringify(item)
        if (captured.get(itemKey) === version) continue
        await Reflect.get(owner.client, 'persistAndPublishTimeline').call(owner.client,
          { type: captured.has(itemKey) ? 'upsert' : 'append', agentSessionId: control.agentSessionId,
            item: { ...item, agentSessionId: control.agentSessionId } },
          { source: 'agentmux', observedAt: item.updatedAt }, 'local')
        captured.set(itemKey, version)
      }
    }
  }
  function seed(reference?: { hostId: string; agentSessionId: string }) {
    if (closing) return Promise.resolve()
    const operation = seedTail.then(() => writeSeed(reference))
    seedTail = operation.catch(() => {})
    return operation
  }
  await seed()
  const closes: Array<() => unknown | Promise<unknown>> = []
  const publicRead = await desktopConversationReadBridge({ root, client: hosts.values().next().value!.client }, closes,
    () => [...hosts].map(([hostId, value]) => ({ hostId, client: value.client })))
  for (const name of ['readAgentConversation', 'readConversationChanges', 'observeConversation'] as const) {
    vi.mocked(api.conversation[name]).mockImplementation((async (...args: Parameters<typeof publicRead[typeof name]>) => {
      await seed(args[0])
      return await (publicRead[name] as (...input: unknown[]) => Promise<unknown>)(...args)
    }) as never)
  }
  onTestFinished(async () => {
    closing = true
    await seedTail
    for (const close of closes.reverse()) await close()
    for (const { client } of hosts.values()) await client.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { clientFor: (hostId: string) => host(hostId).client, storeFor: (hostId: string) => host(hostId).store, sync: seed }
}

import { fixtureDay } from '../helpers/fixture-values.js'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi, expect } from 'vitest'
import * as core from '../../dist/index.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'

/** Compiled public Client/FileStore/Provider with no Native connection or fake history reader. */
export async function historyReaderFixture(native = false, retired = false, body = 'Original task 中', managedCaller = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-context-'))
  const transcript = join(root, 'original.jsonl'), storePath = join(root, 'sessions.json')
  const nativeRows = ['older-native', 'newer-native'].map((id, index) => ({ sessionId: 'original-native', uuid: id,
    parentUuid: index ? 'older-native' : null, type: 'user', timestamp: `${fixtureDay(1)}T00:0${index}:00Z`,
    message: { role: 'user', content: index ? body : 'Older original native work' } }))
  await writeFile(transcript, nativeRows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const store = new core.AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', hostId: 'local',
    providerId: 'claude', executorId: 'claude', workspacePath: root, run: { runId: 'ended-original-run' },
    retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1,
    ...(native ? { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'original-native', transcriptPath: transcript } } : {}) }
  await store.compareAndSwap(null, session)
  const caller = managedCaller ? { agentSessionId: 'mote-actor', capability: core.issueAgentCapability() } : undefined
  if (caller) await store.compareAndSwap(null, { ...session, agentSessionId: caller.agentSessionId,
    run: { runId: 'actor-run' }, capabilityHash: core.hashAgentCapability(caller.capability) })
  for (const [index, content] of ['Older captured work', body].entries()) {
    await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: {
      id: `captured-${index}`, agentSessionId: session.agentSessionId, kind: 'user_message', status: 'complete',
      source: 'user', title: 'Original input', content, createdAt: 100 + index, updatedAt: 100 + index } })
  }
  if (retired) {
    const reservation = { kind: 'stop' as const, reservationId: 'stop-fixture', ownerId: 'fixture-owner', ownerPid: process.pid,
      agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'fixture-stop', expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'no-runtime', operationKey: 'fixture-stop', runId: session.run.runId } }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
  }
  const client = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(storePath) })
  const kernel = (client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const lifecycle = ['start', 'input', 'attach', 'stop', 'resize', 'status'].map(name => vi.spyOn(kernel, name))
  const connect = vi.spyOn(client, 'connect')
  const before = await readFile(storePath), nativeBefore = await readFile(transcript)
  return { root, storePath, transcript, store, client, session, caller,
    reference: { hostId: 'local', agentSessionId: session.agentSessionId },
    async unchanged() {
      for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(await readFile(storePath)).toEqual(before)
      expect(await readFile(transcript)).toEqual(nativeBefore)
    },
    async close() { await client.dispose(); await rm(root, { recursive: true, force: true }) }
  }
}
export { core }

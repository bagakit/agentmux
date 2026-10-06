import { fixtureEpoch as _tailRefreshFixtureEpoch } from "./fixture-values.js"
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem } from '../../src/types.js'

/** Private real Store/Provider fixture. It never starts, attaches or controls a user Run. */
export async function createHistoryQueryFixture(cleanups: Array<() => Promise<unknown>>, provider: 'claude' | 'pi' = 'claude', records = 5) {
  const root = await mkdtemp(join(tmpdir(), 'amx-history-query-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const transcript = join(root, 'native.jsonl'), storePath = join(root, 'sessions.json'), id = 'original-agent'
  const nativeRows = Array.from({ length: records }, (_, index) => provider === 'claude'
    ? { type: index >= records - 70 && records > 100 ? 'assistant' : 'user', sessionId: 'original-native', uuid: `record-${index}`, timestamp: new Date(_tailRefreshFixtureEpoch(0, 1) + index).toISOString(),
      message: { role: index >= records - 70 && records > 100 ? 'assistant' : 'user', content: index === 0 ? 'needle older than three hundred records' : `input ${index}` } }
    : { type: 'message', id: `record-${index}`, parentId: index ? `record-${index - 1}` : null, timestamp: new Date(_tailRefreshFixtureEpoch(0, 1) + index).toISOString(),
      message: { role: 'user', content: index === 0 ? 'needle older than three hundred records' : `input ${index}` } })
  await writeFile(transcript, [...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'original-native', cwd: root }] : []), ...nativeRows].map(row => JSON.stringify(row)).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, hostId: 'local', providerId: provider, executorId: provider,
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: provider, sessionId: 'original-native', transcriptPath: transcript } }
  await store.compareAndSwap(null, session)
  const captured = (index: number, content: string): AgentTimelineItem => ({ id: `captured-${index}`, agentSessionId: id, kind: 'user_message', status: 'complete', source: 'user',
    title: 'Original input', content, createdAt: index + 1, updatedAt: index + 1, authorHuman: true, sourceChannel: 'message-tool', sourceDevice: { hostId: 'sender-host', deviceId: 'sender-device', name: 'Private device' } })
  for (let index = 0; index < 4; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(index, index >= 2 ? 'same input' : `older ${index}`) })
  const client = new AgentMuxClient({ store })
  cleanups.push(() => client.dispose())
  const kernel = (client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const forbidden = ['connect', 'start', 'input', 'attach', 'stop', 'resize', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error(`Unexpected Runtime control: ${name}`) }))
  const sourceBefore = await readFile(transcript)
  return { root, transcript, store, storePath, session, captured, client, forbidden, reference: { hostId: 'local', agentSessionId: id },
    async noControls() { expect(forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(await readFile(transcript)).toEqual(sourceBefore) } }
}

/** Actual Unix Hosted SDK → same semantic Host → FileStore/Provider chain for
 * mounted product consumers. The existing SDK cold-opening projection attempt
 * is recorded separately; history reads cannot add any Runtime operation. */
export async function createHostedHistoryFixture(provider: 'claude' | 'pi' = 'claude', records = 5) {
  const cleanups: Array<() => Promise<unknown>> = []
  const f = await createHistoryQueryFixture(cleanups, provider, records)
  const owner = { runtimeId: 'private-history-host', ownerInstanceId: 'private-history-epoch', protocolVersion: 2 as const,
    processId: process.pid, ctxmux: null, availability: 'unverified' as const }
  const service = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => owner)
  cleanups.push(() => service.dispose())
  const socketPath = join(f.root, 'hosted.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => service })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanups.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanups.push(() => client.dispose())
  await vi.waitFor(() => expect(f.forbidden[0]).toHaveBeenCalledOnce())
  const coldOpeningRuntimeAttempts = f.forbidden.map(spy => spy.mock.calls.length)
  expect(coldOpeningRuntimeAttempts.slice(1)).toEqual([0, 0, 0, 0, 0, 0])
  for (const spy of f.forbidden) spy.mockClear()
  return { ...f, ownerClient: f.client, client, rpc, service, coldOpeningRuntimeAttempts,
    async dispose() { for (const close of cleanups.splice(0).reverse()) await close() } }
}

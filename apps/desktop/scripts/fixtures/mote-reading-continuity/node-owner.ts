import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxClient } from '../../../../../packages/core/src/client'
import { AgentMuxFileAgentSessionStore } from '../../../../../packages/core/src/agent-session-store'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import type { AgentMuxStoredAgentSession } from '../../../../../packages/core/src/types'
import { scratchTopicDirectoryName, PMO_TEAMS_TOPIC_ID } from '@agentmux/host/mote-model'
import { readingSessionId, readingNativeId, readingRunId, readingLines } from './source'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export async function createReadingOwner(root: string) {
  const workspacePath = join(root, 'topics', scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID))
  await mkdir(workspacePath, { recursive: true })
  const transcript = join(root, 'native.jsonl'), storeFile = join(root, 'sessions.json')
  await writeFile(transcript, readingLines(0, 60))
  const store = new AgentMuxFileAgentSessionStore(storeFile)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: readingSessionId, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath,
    run: { runId: readingRunId }, retiredRuns: [], hookBindingId: 'private-reading-binding', hookToken: 'private-reading-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: readingNativeId, transcriptPath: transcript } }
  await store.compareAndSwap(null, stored); await store.readCapturedHistory(readingSessionId)
  const originalStore = sha(await readFile(storeFile)), originalNative = sha(await readFile(transcript))
  let expectedNative = originalNative
  const controls: { method: string; args: unknown[] }[] = [], calls: { method: string; input: unknown }[] = []
  const client = new AgentMuxClient({ store })
  const kernel = Reflect.get(client, 'kernel')
  for (const method of ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status']) kernel[method] = (...args: unknown[]) => {
    controls.push({ method, args }); throw new Error('Private reading may not control Runtime ' + method)
  }
  for (const method of ['readAgentConversation', 'readConversationChanges'] as const) {
    const read = client[method].bind(client)
    client[method] = ((input: any, options: any) => {
      calls.push({ method, input: structuredClone(input) }); return read(input, options)
    }) as typeof client[typeof method]
  }
  const observers = new Set<Parameters<AgentMuxClient['observeSessionHistory']>[1]>()
  const observe = client.observeSessionHistory.bind(client)
  client.observeSessionHistory = (id, listener, options) => {
    observers.add(listener)
    const result = observe(id, listener, options)
    return Promise.resolve(result).then(handle => ({ ...handle, dispose() { observers.delete(listener); handle.dispose() } }))
  }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'reader.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  return { client, server, seed: stored,
    async append() {
      await appendFile(transcript, readingLines(60, 100)); expectedNative = sha(await readFile(transcript))
      for (const listener of observers) listener({ agentSessionId: readingSessionId, source: { providerId: 'claude', nativeSessionId: readingNativeId }, kind: 'invalidated' })
    },
    async facts() { return { calls: structuredClone(calls), activeNativeObservers: observers.size, controls: structuredClone(controls), originalStore, store: sha(await readFile(storeFile)),
      originalNative, expectedNative, native: sha(await readFile(transcript)), sessionId: readingSessionId, run: stored.run, nativeHandle: stored.nativeHandle } },
    async close() { await server.stop(); await client.dispose() }
  }
}

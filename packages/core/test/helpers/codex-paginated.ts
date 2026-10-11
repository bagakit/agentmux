import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


export const source = { providerId: 'codex', nativeSessionId: 'paginated-native-fixture' }
export const turn = 'original-user-turn'
export const body = 'Original user text 中🙂\nwith "quoted" content'
export const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
export const user = (id = 'native-user-item', content: unknown[] = [{ type: 'text', text: body, text_elements: [] }]) => ({
  timestamp: new Date(_historyFixtureEpoch(0, 0, 100)).toISOString(), type: 'event_msg', payload: {
    type: 'item_completed', thread_id: source.nativeSessionId, turn_id: turn,
    item: { type: 'UserMessage', id, client_id: 'opaque-client-correlation', content }
  }
})
export const context = (text = body) => ({ type: 'response_item', payload: { type: 'message', id: 'model-context-record', role: 'user',
  content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn } } })

/** Real built-in Provider and durable Session owner; no native Runtime or model. */
export async function paginatedFixture(rows: unknown[], mode: unknown = 'paginated', compiled = false) {
  const core = compiled ? await import('../../dist/index.js') : await import('../../src/index.js')
  const root = await mkdtemp(join(tmpdir(), 'agentmux-paginated-user-'))
  const transcriptPath = join(root, 'original.jsonl'), storePath = join(root, 'sessions.json')
  const meta = { type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root,
    ...(mode === undefined ? {} : { history_mode: mode }) } }
  const original = jsonl([meta, ...rows]); await writeFile(transcriptPath, original)
  const store = new core.AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'paginated-reader-fixture', hostId: 'local', providerId: 'codex',
    executorId: 'codex', workspacePath: root, run: { runId: 'unchanged-original-run' }, retiredRuns: [],
    hookBindingId: 'fixture-binding', hookToken: 'fixture-secret', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath } }
  await store.compareAndSwap(null, session)
  const client = new core.AgentMuxClient({ store })
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(Reflect.get(client, 'kernel'), key))
  const connect = vi.spyOn(client, 'connect')
  const providerContext: AgentProviderSessionHistoryContext = { agentSessionId: session.agentSessionId, source, transcriptPath,
    workspacePath: root, contentSigningSecret: session.hookToken, command: 'codex', args: [], env: {}, limit: 100, signal: new AbortController().signal }
  return { root, client, store, session, providerContext, transcriptPath, meta,
    recordId(index: number) { return `codex-record:${Buffer.byteLength(jsonl([meta, ...rows.slice(0, index)]))}` },
    async close() { try {
      expect(await store.readMetadata(session.agentSessionId)).toEqual(session)
      expect(connect).not.toHaveBeenCalled(); for (const control of controls) expect(control).not.toHaveBeenCalled()
    } finally { await client.dispose(); await rm(root, { recursive: true, force: true }) } },
    async unchangedSource() { expect(await readFile(transcriptPath, 'utf8')).toBe(original) }
  }
}

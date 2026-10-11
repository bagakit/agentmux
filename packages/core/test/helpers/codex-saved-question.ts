import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


export const savedQuestionSource = { providerId: 'codex', nativeSessionId: 'saved-question-native' }
export const savedQuestionTurn = 'original-question-turn'
export const savedQuestionCall = 'original-async-call'
export const savedQuestionId = JSON.stringify(['request_user_input_async', savedQuestionCall, 0])
export const savedQuestionPrompt = 'Choose how to continue the original work.'
export const savedQuestionAnswer = 'Keep the original work'
export const savedQuestionEvent = (options: string[] | null = ['Keep the original work', 'Review the direction']) => ({
  timestamp: new Date(_historyFixtureEpoch(0, 0, 100)).toISOString(), type: 'event_msg', payload: {
    type: 'item_completed', thread_id: savedQuestionSource.nativeSessionId, turn_id: savedQuestionTurn,
    item: { type: 'AgentMessage', id: savedQuestionCall,
      content: [{ type: 'Text', text: savedQuestionPrompt }], phase: 'final_answer', delivery: 'async',
      questions: [{ title: savedQuestionPrompt, options }] },
    started_at_ms: _historyFixtureEpoch(0, 0, 100), completed_at_ms: _historyFixtureEpoch(0, 0, 100)
  }
})
export const savedQuestionTool = () => ({ type: 'response_item', payload: { type: 'function_call', id: 'original-tool-record',
  name: 'request_user_input_async', call_id: savedQuestionCall, arguments: JSON.stringify({ questions: savedQuestionEvent().payload.item.questions }) } })
export const savedQuestionResult = () => ({ type: 'response_item', payload: { type: 'function_call_output', id: 'original-tool-result',
  call_id: savedQuestionCall, output: '{"accepted":true}' } })
export const savedQuestionReply = () => ({ type: 'response_item', payload: { type: 'message', id: 'original-answer-record', role: 'user',
  content: [{ type: 'input_text', text: '<send_user_message_question_reply>\n' + JSON.stringify([
    { answer: savedQuestionAnswer, question: savedQuestionPrompt, questionItemId: savedQuestionId }
  ]) + '\n</send_user_message_question_reply>' }], internal_chat_message_metadata_passthrough: { turn_id: savedQuestionTurn } } })
export const savedQuestionJsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

/** Isolated FileStore and the real built-in Provider. Runtime operations are forbidden. */
export async function savedQuestionFixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-saved-question-'))
  const transcriptPath = join(root, 'native.jsonl'), storePath = join(root, 'sessions.json')
  const meta = { type: 'session_meta', payload: { id: savedQuestionSource.nativeSessionId, cwd: root } }
  await writeFile(transcriptPath, savedQuestionJsonl([meta, ...rows]))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'saved-question-reader', hostId: 'local', providerId: 'codex',
    executorId: 'codex', workspacePath: root, run: { runId: 'unchanged-original-run' }, retiredRuns: [],
    hookBindingId: 'question-test-binding', hookToken: 'question-test-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: savedQuestionSource.nativeSessionId, transcriptPath } }
  await store.compareAndSwap(null, session)
  const before = await readFile(storePath), nativeBefore = await readFile(transcriptPath)
  const client = new AgentMuxClient({ store })
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(Reflect.get(client, 'kernel'), key))
  const connect = vi.spyOn(client, 'connect')
  const context: AgentProviderSessionHistoryContext = { agentSessionId: session.agentSessionId, source: savedQuestionSource,
    transcriptPath, workspacePath: root, contentSigningSecret: session.hookToken, command: 'codex', args: [], env: {}, limit: 100, signal: new AbortController().signal }
  return { root, client, session, context, transcriptPath, nativeBefore,
    recordId(index: number) { return `codex-record:${Buffer.byteLength(savedQuestionJsonl([meta, ...rows.slice(0, index)]))}` },
    async unchanged() { expect(await readFile(storePath)).toEqual(before); expect(await readFile(transcriptPath)).toEqual(nativeBefore) },
    async close() { try { expect(await readFile(storePath)).toEqual(before); expect(connect).not.toHaveBeenCalled(); for (const control of controls) expect(control).not.toHaveBeenCalled() }
      finally { await client.dispose(); await rm(root, { recursive: true, force: true }) } }
  }
}

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { projectConversationQuestions } from '../src/conversation-questions.js'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { savedQuestionFixture as fixture, savedQuestionEvent as event, savedQuestionTool as tool, savedQuestionResult as result,
  savedQuestionReply as reply, savedQuestionSource as source, savedQuestionTurn as turn, savedQuestionId as questionId,
  savedQuestionPrompt as prompt, savedQuestionAnswer as answer, savedQuestionAt as questionAt, savedQuestionJsonl as jsonl } from './helpers/codex-saved-question.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

it.each([['options', ['Keep the original work', 'Review the direction']], ['text only', null]] as const)('saved canonical %s question reaches the public page with original record, source, turn and answer identity', async (_name, options) => {
  const f = await fixture([tool(), event(options && [...options]), result(), reply()]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toHaveLength(4)
  expect(page.items[0]).toMatchObject({ id: 'original-tool-record', kind: 'activity', contentParts: [{ kind: 'tool-call', name: 'request_user_input_async' }] })
  expect(page.items[2]).toMatchObject({ id: 'original-tool-result', kind: 'activity', contentParts: [{ kind: 'tool-result', output: '{"accepted":true}' }] })
  expect(page.items[1]).toEqual({ id: f.recordId(1), kind: 'assistant-message', turnId: turn, startedAt: questionAt,
    messagePhase: 'final', contentParts: [{ kind: 'text', text: prompt }], questionRequest: { delivery: 'async', questions: [
      { id: questionId, prompt, options: (options ?? []).map((label, n) => ({ id: String(n), label })), acceptsText: true }
    ] } })
  const [question] = projectConversationQuestions({ agentSessionId: page.agentSessionId, historyPage: page })
  expect(question?.recordId).toBe(f.recordId(1)); expect(question?.recordedAnswers.get(questionId)).toBe(answer)
  expect(question).not.toHaveProperty('pending')
  expect(await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: f.recordId(1), turnId: turn })).toEqual(page.items[1])
  await f.unchanged()
})

it('keeps malformed questions complete and readable beside their local diagnostic', async () => {
  const bad = event(); Object.assign(bad.payload.item, { questions: [{ title: prompt, options: [23] }], extra: { original: 'Unknown original field' } })
  const f = await fixture([bad, reply()]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId), item = page.items[0]!
  expect(item).toMatchObject({ id: f.recordId(0), kind: 'assistant-message', turnId: turn, messagePhase: 'final',
    questionDiagnostic: { code: 'INVALID_AGENT_SESSION_HISTORY_PAGE' }, contentParts: [{ kind: 'text', text: JSON.stringify(bad.payload) }] })
  expect(item.questionRequest).toBeUndefined(); expect(page.items[1]?.questionAnswers?.[0]?.answer).toBe(answer)
  await f.unchanged()
})

it('does not promote function calls, tool acceptance, quotes, foreign sources or unrelated canonical events into questions', async () => {
  const foreign = event(); foreign.payload.thread_id = 'another-native'
  const missingTurn = event(); delete (missingTurn.payload as Partial<typeof missingTurn.payload>).turn_id
  const ordinary = event(); ordinary.payload.item.delivery = 'ordinary'
  const quoted = { type: 'response_item', payload: { type: 'message', id: 'quoted-event', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(event().payload) }] } }
  const rows = [tool(), result(), foreign, missingTurn, ordinary, quoted]
  const f = await fixture(rows); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toHaveLength(rows.length)
  expect(page.items.every(item => item.questionRequest === undefined && item.questionDiagnostic === undefined)).toBe(true)
  for (const index of [2, 3, 4]) expect(page.items[index]).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'text', text: JSON.stringify(rows[index]!.payload) }] })
  await f.unchanged()
})

it('preserves every canonical content part and reads deferred original text through the exact record/resource owner', async () => {
  const original = event(), text = 'Complete original question body 中🙂\n'.repeat(90_000)
  Object.assign(original.payload.item, { content: [{ type: 'Text', text }, { type: 'input_image', image_url: 'opaque:image' }, { type: 'unknown-native-part', original: 'untouched' }] })
  const f = await fixture([original]); close.push(f.close)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId), item = page.items[0]!, part = item.contentParts[0]!
  expect(item.questionRequest?.questions[0]?.id).toBe(questionId)
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw new Error('Complete body must stay an exact deferred text resource.')
  expect(await readSessionHistoryTextResource(part, 0, { source, recordId: item.id, turnId: turn }, input => f.client.sessionHistoryResource(f.session.agentSessionId, input))).toEqual({ kind: 'text', text })
  expect(item.contentParts.slice(1)).toEqual([{ kind: 'resource', resourceType: 'image', reference: 'opaque:image' }, { kind: 'text', text: '{"type":"unknown-native-part","original":"untouched"}' }])
  expect(await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: item.id, turnId: turn })).toEqual(item)
  await f.unchanged()
}, 30_000)

it('durable changes use the same canonical question projection and retain the original saved byte position', async () => {
  const f = await fixture([tool()]); close.push(f.close)
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await appendFile(f.transcriptPath, jsonl([event(), result(), reply()]))
  const change = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint })
  expect(change.items).toHaveLength(3)
  expect(change.items[0]).toMatchObject({ id: f.recordId(1), questionRequest: { delivery: 'async', questions: [{ id: questionId }] } })
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(change.items).toEqual(page.items.slice(1))
})

it('original public history/context RPC and the compiled CLI consume the repaired Provider rather than helper-only data', async () => {
  const f = await fixture([tool(), event(), result(), reply()]); close.push(f.close)
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'native' as const, limit: 100 }
  const history = await rpc.call('agent.history', input)
  const native = history.items.flatMap(record => record.kind === 'item' ? [record.item] : [])
  expect(native).toHaveLength(4); expect(native[1]).toMatchObject({ questionRequest: { questions: [{ id: questionId }] } })
  expect((await rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 100 })).native?.items).toEqual(native)
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'history', '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native', '--limit', '100'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.items).toEqual(history.items)
  await f.unchanged()
}, 30_000)

it('optional canonical question details cannot make an otherwise readable public page exceed its original byte budget', async () => {
  const { SESSION_HISTORY_MAX_PAGE_BYTES } = await import('../src/session-history.js')
  const options = Array.from({ length: 16_000 }, (_, index) => 'option-' + index)
  const rows = Array.from({ length: 12 }, (_, index) => {
    const row = event(options)
    row.payload.item.id = 'budget-question-' + index
    row.payload.item.content = [{ type: 'Text', text: 'Original complete question body ' + index }]
    row.payload.item.questions[0]!.title = 'Choose the original option ' + index
    return row
  })
  rows[0]!.payload.item.content = [{ type: 'Text', text: 'Complete original budgeted body 中🙂\n'.repeat(90_000) }]
  const f = await fixture(rows); close.push(f.close)
  const reading = f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 100 })
  await expect(reading).resolves.toHaveProperty('items')
  const page = await reading
  expect(page.items).toHaveLength(rows.length)
  expect(Buffer.byteLength(JSON.stringify({ source: page.source, items: page.items, nextCursor: page.nextCursor }))).toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)
  expect(page.items.filter(item => item.questionRequest).length).toBeGreaterThan(0)
  const withdrawn = page.items.filter(item => !item.questionRequest)
  expect(withdrawn.length).toBeGreaterThan(0)
  for (const [index, item] of page.items.entries()) {
    expect(item.id).toBe(f.recordId(index))
    if (index > 0) expect(item.contentParts).toEqual([{ kind: 'text', text: rows[index]!.payload.item.content[0]!.text }])
  }
  for (const item of withdrawn) {
    expect(item.questionDiagnostic).toMatchObject({ code: 'CODEX_QUESTION_REQUEST_DETAILS_UNAVAILABLE' })
    const exact = await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: item.id, turnId: turn })
    expect(exact.contentParts).toEqual(item.contentParts)
    expect(exact.questionRequest?.questions[0]?.options).toHaveLength(options.length)
  }
  const originalResource = page.items[0]!.contentParts[0]!
  if (originalResource.kind !== 'resource' || originalResource.resourceType !== 'text') throw new Error('The original deferred body must remain a resource.')
  expect(await readSessionHistoryTextResource(originalResource, 0, { source, recordId: page.items[0]!.id, turnId: turn }, input => f.client.sessionHistoryResource(f.session.agentSessionId, input)))
    .toEqual({ kind: 'text', text: rows[0]!.payload.item.content[0]!.text })
  await f.unchanged()
}, 30_000)

it('a single oversized question projection keeps the complete original record across page, exact record and durable changes', async () => {
  const options = Array.from({ length: 150_000 }, (_, index) => 'option-' + index)
  const original = event(options)
  const f = await fixture([]); close.push(f.close)
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await appendFile(f.transcriptPath, jsonl([original]))
  const reading = f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  await expect(reading).resolves.toHaveProperty('items')
  const page = await reading, item = page.items[0]!
  expect(item.id).toBe(f.recordId(0)); expect(item.turnId).toBe(turn)
  expect(item.questionRequest).toBeUndefined()
  expect(item.questionDiagnostic).toMatchObject({ code: 'CODEX_QUESTION_REQUEST_DETAILS_UNAVAILABLE' })
  expect(item.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(original.payload) }])
  expect(await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: item.id, turnId: turn })).toEqual(item)
  const changes = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 1 })
  expect(changes.items).toEqual(page.items)
}, 30_000)

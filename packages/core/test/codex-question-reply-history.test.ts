import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../dist/index.js'
import { readSessionHistoryTextResource } from '@agentmux/core/session-history-content'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-read-codec.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../src/types.js'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { jsonl } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})
const source = { providerId: 'codex', nativeSessionId: 'original-native' }
const reply = { questionItemId: 'original-question', question: 'Keep the original question?', answer: '  Keep alpha\n保留乙🙂  ' }
const answers = [{ questionId: reply.questionItemId, prompt: reply.question, answer: reply.answer }]
const wire = (value: unknown) => '<send_user_message_question_reply>\n' + JSON.stringify(value) + '\n</send_user_message_question_reply>'
function record(id: string, content: unknown, role = 'user', extra: Record<string, unknown> = {}) {
  return { type: 'response_item', payload: { type: 'message', id, role, turn_id: 'original-turn',
    content: typeof content === 'string' ? [{ type: 'input_text', text: content }] : content, ...extra } }
}
async function fixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-question-history-'))
  close.push(() => rm(root, { recursive: true, force: true }))
  const transcriptPath = join(root, 'original.jsonl'), storePath = join(root, 'sessions.json')
  await writeFile(transcriptPath, jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root } }, ...rows]))
  const store = new core.AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', hostId: 'local',
    providerId: 'codex', executorId: 'codex', workspacePath: root, run: { runId: 'unchanged-run' }, retiredRuns: [],
    hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath } }
  await store.compareAndSwap(null, session)
  const before = { native: await readFile(transcriptPath), durable: await readFile(storePath) }
  const client = new core.AgentMuxClient({ store }); close.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect')
  const kernel = (client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const context: AgentProviderSessionHistoryContext = { agentSessionId: session.agentSessionId,
    contentSigningSecret: session.hookToken, source, transcriptPath, workspacePath: root,
    command: 'codex', args: [], env: {}, limit: 100, signal: new AbortController().signal }
  return { root, client, session, context, async unchanged() {
    expect(await readFile(transcriptPath)).toEqual(before.native)
    expect(await readFile(storePath)).toEqual(before.durable)
    expect(connect).not.toHaveBeenCalled()
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  } }
}

async function endpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const socketPath = join(f.root, 'control.sock')
  const server = new core.AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
  return { socketPath, rpc, reference: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}

it.each(['array', 'object', 'ide'] as const)('saved Codex %s replies expose original answers while retaining complete wire and unknown authorship', async shape => {
  const text = shape === 'ide' ? '# Context from my IDE setup:\nOriginal IDE context\n## My request for Codex:\n' + wire(reply)
    : wire(shape === 'array' ? [reply] : reply)
  const f = await fixture([record('reply-record', text)])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.source).toEqual(source)
  expect(page.items).toEqual([{ id: 'reply-record', turnId: 'original-turn', kind: 'user-message',
    questionAnswers: answers, contentParts: [{ kind: 'text', text }] }])
  const projected = core.projectSessionUserMessages({ agentSessionId: f.session.agentSessionId, historyPage: page })
  expect(projected).toMatchObject([{ rawId: 'reply-record', author: { kind: 'unknown' }, content: reply.answer,
    questionAnswers: answers, source: { kind: 'native', ...source, recordId: 'reply-record' }, contentParts: [{ kind: 'text', text }] }])
  expect(projected[0]).not.toHaveProperty('deliveryStatus')
  expect(page.items[0]).not.toHaveProperty('questionRequest')
  const exact = await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: 'reply-record', turnId: 'original-turn' })
  expect(exact).toEqual(page.items[0])
  await f.unchanged()
})

it('preserves quoted, mixed, partial, unknown and partly malformed replies without inventing partial answer metadata', async () => {
  const original = wire([reply])
  const rows = [record('plain', 'Ordinary original user input'), record('quoted', 'A quoted example follows:\n' + original),
    record('partial', original.slice(0, -1)), record('bad-json', '<send_user_message_question_reply>{</send_user_message_question_reply>'),
    record('empty', wire([])), record('unknown-shape', wire({ content: 'future reply' })),
    record('partial-array', wire([reply, { questionItemId: 'other-question', question: 'Original question', answer: null }])),
    record('second-text', [{ type: 'input_text', text: original }, { type: 'input_text', text: 'Another original input' }]),
    record('image', [{ type: 'input_text', text: original }, { type: 'input_image', image_url: 'native:original-image' }]),
    record('unknown-block', [{ type: 'input_text', text: original }, { type: 'future', text: 'Unknown original block' }]),
    record('unknown-text-type', [{ type: 'future_text', text: original }]), record('assistant', original, 'assistant'),
    record('runtime-context', original, 'user', { internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } })]
  const f = await fixture(rows), page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => item.id)).toEqual(rows.map(row => row.payload.id))
  expect(page.items.every(item => item.questionAnswers === undefined && item.questionRequest === undefined)).toBe(true)
  expect(page.items[6]!.contentParts).toEqual([{ kind: 'text', text: wire([reply, { questionItemId: 'other-question', question: 'Original question', answer: null }]) }])
  expect(page.items[7]!.contentParts).toEqual([{ kind: 'text', text: original }, { kind: 'text', text: 'Another original input' }])
  expect(page.items.at(-1)).toMatchObject({ kind: 'system-message', title: 'Runtime context', contentParts: [{ kind: 'text', text: original }] })
  await f.unchanged()
})

it('keeps complete deferred native reply content readable as its original signed resource without guessing answers from its head', async () => {
  const text = wire([{ ...reply, answer: 'Original retained answer 中🙂\n'.repeat(100_000) }])
  const f = await fixture([record('deferred-reply', text)])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId), item = page.items[0]!
  expect(item.kind).toBe('user-message')
  expect(item.questionAnswers).toBeUndefined()
  const part = item.contentParts[0]!
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw new Error('The complete original reply must remain a text resource.')
  const request = { source, recordId: item.id, turnId: item.turnId!, partIndex: 0, expectedReference: part.reference }
  expect(await readSessionHistoryTextResource(part, 0, request, input => f.client.sessionHistoryResource(f.session.agentSessionId, input)))
    .toEqual({ kind: 'text', text })
  const exact = await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: item.id, turnId: item.turnId! })
  expect(exact).toEqual(item)
  await f.unchanged()
}, 30_000)

it('answer decoration keeps a previously legal long history page within its existing byte budget', async () => {
  const text = wire([{ ...reply, answer: 'x'.repeat(600_000) }])
  const f = await fixture(Array.from({ length: 4 }, (_, index) => record(`long-reply-${index}`, text)))
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 4 })
  expect(page.items).toHaveLength(4)
  expect(page.items.every(item => item.kind === 'user-message')).toBe(true)
  expect(page.items.map(item => item.contentParts)).toEqual(Array.from({ length: 4 }, () => [{ kind: 'text', text }]))
  expect(page.items.filter(item => item.questionAnswers !== undefined)).toHaveLength(2)
  const withdrawn = page.items.filter(item => item.questionAnswers === undefined)
  expect(withdrawn).toHaveLength(2)
  for (const item of withdrawn) expect(item.questionDiagnostic).toEqual({ code: 'CODEX_QUESTION_ANSWER_DETAILS_UNAVAILABLE',
    message: 'Answer details did not fit this history page’s existing byte budget. The original reply remains complete and readable/copyable.' })
  expect(Buffer.byteLength(JSON.stringify({ source: page.source, items: page.items, nextCursor: page.nextCursor })))
    .toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)
  const exact = await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: withdrawn[0]!.id, turnId: 'original-turn' })
  expect(exact.questionAnswers).toEqual([{ ...answers[0]!, answer: 'x'.repeat(600_000) }])
  expect(exact.contentParts).toEqual(withdrawn[0]!.contentParts)
  const { rpc, socketPath, reference } = await endpoint(f)
  const publicContext = await rpc.call('agent.context', { ...reference, limit: 4 })
  expect(publicContext.native?.items).toEqual(page.items)
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'context', '--host', reference.hostId,
    '--session', reference.agentSessionId, '--limit', '4'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.native.items).toEqual(page.items)
  const queryInput = { ...reference, source: 'native' as const, kind: 'user-message' as const, limit: 4,
    maxBytes: SESSION_HISTORY_MAX_PAGE_BYTES * 2 }
  const queried = await rpc.call('agent.history', queryInput)
  expect(queried.userMessages).toHaveLength(4)
  for (const item of page.items) {
    const message = queried.userMessages!.find(value => value.rawId === item.id)!
    expect(message).toMatchObject({ author: { kind: 'unknown' }, contentParts: item.contentParts })
    expect(message.questionDiagnostic).toEqual(item.questionDiagnostic)
    expect(message.questionAnswers).toEqual(item.questionAnswers)
    expect(message.content).toBe(item.questionAnswers ? item.questionAnswers[0]!.answer : text)
  }
  const malformed = structuredClone(queried), missingMessage = structuredClone(queried)
  const diagnosticMessage = malformed.userMessages!.find(value => value.questionDiagnostic)!
  Object.assign(diagnosticMessage.questionDiagnostic!, { authority: 'input' })
  expect(() => parseAgentSessionHistoryReadPage(malformed, queryInput)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const incomplete = missingMessage.userMessages!.find(value => value.questionDiagnostic)!
  Object.assign(incomplete.questionDiagnostic!, { message: null })
  expect(() => parseAgentSessionHistoryReadPage(missingMessage, queryInput)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  await f.unchanged()
}, 30_000)

it('keeps a short answer instead of withdrawing it to fund another record’s diagnostic', async () => {
  const short = wire([reply]), long = wire([{ ...reply, answer: 'b'.repeat(1_000) }])
  const originals = [
    { id: 'large-reply', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: long }] },
    { id: 'short-reply', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: short }] },
    { id: 'original-padding-one', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: '' }] },
    { id: 'original-padding-two', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: '' }] }
  ]
  const shortAnswerBytes = Buffer.byteLength(JSON.stringify({ ...originals[1], questionAnswers: answers }))
    - Buffer.byteLength(JSON.stringify(originals[1]))
  const padding = SESSION_HISTORY_MAX_PAGE_BYTES - shortAnswerBytes - 16
    - Buffer.byteLength(JSON.stringify({ source, items: originals, nextCursor: null }))
  originals[2]!.contentParts[0]!.text = 'a'.repeat(Math.floor(padding / 2))
  originals[3]!.contentParts[0]!.text = 'b'.repeat(padding - Math.floor(padding / 2))
  const f = await fixture(originals.map(item => record(item.id, item.contentParts[0]!.text)))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toEqual([originals[0], { ...originals[1], questionAnswers: answers }, originals[2], originals[3]])
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'Codex history answer details and their diagnostic did not fit the existing page budget. Original reply content is preserved.',
    { source, recordIds: ['large-reply'] })
  await f.unchanged()
}, 30_000)

it('preserves an original page with no room for optional diagnostics and reports that projection boundary without blocking the read', async () => {
  const text = wire([reply]), originals = [
    { id: 'small-reply', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text }] },
    { id: 'large-original-one', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: '' }] },
    { id: 'large-original-two', turnId: 'original-turn', kind: 'user-message', contentParts: [{ kind: 'text', text: '' }] }
  ]
  const padding = SESSION_HISTORY_MAX_PAGE_BYTES - 16 - Buffer.byteLength(JSON.stringify({ source, items: originals, nextCursor: null }))
  originals[1]!.contentParts[0]!.text = 'a'.repeat(Math.floor(padding / 2))
  originals[2]!.contentParts[0]!.text = 'b'.repeat(padding - Math.floor(padding / 2))
  const f = await fixture(originals.map(item => record(item.id, item.contentParts[0]!.text)))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 100 })
  expect(page.items).toEqual(originals)
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'Codex history answer details and their diagnostic did not fit the existing page budget. Original reply content is preserved.',
    { source, recordIds: ['small-reply'] })
  await f.unchanged()
}, 30_000)

it('public Unix history/context and compiled CLI expose readable answer queries and complete original wire without Runtime control', async () => {
  const text = wire([reply]), f = await fixture([record('older-user', 'Original task'), record('reply-record', text)])
  const { socketPath, rpc, reference } = await endpoint(f)
  const input = { ...reference, source: 'native' as const, limit: 1 }
  const first = await rpc.call('agent.history', input)
  expect(first.items).toEqual([{ kind: 'item', item: { id: 'reply-record', turnId: 'original-turn', kind: 'user-message',
    questionAnswers: answers, contentParts: [{ kind: 'text', text }] } }])
  const context = await rpc.call('agent.context', { ...reference, limit: 1 })
  expect(context.native?.items).toEqual(first.items.map(entry => entry.kind === 'item' ? entry.item : undefined))
  // The actual answer contains a newline; its JSON wire contains an escaped newline.
  const query = 'alpha\n保留', found = await rpc.call('agent.history', { ...input, kind: 'user-message', query })
  expect(found.userMessages).toMatchObject([{ rawId: 'reply-record', content: reply.answer, questionAnswers: answers,
    author: { kind: 'unknown' }, contentParts: [{ kind: 'text', text }] }])
  const args = ['--endpoint', `unix:${socketPath}`, 'agent', 'history', '--host', reference.hostId, '--session',
    reference.agentSessionId, '--source', 'native', '--limit', '1']
  const plain = await runCompiledObjectCli(args, objectCliEnvironment(f.root))
  expect(plain.code, plain.stderr).toBe(0)
  expect(JSON.parse(plain.stdout)).toMatchObject({ ok: true, operation: 'agent.history', result: { items: first.items } })
  const queried = await runCompiledObjectCli([...args, '--kind', 'user-message', '--query', query], objectCliEnvironment(f.root))
  expect(queried.code, queried.stderr).toBe(0)
  expect(JSON.parse(queried.stdout).result.userMessages).toEqual(found.userMessages)
  const older = await rpc.call('agent.history', { ...input, cursor: first.nextCursor! })
  expect(older.items).toMatchObject([{ kind: 'item', item: { id: 'older-user' } }])
  await f.unchanged()
})

import { appendFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../fixtures/native-history-session.js'
import { grokChunk, grokDone, grokUpdate, grokUser } from '../fixtures/grok-updates.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { NativeJsonlHistoryReader } from '../../src/native-jsonl-history-reader.js'
import * as nativeValues from '../../src/native-history-value.js'
import { encodeCwdDirname, slugify, urlencodeRfc3986 } from '../../src/providers/grok-native-history.js'
import { readSessionHistoryTextResource } from '../../src/session-history-content.js'
import type { AgentSessionHistoryItem } from '../../src/types.js'
import type { ProviderConversationChangesContext } from '../../src/session-history-changes.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.restoreAllMocks() })
const sessionId = 'native-grok'
const provider = () => new AgentProviderRegistry().get('grok')
async function fixture(rows: unknown[]) {
  const f = await nativeHistoryFixture('grok', jsonl(rows), { relativePath: 'updates.jsonl', nativeSessionId: sessionId })
  await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id: sessionId, cwd: f.root } }))
  const context = { agentSessionId: f.session.agentSessionId, source: { providerId: 'grok', nativeSessionId: sessionId },
    transcriptPath: f.path, command: 'grok', args: [], env: {}, workspacePath: f.root, limit: 100, signal: new AbortController().signal }
  return { ...f, context, changes: (extra: Partial<ProviderConversationChangesContext> = {}) => provider().readConversationChanges!({ ...context, ...extra }) }
}
const body = (item: { contentParts: unknown[] }) => (item.contentParts as Array<{ kind: string; text?: string }>).filter(p => p.kind === 'text').map(p => p.text).join('')

it('matches native RFC3986 and BLAKE3 directory addressing without scanning sessions', () => {
  expect(urlencodeRfc3986("/repo!'()*中文")).toBe('%2Frepo%21%27%28%29%2A%E4%B8%AD%E6%96%87')
  expect(slugify('Hello World!', 40)).toBe('hello-world')
  expect(encodeCwdDirname('/' + 'a'.repeat(252))).toBe('%2F' + 'a'.repeat(252))
  expect(encodeCwdDirname('/' + 'a'.repeat(253))).toMatch(/^a{40}-[0-9a-f]{16}$/u)
  expect(provider().readSessionHistoryPage).toBeTypeOf('function')
  expect(provider().observeSessionHistory).toBeTypeOf('function')
  expect(provider().readConversationChanges).toBeTypeOf('function')
})

it('one native success terminal assembles exact chunks across pages and persisted mode/hook metadata, not agent_result', async () => {
  const f = await fixture([grokUser(sessionId, 'Original question'), grokChunk(sessionId, 'Hello '),
    grokUpdate(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'chat' }),
    grokChunk(sessionId, '完整🙂'), grokUpdate(sessionId, { sessionUpdate: 'hook_annotation', message: 'Done hook' }, 'prompt-1', '_x.ai/session/update'), grokDone(sessionId)])
  fixtures.push(f)
  const head = await f.changes({ head: true })
  expect(head.items).toEqual([])
  let cursor = head.cursor
  const versions = new Map<string, AgentSessionHistoryItem>()
  for (let i = 0; i < 6; i++) {
    const page = await f.changes({ after: cursor, limit: 1 }); cursor = page.cursor
    for (const item of page.items.filter(item => item.kind === 'assistant-message')) versions.set(item.id, item)
  }
  const finals = [...versions.values()]
  expect(finals).toHaveLength(1)
  expect(finals[0]).toMatchObject({ messagePhase: 'final', turnId: 'prompt-1', startedAt: 2000,
    contentParts: [{ kind: 'text', text: 'Hello 完整🙂', contentEligibility: 'public' }] })
  expect((await f.changes({ after: cursor })).items).toEqual([])
  const history = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(history.items.filter(item => item.kind === 'assistant-message')).toEqual(finals)
  expect(body(history.items[0]!)).toBe('Original question')
  expect(history.items[0]!.contentParts[0]).toMatchObject({ contentEligibility: 'unconfirmed' })
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('keeps pre-tool narration and interrupted public text as progress without manufacturing finals', async () => {
  const noPrompt = grokChunk(sessionId, 'missing identity'); delete (noPrompt.params._meta as Partial<typeof noPrompt.params._meta>).promptId
  const error = grokDone(sessionId, 'error', 'error'); error.params.update.agent_result = 'private backend error'
  const f = await fixture([
    grokChunk(sessionId, 'Pre-tool narration', 'tool'), grokUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read', rawInput: {} }, 'tool'), grokDone(sessionId, 'tool'),
    grokChunk(sessionId, 'Cancelled partial', 'cancel'), grokDone(sessionId, 'cancel', 'cancelled'),
    grokChunk(sessionId, 'Error partial', 'error'), error,
    grokChunk(sessionId, 'Other prompt', 'other'), grokDone(sessionId, 'wrong'), noPrompt, grokDone(sessionId),
    grokDone(sessionId, 'empty')
  ]); fixtures.push(f)
  const changes = await f.changes()
  const speech = changes.items.filter(item => item.kind === 'assistant-message')
  expect(speech.map(body)).toEqual(['Pre-tool narration', 'Cancelled partial', 'Error partial', 'Other prompt'])
  expect(speech.every(item => item.messagePhase === 'progress')).toBe(true)
  expect(changes.items.filter(item => item.kind === 'activity').length).toBeGreaterThan(5)
})

it('keeps host turns/model frames, thought/tool/unknown payloads outside ordinary public speech', async () => {
  const host = grokChunk(sessionId, 'host private'); host.params.update._meta = { hostTurn: true }
  const interjection = grokUser(sessionId, '<model frame>private setup</model frame>')
  interjection.params.update.content = { type: 'text', text: '<model frame>private setup</model frame>', _meta: { displayText: 'Visible original input' } }
  const f = await fixture([interjection, host, grokDone(sessionId),
    grokUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } }),
    grokUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'original', rawOutput: { private: true } }),
    grokUpdate(sessionId, { sessionUpdate: 'future_variant', data: 'unknown private' })]); fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(body(page.items[0]!)).toBe('Visible original input')
  expect(page.items.filter(item => item.kind === 'assistant-message')).toEqual([])
  expect(page.items[1]!.contentParts[0]).toMatchObject({ contentEligibility: 'private' })
  expect(page.items[3]!.contentParts[0]).toMatchObject({ kind: 'reasoning', contentEligibility: 'private' })
  expect(page.items[4]!.contentParts[0]).toMatchObject({ kind: 'tool-result', contentEligibility: 'unconfirmed' })
})

it('head/tail are cut-only and an unfinished final retains the original cursor until its newline', async () => {
  const f = await fixture([grokChunk(sessionId, 'First complete answer')]); fixtures.push(f)
  const first = await f.changes({ tail: true })
  expect(first.items).toEqual([])
  const terminal = JSON.stringify(grokDone(sessionId))
  await appendFile(f.path, terminal.slice(0, -1))
  const partial = await f.changes({ after: first.cursor })
  expect(partial.items).toEqual([]); expect(partial.cursor).toBe(first.cursor)
  await appendFile(f.path, '}\n')
  const complete = await f.changes({ after: partial.cursor })
  expect(complete.items).toHaveLength(1); expect(body(complete.items[0]!)).toBe('First complete answer')
  await writeFile(join(f.root, 'chat_history.jsonl'), '{"type":"assistant","content":"raw rewrite canary"}\n')
  expect((await f.changes({ after: complete.cursor })).items).toEqual([])
  const oldPath = { ...f.context, transcriptPath: join(f.root, 'chat_history.jsonl') }
  await expect(provider().readSessionHistoryPage!(oldPath)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('foreign summary/session, rewritten source and logical rewind refuse the original source instead of advancing it', async () => {
  const f = await fixture([grokChunk(sessionId, 'Before'), grokDone(sessionId)]); fixtures.push(f)
  const checkpoint = await f.changes({ tail: true })
  await appendFile(f.path, jsonl([grokUpdate(sessionId, { sessionUpdate: 'rewind_marker', target_prompt_index: 0 }, 'prompt-1', '_x.ai/session/update')]))
  await expect(f.changes({ after: checkpoint.cursor })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id: 'foreign', cwd: f.root } }))
  await expect(f.changes()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id: sessionId, cwd: f.root } }))
  const replacement = join(f.root, 'replacement')
  await writeFile(replacement, jsonl([grokChunk(sessionId, 'Replacement'), grokDone(sessionId)])); await rename(replacement, f.path)
  await expect(f.changes({ after: checkpoint.cursor })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await writeFile(f.path, jsonl([grokChunk('foreign', 'Foreign source')]))
  await expect(f.changes()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('assembles hundreds of original chunks across physical blocks and earlier polls only once at the terminal boundary', async () => {
  const parts = Array.from({ length: 720 }, (_, index) => `[${index}] Original 中文🙂 chunk with enough text to cross native blocks. `)
  const f = await fixture(parts.slice(0, 500).map(text => grokChunk(sessionId, text, 'long-original'))); fixtures.push(f)
  let physicalBytes = 0, readingPredecessor = false
  const originalBefore = NativeJsonlHistoryReader.prototype.readBefore
  vi.spyOn(NativeJsonlHistoryReader.prototype, 'readBefore').mockImplementation(async function (this: NativeJsonlHistoryReader, start) {
    readingPredecessor = true
    try { return await originalBefore.call(this, start) } finally { readingPredecessor = false }
  })
  const originalOpen = NativeJsonlHistoryReader.open.bind(NativeJsonlHistoryReader)
  vi.spyOn(NativeJsonlHistoryReader, 'open').mockImplementation(async (...args) => {
    const reader = await originalOpen(...args)
    const file = Reflect.get(reader, 'file') as { read(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown> }
    const read = file.read.bind(file)
    vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => { if (readingPredecessor) physicalBytes += readArgs[2]; return read(...readArgs) })
    return reader
  })
  const cut = await f.changes({ tail: true })
  await appendFile(f.path, jsonl([...parts.slice(500).map(text => grokChunk(sessionId, text, 'long-original')), grokDone(sessionId, 'long-original')]))
  let cursor = cut.cursor, finals: Array<{ kind: string; contentParts: unknown[] }> = []
  for (let page = 0; page < 3; page++) {
    const next = await f.changes({ after: cursor }); cursor = next.cursor
    finals.push(...next.items.filter(item => item.kind === 'assistant-message'))
    if (!next.more) break
  }
  expect(finals).toHaveLength(1)
  expect(body(finals[0]!)).toBe(parts.join(''))
  expect((await f.changes({ after: cursor })).items).toEqual([])
  const history = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(body(history.items[0]!)).toBe(parts.join(''))
  // Measure only this new predecessor operation; the unchanged generic forward
  // scanner has its own bounded block reads. Terminal-only assembly stays linear.
  expect(physicalBytes).toBeLessThan((await stat(f.path)).size * 12)
}, 30000)

it.each(['unknown', 'missing-prompt', 'non-text'] as const)('an ambiguous %s group member never turns the known suffix into a truncated public final', async kind => {
  const middle = kind === 'unknown' ? grokUpdate(sessionId, { sessionUpdate: 'future_variant' })
    : kind === 'non-text' ? grokUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'opaque' } })
    : grokChunk(sessionId, 'Unassociated chunk')
  if (kind === 'missing-prompt') delete (middle.params._meta as Partial<typeof middle.params._meta>).promptId
  const f = await fixture([grokChunk(sessionId, 'Original prefix'), middle, grokChunk(sessionId, 'Known suffix'), grokDone(sessionId)]); fixtures.push(f)
  for (const page of [await f.changes(), await f.client.sessionHistoryPage(f.session.agentSessionId)]) {
    const speech = page.items.filter(item => item.kind === 'assistant-message')
    expect(speech.map(body)).toEqual(['Original prefix', 'Known suffix'])
    expect(speech.every(item => item.messagePhase === 'progress')).toBe(true)
  }
})


it('updates one stable public message while the same turn continues, then finalizes it without repeating text', async () => {
  const f = await fixture([grokUser(sessionId, 'Question'), grokChunk(sessionId, 'Checking ')]); fixtures.push(f)
  const initial = await f.client.sessionHistoryPage(f.session.agentSessionId), speech = initial.items.find(item => item.kind === 'assistant-message')!
  expect(speech).toBeDefined()
  expect(speech).toMatchObject({ messagePhase: 'progress', turnId: 'prompt-1' }); expect(body(speech)).toBe('Checking ')
  const cut = await f.changes({ tail: true })
  await appendFile(f.path, jsonl([grokChunk(sessionId, 'the files.'), grokDone(sessionId)]))
  const changed = await f.changes({ after: cut.cursor })
  expect(changed.items.filter(item => item.kind === 'assistant-message')).toHaveLength(1)
  expect(changed.items[0]).toMatchObject({ id: speech.id, messagePhase: 'final', turnId: 'prompt-1' })
  expect(body(changed.items[0]!)).toBe('Checking the files.')
  const fresh = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(fresh.items.filter(item => item.kind === 'assistant-message')).toEqual(changed.items)
  const exact = await provider().readSessionHistoryRecord!({ ...f.context, recordId: speech.id, turnId: 'prompt-1' })
  expect(exact).toEqual(changed.items[0])
})

it('retains tool, thought, unknown and prompt boundaries while progressively reading a single-item cursor', async () => {
  const rows = [grokUser(sessionId, 'Question'), grokChunk(sessionId, 'Before '), grokChunk(sessionId, 'tool'),
    grokUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read', rawInput: {} }),
    grokUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thinking' } }),
    grokChunk(sessionId, 'Final '), grokChunk(sessionId, 'answer'), grokDone(sessionId)]
  const f = await fixture(rows); fixtures.push(f)
  const head = await f.changes({ head: true }), items = new Map<string, AgentSessionHistoryItem>()
  let cursor = head.cursor, finished = false
  for (let count = 0; count < rows.length; count++) {
    const page = await f.changes({ after: cursor, limit: 1 })
    expect(page.items).toHaveLength(1); expect(page.cursor).not.toBe(cursor); cursor = page.cursor
    for (const item of page.items) items.set(item.id, item)
    if (!page.more) { finished = true; break }
  }
  expect(finished).toBe(true)
  const all = [...items.values()], speech = all.filter(item => item.kind === 'assistant-message')
  expect(speech.map(item => [body(item), item.messagePhase])).toEqual([['Before tool', 'progress'], ['Final answer', 'final']])
  expect(all.flatMap(item => item.contentParts).some(part => part.kind === 'tool-call' && part.callId === 'call')).toBe(true)
  expect(all.flatMap(item => item.contentParts).some(part => part.kind === 'reasoning' && part.text === 'private thinking')).toBe(true)
  expect((await f.client.sessionHistoryPage(f.session.agentSessionId)).items).toEqual(all)
})

it('keeps frozen history and original chunk and terminal references readable when ordinary chunks accumulate into a large resource', async () => {
  const pieces = Array.from({ length: 8 }, () => '中🙂 '.repeat(80000)), prefix = pieces.join(''), suffix = ' Original suffix 末尾🙂'.repeat(7000)
  const rows = [grokUser(sessionId, 'Question'), ...pieces.map(text => grokChunk(sessionId, text)), grokChunk(sessionId, suffix)]
  const f = await fixture(rows); fixtures.push(f)
  const live = (await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })).items[0]!
  expect(live).toMatchObject({ kind: 'assistant-message', messagePhase: 'progress' })
  const cut = await f.changes({ tail: true })
  await appendFile(f.path, jsonl([grokDone(sessionId)]))
  const changes = await f.changes({ after: cut.cursor })
  expect(changes.items).toHaveLength(1)
  expect(changes.items[0]).toMatchObject({ id: live.id, messagePhase: 'final' })
  const firstOffset = Buffer.byteLength(jsonl(rows.slice(0, 1))),
    secondOffset = Buffer.byteLength(jsonl(rows.slice(0, 2))), terminalOffset = Buffer.byteLength(jsonl(rows))
  const read = (offset: number) => provider().readSessionHistoryRecord!({ ...f.context, recordId: `grok-update:${offset}` })
  const group = await read(firstOffset), originalChunk = await read(secondOffset), terminal = await read(terminalOffset)
  expect(group).toMatchObject({ id: `grok-update:${firstOffset}`, messagePhase: 'final', turnId: 'prompt-1' })
  expect(originalChunk).toMatchObject({ id: `grok-update:${secondOffset}`, kind: 'activity' })
  expect(terminal).toMatchObject({ id: `grok-update:${terminalOffset}`, messagePhase: 'final', turnId: 'prompt-1' })
  for (const item of [live, group, terminal]) {
    const part = item.contentParts[0]!
    expect(part.kind).toBe('resource')
    if (part.kind !== 'resource') throw new Error('Expected original text resource')
    const full = await readSessionHistoryTextResource(part, 0, { source: f.context.source, recordId: item.id, turnId: item.turnId },
      input => f.client.sessionHistoryResource(f.session.agentSessionId, input))
    expect(full).toMatchObject({ kind: 'text', text: prefix + suffix })
  }
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  await appendFile(f.path, jsonl([grokUser(sessionId, 'Later question', 'later'), grokChunk(sessionId, 'Later answer', 'later')]))
  const older = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1, cursor: page.nextCursor! })
  expect(older.items.map(body)).toEqual(['Question'])
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
}, 60000)


it('materializes one final group version per page even when native metadata alternates with hundreds of chunks', async () => {
  const rows: unknown[] = [grokUser(sessionId, 'Question')]
  for (let index = 0; index < 500; index++) rows.push(grokChunk(sessionId, `[${index}]`),
    grokUpdate(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'chat' }))
  rows.push(grokDone(sessionId))
  const f = await fixture(rows); fixtures.push(f)
  const materialize = vi.spyOn(NativeJsonlHistoryReader.prototype, 'materializeItem')
  const joined = vi.spyOn(nativeValues, 'nativeTextJoin')
  let cursor = (await f.changes({ head: true })).cursor, pages = 0
  const speech = new Map<string, AgentSessionHistoryItem>()
  for (; pages < 10; pages++) {
    const before = materialize.mock.calls.length, joinsBefore = joined.mock.calls.length, page = await f.changes({ after: cursor, limit: 100 })
    const bodies = materialize.mock.calls.slice(before).filter(([item]) => item.kind === 'assistant-message')
    expect(bodies).toHaveLength(1)
    expect(joined.mock.calls.length - joinsBefore).toBe(1)
    for (const item of page.items.filter(item => item.kind === 'assistant-message')) speech.set(item.id, item)
    expect(new Set(page.items.map(item => item.id)).size).toBe(page.items.length)
    cursor = page.cursor
    if (!page.more) break
  }
  expect(pages).toBeLessThan(10)
  expect(speech.size).toBe(1)
  expect([...speech.values()][0]).toMatchObject({ messagePhase: 'final' })
  expect(body([...speech.values()][0]!)).toBe(Array.from({ length: 500 }, (_, index) => `[${index}]`).join(''))
  joined.mockClear()
  const readBefore = vi.spyOn(NativeJsonlHistoryReader.prototype, 'readBefore')
  let historyCursor: string | undefined, historySpeech = 0, historyPages = 0
  do {
    const page = await provider().readSessionHistoryPage!({ ...f.context, cursor: historyCursor, limit: 100 })
    historySpeech += page.items.filter(item => item.kind === 'assistant-message').length
    historyCursor = page.nextCursor ?? undefined; historyPages++
  } while (historyCursor && historyPages < 10)
  expect(historyCursor).toBeUndefined()
  expect(historySpeech).toBe(1)
  expect(joined).toHaveBeenCalledTimes(1)
  expect(readBefore.mock.calls.length).toBeLessThan(rows.length * 3)
  joined.mockClear(); readBefore.mockClear(); historyCursor = undefined
  for (let index = 0; index < 5; index++) {
    const page = await provider().readSessionHistoryPage!({ ...f.context, cursor: historyCursor, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.kind).toBe('activity')
    historyCursor = page.nextCursor!
  }
  expect(joined).not.toHaveBeenCalled()
  expect(readBefore.mock.calls.length).toBeLessThanOrEqual(rows.length + 10)
}, 60000)

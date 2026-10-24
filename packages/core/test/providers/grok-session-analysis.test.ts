import { appendFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../fixtures/native-history-session.js'
import { grokChunk, grokDone, grokUpdate, grokUser } from '../fixtures/grok-updates.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { NativeJsonlHistoryReader } from '../../src/native-jsonl-history-reader.js'
import { encodeCwdDirname, slugify, urlencodeRfc3986 } from '../../src/providers/grok-native-history.js'
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
  let cursor = head.cursor, finals: unknown[] = []
  for (let i = 0; i < 6; i++) {
    const page = await f.changes({ after: cursor, limit: 1 }); cursor = page.cursor
    finals.push(...page.items.filter(item => item.kind === 'assistant-message'))
  }
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

it('does not resurrect pre-tool narration, cancelled/error text or mismatched/missing prompt chunks as a final', async () => {
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
  expect(changes.items.filter(item => item.kind === 'assistant-message')).toEqual([])
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
})

it.each(['unknown', 'missing-prompt', 'non-text'] as const)('an ambiguous %s group member never turns the known suffix into a truncated public final', async kind => {
  const middle = kind === 'unknown' ? grokUpdate(sessionId, { sessionUpdate: 'future_variant' })
    : kind === 'non-text' ? grokUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'opaque' } })
    : grokChunk(sessionId, 'Unassociated chunk')
  if (kind === 'missing-prompt') delete (middle.params._meta as Partial<typeof middle.params._meta>).promptId
  const f = await fixture([grokChunk(sessionId, 'Original prefix'), middle, grokChunk(sessionId, 'Known suffix'), grokDone(sessionId)]); fixtures.push(f)
  expect((await f.changes()).items.filter(item => item.kind === 'assistant-message')).toEqual([])
  expect((await f.client.sessionHistoryPage(f.session.agentSessionId)).items.filter(item => item.kind === 'assistant-message')).toEqual([])
})

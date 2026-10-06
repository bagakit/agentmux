import { fixtureClock, fixtureDay } from './helpers/fixture-values.js'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())) })
async function fixture(data: string | Buffer) {
  const value = await nativeHistoryFixture('claude', data); fixtures.push(value); return value
}
const record = (uuid: string, type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  sessionId: 'native-main', uuid, type, message: { role: type, content }, ...extra
})

it('reads only the original main Claude image resource with exact UUID, turn and part identity', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
  const f = await fixture(jsonl([
    record('original-image', 'user', [{ type: 'text', text: 'Keep original prose' }, image(png)], { user_message_uuid: 'original-turn' }),
    record('original-image', 'user', [image('foreign-image')], { user_message_uuid: 'original-turn', isSidechain: true }),
    { type: 'queue-operation', operation: 'enqueue' }
  ]))
  const request = { source: { providerId: 'claude', nativeSessionId: 'native-main' }, recordId: 'original-image', turnId: 'original-turn', partIndex: 1, expectedReference: `data:image/png;base64,${png}` }
  const result = await f.client.sessionHistoryResource('private-agent', request)
  expect(result).toMatchObject({ source: request.source, recordId: request.recordId, turnId: request.turnId, partIndex: request.partIndex,
    reference: request.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: png } })
  for (const patch of [{ recordId: 'missing-record' }, { turnId: 'foreign-turn' }]) {
    await expect(f.client.sessionHistoryResource('private-agent', { ...request, ...patch })).rejects.toHaveProperty('code', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
  }
  await expect(f.client.sessionHistoryResource('private-agent', { ...request, partIndex: 0 })).rejects.toHaveProperty('code', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls).toHaveLength(6); for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('the actual resource CLI consumes the built-in Claude exact reader and original receipt', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const f = await fixture(jsonl([record('cli-image', 'user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }])]))
  const request = { hostId: 'local', agentSessionId: 'private-agent', source: { providerId: 'claude', nativeSessionId: 'native-main' }, recordId: 'cli-image', partIndex: 0, expectedReference: `data:image/png;base64,${png}` }
  const socket = join(f.root, 'resource.sock'), input = join(f.root, 'resource.json')
  await writeFile(input, JSON.stringify(request))
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: f.client }] }, socket)
  await server.start()
  try {
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const child = spawn(process.execPath, [process.env.AGENTMUX_IMAGE_CLI ?? join(import.meta.dirname, '../dist/agentmux.js'), '--endpoint', `unix:${socket}`, 'agent', 'history', 'resource', '--input', input], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const deadline = setTimeout(() => { child.kill(); reject(new Error('Private resource CLI did not finish.')) }, 10000)
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(deadline); reject(error) }); child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
    })
    expect(output.code, output.stderr).toBe(0); expect(output.stderr).toBe('')
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, operation: 'agent.history.resource', result: { hostId: 'local', agentSessionId: 'private-agent', source: request.source, recordId: 'cli-image', partIndex: 0, reference: request.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: png } } })
    expect(await f.bytes()).toEqual(f.before)
    expect(f.controls).toHaveLength(6); for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await server.stop() }
})

it('omits sidechain entries even when they carry the main native Session ID', async () => {
  const f = await fixture(jsonl([
    record('main-user', 'user', 'main user'),
    record('same-id-child', 'assistant', 'child body', { isSidechain: true }),
    record('main-answer', 'assistant', 'main answer')
  ]))
  expect((await f.client.sessionHistoryPage('private-agent')).items.map((item) => item.id)).toEqual(['main-user', 'main-answer'])
})

it('reads main Claude pages with exact UUIDs and ordered resources, excluding sidechains without Run or file changes', async () => {
  const f = await fixture(jsonl([
    record('user-1', 'user', '  exact first\n', { timestamp: fixtureDay(1) + "T" + fixtureClock(1, 2, 3) + "Z" }),
    record('assistant-1', 'assistant', [{ type: 'text', text: 'answer' }]),
    record('child-1', 'assistant', 'never parent history', { sessionId: 'child-native', isSidechain: true }),
    record('tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'actual tool output' }]),
    record('latest', 'user', [{ type: 'text', text: 'before ' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } },
      { type: 'text', text: ' after 中' }])
  ]))
  const first = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
  expect(first.source).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  expect(first.items.map((item) => [item.id, item.kind])).toEqual([['tool-result', 'activity'], ['latest', 'user-message']])
  expect(first.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'before ' },
    { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,cGlj' },
    { kind: 'text', text: ' after 中' }])
  expect(first.items[0]!.contentParts).toEqual([{ kind: 'tool-result', output: 'actual tool output', callId: 'tool-1' }])
  const older = await f.client.sessionHistoryPage('private-agent', { limit: 2, cursor: first.nextCursor! })
  expect(older.items.map((item) => item.id)).toEqual(['user-1', 'assistant-1'])
  expect(older.items[0]!.startedAt).toBe(Date.parse(fixtureDay(1) + "T" + fixtureClock(1, 2, 3) + "Z"))
  expect(older.nextCursor).toBeNull()
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls).toHaveLength(6)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('preserves neutral unknown activity and missing time, while keeping mixed tool records out of human speech', async () => {
  const f = await fixture(jsonl([
    { type: 'future-native-event', uuid: 'unknown', sessionId: 'native-main', detail: 'kept', timestamp: 'not-a-date' },
    record('tool', 'assistant', [{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'a' } }])
  ]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map((item) => item.kind)).toEqual(['activity', 'activity'])
  expect(page.items[0]!.contentParts[0]).toEqual({ kind: 'text', text: JSON.stringify({ type: 'future-native-event', uuid: 'unknown', sessionId: 'native-main', detail: 'kept', timestamp: 'not-a-date' }) })
  expect(page.items[0]).not.toHaveProperty('startedAt')
  expect(page.items[1]!.contentParts).toEqual([{ kind: 'tool-call', name: 'read', input: '{"path":"a"}', callId: 'call' }])
})

it('keeps synthetic and compaction summary user records neutral instead of assigning a human speaker', async () => {
  const f = await fixture(jsonl([
    record('meta', 'user', 'generated context', { isMeta: true }),
    record('summary', 'user', 'persisted compaction summary', { isCompactSummary: true }),
    record('synthetic', 'user', 'generated instruction', { isSynthetic: true })
  ]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map((item) => [item.id, item.kind])).toEqual([['meta', 'activity'], ['summary', 'activity'], ['synthetic', 'activity']])
  expect(page.items.map((item) => item.contentParts)).toEqual([
    [{ kind: 'text', text: 'generated context' }], [{ kind: 'text', text: 'persisted compaction summary' }],
    [{ kind: 'text', text: 'generated instruction' }]
  ])
})

it('keeps long UTF8 records complete across range chunks and excludes a partial final append without repair', async () => {
  const exact = 'x'.repeat(65_500) + '中'.repeat(50)
  const complete = jsonl([record('long', 'assistant', exact)])
  const f = await fixture(Buffer.concat([Buffer.from(complete + '{"type":"user","text":"'), Buffer.from([0xe4, 0xb8])]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: exact }])
  expect(await f.bytes()).toEqual(f.before)
})

it('refuses a different main native Session or a missing exact locator', async () => {
  const wrong = await fixture(jsonl([record('other', 'user', 'wrong', { sessionId: 'another-main' })]))
  await expect(wrong.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const missing = await fixture(jsonl([record('one', 'user', 'body')]))
  const session = (await loadAgentSessions(missing.store))[0]!
  await missing.store.compareAndSwap(session, { ...session, updatedAt: 2,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main' } })
  await expect(missing.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
})

it('scans skipped sidechain records without an IO quota and still cancels on disposal', async () => {
  const large = await fixture(jsonl(Array.from({ length: 70 }, (_, index) => record(`side-${index}`, 'assistant', 'x'.repeat(64 * 1024), { isSidechain: true }))))
  const page = await large.client.sessionHistoryPage('private-agent')
  expect(page.items).toEqual([]); expect(page.nextCursor).toBeNull()
  const after = await large.bytes()
  expect(after.native.length).toBeGreaterThan(SESSION_HISTORY_MAX_PAGE_BYTES)
  expect(after.native.equals(large.before.native)).toBe(true)
  expect(after.store.length).toBeGreaterThan(0)
  expect(after.store.equals(large.before.store)).toBe(true)
  const f = await fixture(jsonl([record('one', 'user', 'existing')]))
  const pending = f.client.sessionHistoryPage('private-agent')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
  await f.client.dispose(); await rejected
})


const queued = (uuid: string, prompt: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'attachment', uuid, sessionId: 'native-main', isSidechain: false,
  timestamp: fixtureDay(8) + "T" + fixtureClock(9, 5, 46, "815") + "Z",
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt',
    source_uuid: 'original-command', delivery_id: 'original-delivery', origin: { kind: 'human' }, humanTurn: true },
  renderedRole: 'system', rendered: [{ content: 'Native system wrapper, not the input body.' }], ...extra
})

it('reads accepted Claude mid-turn prompts as original speech in source order, preserving equal bodies and native IDs', async () => {
  const body = '  什么情况了?\n'
  const f = await fixture(jsonl([
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'native-main', content: body },
    record('before', 'assistant', 'before'), queued('accepted-1', body),
    record('between', 'assistant', 'between'), queued('accepted-2', body),
    { type: 'queue-operation', operation: 'remove', sessionId: 'native-main', content: body, reason: 'absorbed_mid_turn' }
  ]))
  const page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items.map(item => item.kind)).toEqual(['activity', 'assistant-message', 'user-message', 'assistant-message', 'user-message', 'activity'])
  const inputs = page.items.filter(item => item.kind === 'user-message')
  expect(inputs.map(item => item.id)).toEqual(['accepted-1', 'accepted-2'])
  expect(inputs.map(item => item.contentParts)).toEqual([[{ kind: 'text', text: body }], [{ kind: 'text', text: body }]])
  expect(inputs.map(item => item.title)).toEqual(['运行中追加', '运行中追加'])
  expect(inputs.map(item => item.startedAt)).toEqual([Date.parse(fixtureDay(8) + "T" + fixtureClock(9, 5, 46, "815") + "Z"), Date.parse(fixtureDay(8) + "T" + fixtureClock(9, 5, 46, "815") + "Z")])
  expect(inputs.every(item => item.turnId === undefined)).toBe(true)
  expect(await f.bytes()).toEqual(f.before)
})

it('keeps queue bookkeeping, unknown modes, malformed prompts and generated/child records out of accepted speech without discarding originals', async () => {
  const values = [
    queued('shell', 'shell text', { attachment: { type: 'queued_command', prompt: 'shell text', commandMode: 'bash' } }),
    queued('unknown-mode', 'future mode', { attachment: { type: 'queued_command', prompt: 'future mode', commandMode: 'future' } }),
    queued('non-string', { text: 'future payload' }),
    queued('not-queued', 'wrong type', { attachment: { type: 'future', prompt: 'wrong type', commandMode: 'prompt' } }),
    queued('synthetic-input', 'generated', { isSynthetic: true }),
    queued('meta-input', 'generated', { isMeta: true }),
    queued('compact-input', 'generated', { isCompactSummary: true }),
    queued('child-input', 'child', { isSidechain: true }),
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'native-main', content: 'not yet received' }
  ]
  const f = await fixture(jsonl(values)), page = await f.client.sessionHistoryPage('private-agent')
  expect(page.items).toHaveLength(values.length - 1)
  expect(page.items.every(item => item.kind === 'activity')).toBe(true)
  expect(page.items.map(item => item.contentParts)).toEqual(values.filter(item => !('isSidechain' in item && item.isSidechain)).map(item => [{ kind: 'text', text: JSON.stringify(item) }]))
})

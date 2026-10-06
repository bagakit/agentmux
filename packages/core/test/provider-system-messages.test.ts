import { fixtureEpoch as _tailRefreshFixtureEpoch } from "./helpers/fixture-values.js"
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../dist/index.js'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import { NativeText } from '../src/native-history-value.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryContext } from '../src/types.js'
import { jsonl } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

async function fixture(providerId: 'codex' | 'claude', rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-system-history-'))
  close.push(() => rm(root, { recursive: true, force: true }))
  const transcriptPath = join(root, 'native.jsonl'), storePath = join(root, 'sessions.json')
  await writeFile(transcriptPath, jsonl(providerId === 'codex'
    ? [{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, ...rows] : rows))
  const store = new core.AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-agent', hostId: 'local',
    providerId, executorId: providerId, workspacePath: root, run: { runId: 'unchanged-run' }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-main', transcriptPath } }
  await store.compareAndSwap(null, session)
  const before = { native: await readFile(transcriptPath), durable: await readFile(storePath) }
  const client = new core.AgentMuxClient({ store })
  close.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect')
  const kernel = (client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const context: AgentProviderSessionHistoryContext = { agentSessionId: session.agentSessionId,
    contentSigningSecret: session.hookToken, source: { providerId, nativeSessionId: 'native-main' },
    transcriptPath, workspacePath: root, command: providerId, args: [], env: {}, limit: 100, signal: new AbortController().signal }
  return { root, client, session, context, async unchanged() {
    expect(await readFile(transcriptPath)).toEqual(before.native)
    expect(await readFile(storePath)).toEqual(before.durable)
    expect(connect).not.toHaveBeenCalled()
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  } }
}

function codex(id: string, role: string, content: unknown, metadata?: unknown) {
  return { type: 'response_item', payload: { type: 'message', id, role, turn_id: 'native-turn',
    content: typeof content === 'string' ? [{ type: 'input_text', text: content }] : content,
    ...(metadata === undefined ? {} : { internal_chat_message_metadata_passthrough: metadata }) } }
}
function claude(uuid: string, type: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { sessionId: 'native-main', uuid, type, message: { role: type, content }, ...extra }
}

it('Codex classifies only native system roles and exclusively known structured context kinds, retaining complete original parts', async () => {
  const exact = '  <environment_context>\n原始上下文 🙂\\ "quoted"\n</environment_context>\n'
  const values = [
    codex('environment', 'user', exact, { content_item_kinds: ['environments.environment_context'] }),
    codex('instructions', 'user', 'Exact instruction body', { content_item_kinds: ['agents_md.instructions'] }),
    codex('combined', 'user', [{ type: 'input_text', text: 'Instructions before\n' },
      { type: 'input_text', text: exact }], { content_item_kinds: ['agents_md.instructions', 'environments.environment_context'] }),
    codex('native-system', 'system', 'Native system body'),
    codex('native-developer', 'developer', 'Native developer body'),
    codex('xml-user', 'user', exact),
    codex('mixed-user', 'user', exact, { content_item_kinds: ['environments.environment_context', 'user_input'] }),
    codex('unknown-user', 'user', exact, { content_item_kinds: ['environments.environment_context', 'future.context'] }),
    codex('empty-user', 'user', exact, { content_item_kinds: [] }),
    codex('malformed-user', 'user', exact, { content_item_kinds: ['environments.environment_context', null] }),
    codex('string-metadata', 'user', exact, JSON.stringify({ content_item_kinds: ['agents_md.instructions'] })),
    codex('assistant', 'assistant', exact, { content_item_kinds: ['agents_md.instructions'] })
  ]
  const f = await fixture('codex', values), page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 100 })
  expect(page.items.map(item => [item.id, item.kind])).toEqual([
    ['environment', 'system-message'], ['instructions', 'system-message'], ['combined', 'system-message'],
    ['native-system', 'system-message'], ['native-developer', 'system-message'], ['xml-user', 'user-message'],
    ['mixed-user', 'user-message'], ['unknown-user', 'user-message'], ['empty-user', 'user-message'],
    ['malformed-user', 'user-message'], ['string-metadata', 'user-message'], ['assistant', 'assistant-message']
  ])
  expect(page.items.slice(0, 5).map(item => item.title)).toEqual([
    'Runtime context', 'System instructions', 'System instructions', 'System instructions', 'System instructions'
  ])
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: exact }])
  expect(page.items[2]!.contentParts).toEqual([{ kind: 'text', text: 'Instructions before\n' }, { kind: 'text', text: exact }])
  expect(core.projectSessionUserMessages({ agentSessionId: f.session.agentSessionId, historyPage: page }).map(item => item.rawId))
    .toEqual(['xml-user', 'mixed-user', 'unknown-user', 'empty-user', 'malformed-user', 'string-metadata'])
  expect(page.nextCursor).toBeNull()
  expect(JSON.stringify(page)).not.toContain('internal_chat_message_metadata_passthrough')
  await f.unchanged()
})

it('Codex leaves deferred metadata unknown instead of reading its head or interpreting user XML', async () => {
  const metadata = JSON.stringify({ content_item_kinds: ['environments.environment_context'] }) +
    ' '.repeat(SESSION_HISTORY_MAX_PAGE_BYTES / 2)
  const body = '<environment_context>Still original user input</environment_context>'
  const f = await fixture('codex', [codex('deferred-metadata', 'user', body, metadata)])
  const reader = await NativeJsonlHistoryReader.open(f.context)
  try {
    const entry = await reader.readPrevious()
    expect((entry!.value.payload as Record<string, unknown>).internal_chat_message_metadata_passthrough).toBeInstanceOf(NativeText)
  } finally { await reader.close() }
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toEqual([{ id: 'deferred-metadata', turnId: 'native-turn', kind: 'user-message',
    contentParts: [{ kind: 'text', text: body }] }])
  expect(core.projectSessionUserMessages({ agentSessionId: f.session.agentSessionId, historyPage: page }).map(item => item.content)).toEqual([body])
  await f.unchanged()
})

it('Codex pages and exact-record lookup retain the same system classification and original content', async () => {
  const body = '  Full original instructions 中🙂\n'.repeat(3000)
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmXcAAAAASUVORK5CYII='
  const reference = `data:image/png;base64,${image}`
  const f = await fixture('codex', [codex('older-user', 'user', 'Original user task'),
    codex('system-record', 'user', [{ type: 'input_text', text: body }, { type: 'input_image', image_url: reference }],
      { content_item_kinds: ['agents_md.instructions'] }),
    codex('newer-assistant', 'assistant', 'Original answer')])
  const newest = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(newest.items.map(item => item.id)).toEqual(['newer-assistant'])
  const middle = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1, cursor: newest.nextCursor! })
  expect(middle.items).toEqual([{ id: 'system-record', turnId: 'native-turn', kind: 'system-message',
    title: 'System instructions', contentParts: [{ kind: 'text', text: body }, { kind: 'resource', resourceType: 'image', reference }] }])
  const exact = await readCodexSavedSessionHistoryRecord({ ...f.context, recordId: 'system-record', turnId: 'native-turn' })
  expect(exact).toEqual(middle.items[0])
  await expect(readCodexSavedSessionHistoryRecord({ ...f.context, recordId: 'system-record', turnId: 'another-turn' }))
    .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD' })
  const resource = await f.client.sessionHistoryResource(f.session.agentSessionId, { source: middle.source,
    recordId: 'system-record', turnId: 'native-turn', partIndex: 1, expectedReference: reference })
  expect(resource.result).toEqual({ status: 'read', mimeType: 'image/png', dataBase64: image, byteLength: Buffer.from(image, 'base64').length })
  const oldest = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1, cursor: middle.nextCursor! })
  expect(oldest.items.map(item => item.id)).toEqual(['older-user'])
  // The opaque cursor may still point at the native session_meta header.
  const end = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1, cursor: oldest.nextCursor! })
  expect(end.items).toEqual([])
  expect(end.nextCursor).toBeNull()
  await f.unchanged()
})

it('Claude classifies native system messages without treating synthetic, meta or compaction records as system instructions', async () => {
  const exact = '  <environment_context>\n完整原文 🙂\n</environment_context>\n'
  const missingMessage = { sessionId: 'native-main', uuid: 'system-bookkeeping', type: 'system', subtype: 'compact_boundary' }
  const f = await fixture('claude', [claude('system', 'system', [{ type: 'text', text: exact }, { type: 'text', text: 'Second original part' }]),
    claude('system-empty', 'system', ''), claude('xml-user', 'user', exact),
    claude('meta', 'user', 'Original meta body', { isMeta: true }),
    claude('synthetic', 'user', 'Original generated body', { isSynthetic: true }),
    claude('compact', 'user', 'Original summary body', { isCompactSummary: true }),
    claude('system-meta', 'system', 'Original system meta body', { isMeta: true }),
    claude('system-synthetic', 'system', 'Original system generated body', { isSynthetic: true }),
    claude('system-compact', 'system', 'Original system summary body', { isCompactSummary: true }),
    missingMessage, { sessionId: 'native-main', uuid: 'system-no-content', type: 'system', message: { role: 'system' } },
    claude('assistant', 'assistant', 'Original assistant body')])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => [item.id, item.kind])).toEqual([
    ['system', 'system-message'], ['system-empty', 'system-message'], ['xml-user', 'user-message'], ['meta', 'activity'],
    ['synthetic', 'activity'], ['compact', 'activity'], ['system-meta', 'activity'], ['system-synthetic', 'activity'],
    ['system-compact', 'activity'], ['system-bookkeeping', 'activity'], ['system-no-content', 'activity'],
    ['assistant', 'assistant-message']
  ])
  expect(page.items[0]).toMatchObject({ title: 'System instructions', contentParts: [
    { kind: 'text', text: exact }, { kind: 'text', text: 'Second original part' }
  ] })
  expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: '' }])
  expect(page.items[3]!.contentParts).toEqual([{ kind: 'text', text: 'Original meta body' }])
  expect(page.items[6]!.contentParts).toEqual([{ kind: 'text', text: 'Original system meta body' }])
  expect(page.items[9]!.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(missingMessage) }])
  expect(core.projectSessionUserMessages({ agentSessionId: f.session.agentSessionId, historyPage: page }).map(item => item.rawId)).toEqual(['xml-user'])
  await f.unchanged()
})

it.each(['codex', 'claude'] as const)('public RPC and compiled CLI preserve %s system messages and opaque history pagination', async providerId => {
  const body = '  Original system instructions 中🙂\n'
  const rows = providerId === 'codex'
    ? [codex('older-user', 'user', 'Original user task'), codex('system', 'user', body,
      { content_item_kinds: ['environments.environment_context'] })]
    : [claude('older-user', 'user', 'Original user task'), claude('system', 'system', body)]
  const f = await fixture(providerId, rows), socketPath = join(f.root, 'control.sock')
  const server = new core.AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  close.push(() => rpc.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'native' as const, limit: 1 }
  const first = await rpc.call('agent.history', input)
  expect(first.items).toEqual([{ kind: 'item', item: { id: 'system', kind: 'system-message',
    ...(providerId === 'codex' ? { turnId: 'native-turn' } : {}), title: providerId === 'codex' ? 'Runtime context' : 'System instructions',
    contentParts: [{ kind: 'text', text: body }] } }])
  const context = await rpc.call('agent.context', { hostId: input.hostId, agentSessionId: input.agentSessionId, limit: 1 })
  expect(context.native?.items).toEqual(first.items.map(entry => entry.kind === 'item' ? entry.item : undefined))
  const older = await rpc.call('agent.history', { ...input, cursor: first.nextCursor! })
  expect(older.items).toMatchObject([{ kind: 'item', item: { id: 'older-user', kind: 'user-message' } }])
  if (older.nextCursor !== null) {
    const end = await rpc.call('agent.history', { ...input, cursor: older.nextCursor })
    expect(end.items).toEqual([])
    expect(end.nextCursor).toBeNull()
  }
  const args = ['--endpoint', `unix:${socketPath}`, 'agent', 'history', '--host', 'local', '--session',
    f.session.agentSessionId, '--source', 'native', '--limit', '1']
  const cli = await runCompiledObjectCli(args, objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.stderr).toBe('')
  const receipt = JSON.parse(cli.stdout)
  expect(receipt).toMatchObject({ ok: true, operation: 'agent.history', result: { items: first.items } })
  const next = await runCompiledObjectCli([...args, '--cursor', receipt.result.nextCursor], objectCliEnvironment(f.root))
  expect(next.code, next.stderr).toBe(0)
  expect(JSON.parse(next.stdout).result.items).toEqual(older.items)
  await f.unchanged()
})

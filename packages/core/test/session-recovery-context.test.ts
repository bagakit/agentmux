import { fixturePath } from './helpers/fixture-values.js'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionHistoryPage } from '../src/types.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())) })
const source = { providerId: 'codex', nativeSessionId: 'indexed-native' }
const item = { id: 'reply', kind: 'assistant-message' as const,
  contentParts: [{ kind: 'text' as const, text: '\n exact 中 😀\n' }] }
const pageBody = { source, items: [item], nextCursor: 'older-window' }

async function publicClient(reader?: AgentProvider['readSessionHistoryPage'], workspacePath = fixturePath("synthetic")) {
  const store = new AgentMuxMemoryAgentSessionStore()
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'indexed-session', providerId: 'codex',
    executorId: 'codex', hostId: 'local', workspacePath, run: { runId: 'unchanged-run' }, retiredRuns: [],
    createdAt: 1, updatedAt: 1, hookBindingId: 'fixture-binding', hookToken: 'fixture-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId,
      transcriptPath: fixturePath("synthetic/untrusted-child-path-is-ignored.jsonl") } }
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, ...(reader ? {
    providers: [{ ...new AgentProviderRegistry().get('codex'), readSessionHistoryPage: reader }]
  } : {}) })
  cleanup.push(() => client.dispose())
  return { client, store, session }
}

const record = (uuid: string, type: 'user' | 'assistant', content: string) => ({
  sessionId: 'native-main', uuid, type, message: { role: type, content }
})

describe('public native history context metadata', () => {
  it('reports exact UTF8 physical JSONL snapshot bytes including metadata and keeps cursor extent after append', async () => {
    const original = jsonl([
      { type: 'bookkeeping', data: 'physical metadata 中 😀' },
      record('old-user', 'user', 'first 中'), record('old-answer', 'assistant', 'first answer'),
      record('latest-user', 'user', 'second'), record('latest-answer', 'assistant', 'exact 😀')
    ])
    expect(Buffer.byteLength(original)).toBeGreaterThan(original.length)
    const f = await nativeHistoryFixture('claude', original)
    cleanup.push(f.close)
    const first = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
    expect(first.sourceSizeBytes).toBe(Buffer.byteLength(original))
    expect(first.items.map(entry => entry.id)).toEqual(['latest-user', 'latest-answer'])
    expect(first.nextCursor).toBeTypeOf('string')

    const appended = jsonl([record('appended', 'user', 'new 中 😀')])
    await appendFile(f.path, appended)
    const older = await f.client.sessionHistoryPage('private-agent', { limit: 2, cursor: first.nextCursor! })
    expect(older.sourceSizeBytes).toBe(first.sourceSizeBytes)
    expect(older.items.map(entry => entry.id)).toEqual(['old-user', 'old-answer'])
    const newest = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
    expect(newest.sourceSizeBytes).toBe(Buffer.byteLength(original + appended))
    expect(newest.items.map(entry => entry.id)).toEqual(['latest-answer', 'appended'])
    const after = await f.bytes()
    expect(after.native).toEqual(Buffer.from(original + appended))
    expect(after.store).toEqual(f.before.store)
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  })

  it('excludes an unfinished UTF8 append from the physical snapshot without repairing the file', async () => {
    const complete = jsonl([record('complete', 'assistant', 'readable 中')])
    const f = await nativeHistoryFixture('claude', Buffer.concat([
      Buffer.from(complete + '{"type":"user","text":"'), Buffer.from([0xe4, 0xb8])
    ]))
    cleanup.push(f.close)
    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.sourceSizeBytes).toBe(Buffer.byteLength(complete))
    expect(page.items.map(entry => entry.id)).toEqual(['complete'])
    expect(page.nextCursor).toBeNull()
    expect(await f.bytes()).toEqual(f.before)
  })

  it('keeps indexed native history readable with honest unknown bytes and no transcript-path fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-context-indexed-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const script = join(root, 'native.mjs')
    await writeFile(script, `
import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  const send = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
  if (request.method === 'initialize') send({ userAgent: 'synthetic-indexed-server' })
  else if (request.method === 'thread/read') send({ thread: { id: 'indexed-native', historyMode: 'paginated', turns: [] } })
  else if (request.method === 'thread/items/list') send({ data: [{ turnId: 'native-turn', startedAtMs: 100, completedAtMs: 200,
    item: { type: 'agentMessage', id: 'reply', text: '\\n exact 中 😀\\n' } }], nextCursor: null })
})
`)
    const { client, store, session } = await publicClient(undefined, root)
    const page = await client.sessionHistoryPage('indexed-session', { commandOverride: process.execPath, args: [script], limit: 6 })
    expect(page).toEqual({ agentSessionId: 'indexed-session', source, nextCursor: null,
      items: [{ ...item, turnId: 'native-turn', startedAt: 100, completedAt: 200 }] })
    expect(page).not.toHaveProperty('sourceSizeBytes')
    expect(await store.load()).toEqual([session])
  })

  it.each([0, 1024, Number.MAX_SAFE_INTEGER])('preserves known safe snapshot size %s with exact body and cursor', async sourceSizeBytes => {
    const { client, store, session } = await publicClient(async () => ({ ...pageBody, sourceSizeBytes }))
    expect(await client.sessionHistoryPage('indexed-session')).toEqual({ agentSessionId: 'indexed-session', ...pageBody, sourceSizeBytes })
    expect(await store.load()).toEqual([session])
  })

  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  it.each([
    ['negative', -1], ['fraction', 1.5], ['NaN', NaN], ['infinite', Infinity], ['negative-infinite', -Infinity],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['null', null], ['string', '1024'], ['object', {}], ['array', []],
    ['bigint', 1n], ['cyclic', cyclic]
  ])('ignores invalid optional %s bytes without losing valid public history', async (_label, invalidSize) => {
    const { client } = await publicClient(async () => ({ ...pageBody, sourceSizeBytes: invalidSize } as unknown as AgentProviderSessionHistoryPage))
    expect(await client.sessionHistoryPage('indexed-session')).toEqual({ agentSessionId: 'indexed-session', ...pageBody })
  })

  it.each([
    { providerId: 'foreign-provider', nativeSessionId: source.nativeSessionId },
    { providerId: source.providerId, nativeSessionId: 'foreign-session' }
  ])('still rejects foreign native source %j even with invalid optional bytes', async foreignSource => {
    const { client } = await publicClient(async () => ({ ...pageBody, source: foreignSource, sourceSizeBytes: -1 }))
    await expect(client.sessionHistoryPage('indexed-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  })

  it('keeps the existing body byte budget when optional size is invalid', async () => {
    const { client } = await publicClient(async () => ({ ...pageBody, sourceSizeBytes: -1,
      items: [{ ...item, contentParts: [{ kind: 'text', text: 'x'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES) }] }] }))
    await expect(client.sessionHistoryPage('indexed-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
  })
})

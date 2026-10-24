import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { encodeCwdDirname } from '../../src/providers/grok-native-history.js'
import { nativeHistoryFixture, jsonl } from '../fixtures/native-history-session.js'
import { grokUser } from '../fixtures/grok-updates.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await nativeHistoryFixture('grok', jsonl([grokUser('native-main', 'Original input')]), { relativePath: 'updates.jsonl' })
  cleanup.push(f.close)
  const summary = join(f.root, 'summary.json'), info = { id: 'native-main', cwd: f.root }
  await writeFile(summary, JSON.stringify({ info }))
  return { ...f, summary, info }
}

// Fixed native-path fixtures; the prior test literals had been shortened without
// updating their old hash expectations. Keep the 255-byte branch explicit.
it.each([
  ['home//Documents/' + 'long/'.repeat(60) + 'main-branch', 'main-branch-57cf60d44f80b606'],
  ['home//Library/' + '深层/'.repeat(40) + 'project', 'project-1c58a68b6e934bfb']
])('retains a stable BLAKE3 suffix for an actually long cwd', (cwd, expected) => expect(encodeCwdDirname(cwd)).toBe(expected))

it('retains CJK fallback and literal Unix backslash hashing', () => {
  expect(encodeCwdDirname('home//Documents/' + '长路径/'.repeat(20) + '项目')).toMatch(/^workspace-[0-9a-f]{16}$/u)
  expect(encodeCwdDirname('home//Documents/' + 'long/'.repeat(50) + 'dir\\name')).toMatch(/^dir-name-[0-9a-f]{16}$/u)
  expect(encodeCwdDirname('home//' + '中'.repeat(30))).not.toBe(encodeCwdDirname('home//' + '日'.repeat(30)))
})

it.each(['empty', 'flat', 'missing-id', 'missing-cwd', 'wrong-id', 'wrong-cwd'] as const)('rejects %s summary identity without touching the Run', async kind => {
  const f = await fixture()
  const data = kind === 'empty' ? {} : kind === 'flat' ? f.info : { info: {
    ...(kind === 'missing-id' ? {} : { id: kind === 'wrong-id' ? 'foreign' : f.info.id }),
    ...(kind === 'missing-cwd' ? {} : { cwd: kind === 'wrong-cwd' ? '/foreign' : f.info.cwd }) } }
  await writeFile(f.summary, JSON.stringify(data))
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: ['empty', 'flat'].includes(kind) ? 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' : 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('bounds summary allocation before reading oversized metadata and keeps legal summary plus native body readable', async () => {
  const f = await fixture()
  await writeFile(f.summary, JSON.stringify({ info: f.info, padding: 'x'.repeat(1024 * 1024 + 1) }))
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
  await writeFile(f.summary, JSON.stringify({ info: f.info, padding: 's'.repeat(200 * 1024) }))
  await writeFile(f.path, jsonl(Array.from({ length: 10 }, (_, i) => grokUser('native-main', `${i}:${'x'.repeat(40 * 1024)}`))))
  expect((await f.client.sessionHistoryPage(f.session.agentSessionId)).items).toHaveLength(10)
  await writeFile(f.path, jsonl(Array.from({ length: 30 }, (_, i) => grokUser('native-main', `${i}:${'x'.repeat(160 * 1024)}`))))
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
})

it.each(['prefix-updates.jsonl', 'prefix-chat_history.jsonl', 'unrelated.jsonl'])('rejects an arbitrary %s locator', async name => {
  const f = await fixture(), provider = new AgentProviderRegistry().get('grok')
  await expect(provider.readSessionHistoryPage!({ agentSessionId: f.session.agentSessionId, source: { providerId: 'grok', nativeSessionId: 'native-main' },
    transcriptPath: join(f.root, name), workspacePath: f.root, env: {}, command: 'grok', args: [], limit: 1, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
})

it('only the exact native directory can omit summary; the real Hook handle survives a fresh client and retains resume identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-original-hook-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspacePath = 'home//Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch', id = 'native-main'
  const directory = join(root, 'sessions', encodeCwdDirname(workspacePath), id), path = join(directory, 'updates.jsonl')
  await mkdir(directory, { recursive: true }); await writeFile(path, jsonl([grokUser(id, 'Retained original input')]))
  const provider = new AgentProviderRegistry().get('grok')
  const normalized = provider.normalizeHook({ receiptId: 'original-receipt', agentSessionId: 'original', runId: 'original-run', providerId: 'grok',
    payload: { hookEventName: 'user_prompt_submit', sessionId: id, transcript_path: '/not-an-authority/chat_history.jsonl', transcriptPath: '/also-not-authority/updates.jsonl' } }, {})
  expect(normalized.nativeHandle).toEqual({ kind: 'provider', providerId: 'grok', sessionId: id })
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original', providerId: 'grok', executorId: 'grok', hostId: 'local', workspacePath,
    run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: normalized.nativeHandle! }
  await store.compareAndSwap(null, session)
  const before = await readFile(join(root, 'sessions.json')), client = new AgentMuxClient({ store }); cleanup.push(() => client.dispose())
  const page = await client.sessionHistoryPage('original', { env: { GROK_HOME: root } })
  expect(page.items[0]!.contentParts[0]).toMatchObject({ text: 'Retained original input', contentEligibility: 'unconfirmed' })
  expect(await readFile(join(root, 'sessions.json'))).toEqual(before)
  expect(provider.buildResumeLaunch({ workspacePath, nativeHandle: session.nativeHandle!, prompt: 'continue', args: ['--debug'], env: {} }).args).toEqual(['--resume', id, '--debug', '--', 'continue'])
  const f = await fixture(); await rm(f.summary)
  await expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('reverse native pages preserve physical ordering, opaque positions and distinct equal inputs', async () => {
  const f = await fixture(), rows = Array.from({ length: 7 }, (_, i) => grokUser('native-main', `Input ${i % 2}`))
  await writeFile(f.path, jsonl(rows))
  const first = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 3 })
  const second = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 3, cursor: first.nextCursor! })
  const last = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 3, cursor: second.nextCursor! })
  const all = [...last.items, ...second.items, ...first.items]
  expect(all.map(item => item.id)).toEqual(rows.map((_, i) => `grok-update:${Buffer.byteLength(jsonl(rows.slice(0, i)).replace(/^\n$/u, ''))}`))
  expect(last.nextCursor).toBeNull(); expect(new Set(all.map(item => item.id)).size).toBe(7)
})

it('disconnect during pending summary fstat performs no body read and preserves the original source', async () => {
  const f = await fixture(), probe = await open(f.path, constants.O_RDONLY), prototype = Object.getPrototypeOf(probe); await probe.close()
  const originalStat = prototype.stat, originalRead = prototype.read
  const targetFds = new Set<number>()
  let pending = false, reads = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  prototype.stat = async function (this: { fd: number }, ...args: unknown[]) { targetFds.add(this.fd); pending = true; await barrier; return originalStat.apply(this, args) }
  prototype.read = async function (this: { fd: number }, ...args: unknown[]) { if (targetFds.has(this.fd)) reads++; return originalRead.apply(this, args) }
  try {
    const request = f.client.sessionHistoryPage(f.session.agentSessionId)
    await vi.waitFor(() => expect(pending).toBe(true)); f.client.disconnect(); release()
    await expect(request).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' }); expect(reads).toBe(0)
  } finally { release(); prototype.stat = originalStat; prototype.read = originalRead }
})

it('the original ten-second read deadline also covers pending metadata', async () => {
  const f = await fixture(), probe = await open(f.path, constants.O_RDONLY), prototype = Object.getPrototypeOf(probe); await probe.close()
  const originalStat = prototype.stat
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  prototype.stat = async function (...args: unknown[]) { await barrier; return originalStat.apply(this, args) }
  try {
    vi.useFakeTimers()
    const request = expect(f.client.sessionHistoryPage(f.session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_001); release(); await request
    vi.useRealTimers(); await new Promise(resolve => setTimeout(resolve, 50))
  } finally { release(); vi.useRealTimers(); prototype.stat = originalStat }
})

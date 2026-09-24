import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { proto3, ScalarType } from '@bufbuild/protobuf'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../../dist/index.js'
import { NativeSqliteHistoryReader } from '../../dist/native-sqlite-history-reader.js'
import { cursorConfigRoot, cursorDataRoot, resolveCursorStorePath, resolveCursorTranscriptPath } from '../../dist/providers/cursor-native-history.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryItem } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'

// Independent fixed-producer wire schema: changing the implementation's field tags
// must not also change our native fixture encoder. A maintained protobuf engine
// performs all encoding; no handwritten protobuf/SQLite/WAL parser is used.
const NativeRoot = proto3.makeMessageType('fixture.CursorNativeRoot', () => [
  { no: 1, name: 'root_prompt_messages_json', kind: 'scalar', T: ScalarType.BYTES, repeated: true },
  { no: 13, name: 'summary_archives', kind: 'scalar', T: ScalarType.BYTES, repeated: true }
])
const NativeArchive = proto3.makeMessageType('fixture.CursorNativeArchive', () => [
  { no: 1, name: 'summarized_messages', kind: 'scalar', T: ScalarType.BYTES, repeated: true }
])
const dispose: Array<() => Promise<void>> = []
afterEach(async () => {
  while (dispose.length) await dispose.pop()!()
  vi.unstubAllEnvs(); vi.restoreAllMocks()
})
type NativeMessage = { role: string; content: unknown; providerOptions?: unknown }

async function fixture(messages: NativeMessage[], archives: NativeMessage[][] = []) {
  const root = await mkdtemp(join(tmpdir(), 'amux-cursor-native-page-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const env = { CURSOR_CONFIG_DIR: join(root, 'config'), CURSOR_DATA_DIR: join(root, 'data') }
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const nativeId = '019ff166-9788-4ace-b9eb-9a71a42f0af9', source = { providerId: 'cursor', nativeSessionId: nativeId }
  const path = resolveCursorStorePath(workspace, nativeId, env), transcript = resolveCursorTranscriptPath(workspace, nativeId, env)
  await mkdir(join(path, '..'), { recursive: true })
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
  const blob = (bytes: Uint8Array) => {
    const id = createHash('sha256').update(bytes).digest()
    writer.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(id.toString('hex'), bytes)
    return id
  }
  const message = (value: NativeMessage) => blob(Buffer.from(JSON.stringify(value)))
  const archiveIds = archives.map(values => blob(new NativeArchive({ summarizedMessages: values.map(message) }).toBinary()))
  const ids = messages.map(message)
  const rootId = (current: Uint8Array[]) => blob(new NativeRoot({ rootPromptMessagesJson: current, summaryArchives: archiveIds }).toBinary()).toString('hex')
  const metadata = (id: string, agentId = nativeId) => writer.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')
    .run('0', Buffer.from(JSON.stringify({ agentId, latestRootBlobId: id })).toString('hex'))
  metadata(rootId(ids)); writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const storePath = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-cursor-session',
    providerId: 'cursor', executorId: 'cursor', hostId: 'local', workspacePath: workspace,
    run: { runId: 'private-original-healthy-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),
    nativeHandle: { kind: 'provider', providerId: 'cursor', sessionId: nativeId, transcriptPath: transcript } }
  await store.compareAndSwap(null, stored)
  const before = await readFile(storePath), clients: AgentMuxClient[] = []
  const controls: Array<() => void> = []
  const client = () => {
    const result = new AgentMuxClient({ store }); clients.push(result)
    const adapter = (result as unknown as { kernel: CtxmuxRunAdapter }).kernel
    for (const name of ['start', 'input', 'resize', 'stop', 'attach', 'status'] as const) {
      const observed = vi.spyOn(adapter, name)
      controls.push(() => expect(observed).not.toHaveBeenCalled())
    }
    return result
  }
  const current = client()
  dispose.push(async () => { await Promise.all(clients.map(c => c.dispose())); writer.close(); await rm(root, { recursive: true, force: true }) })
  return { root, workspace, env, path, transcript, source, writer, ids, blob, metadata, rootId, message, storePath, before, client, current,
    page: (limit = 30, cursor?: string) => current.sessionHistoryPage(stored.agentSessionId, { env, limit, ...(cursor ? { cursor } : {}) }),
    freshPage: () => client().sessionHistoryPage(stored.agentSessionId, { env }),
    append: (value: NativeMessage) => { ids.push(message(value)); metadata(rootId(ids)) },
    unchanged: async () => { expect(await readFile(storePath)).toEqual(before); for (const control of controls) control() }
  }
}
const speech = (text: string): NativeMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const text = (item: AgentSessionHistoryItem) => item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('')

describe('Cursor typed native history through the built public Client', () => {
  it('uses inherited native environment without explicit history options and lets explicit invocation env override it', async () => {
    const f = await fixture([speech('ambient native input')])
    vi.stubEnv('CURSOR_CONFIG_DIR', f.env.CURSOR_CONFIG_DIR)
    vi.stubEnv('CURSOR_DATA_DIR', f.env.CURSOR_DATA_DIR)
    await expect(f.current.sessionHistoryPage('private-cursor-session').then(page => page.items.map(text))).resolves.toEqual(['ambient native input'])
    vi.stubEnv('CURSOR_CONFIG_DIR', join(f.root, 'different-ambient-config'))
    await expect(f.current.sessionHistoryPage('private-cursor-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
    expect((await f.page()).items.map(text)).toEqual(['ambient native input'])
    vi.stubEnv('XDG_CONFIG_HOME', join(f.root, 'xdg'))
    expect(cursorConfigRoot(f.workspace, { CURSOR_CONFIG_DIR: undefined })).toBe(join(f.root, 'xdg', 'cursor'))
    expect(cursorConfigRoot(f.workspace, { CURSOR_CONFIG_DIR: '  relative root' })).toBe(join(f.workspace, '  relative root'))
    expect(cursorDataRoot(f.workspace, { CURSOR_DATA_DIR: 'relative-data' })).toBe(join(f.workspace, 'relative-data'))
    await f.unchanged()
  })
  it('keeps archive/current order, reasoning, resources and tool trace exact without synthetic times or Run controls', async () => {
    const f = await fixture([{ role: 'assistant', content: [
      { type: 'reasoning', text: 'native reasoning' }, { type: 'text', text: 'native answer' },
      { type: 'image', url: 'file:///private/image.png' }, { type: 'tool-call', toolName: 'Shell', toolCallId: 'call-1', args: { command: 'private' } },
      { type: 'tool-result', toolName: 'Shell', toolCallId: 'call-1', output: 'failed result', status: 'error' },
      { type: 'file', filePath: '/private/attachment.txt', filename: 'attachment.txt' }, { type: 'native-unknown', value: 'preserved' }
    ] }], [[speech('old archived user')]])
    const native = await readFile(f.path), page = await f.page()
    expect(page.source).toEqual(f.source)
    expect(page.items.map(item => [item.kind, text(item), item.startedAt, item.completedAt])).toEqual([
      ['user-message', 'old archived user', undefined, undefined],
      ['assistant-message', 'native answer{"type":"native-unknown","value":"preserved"}', undefined, undefined]
    ])
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'reasoning', text: 'native reasoning' }, { kind: 'text', text: 'native answer' },
      { kind: 'resource', resourceType: 'image', reference: 'file:///private/image.png' },
      { kind: 'tool-call', name: 'Shell', callId: 'call-1', input: '{"command":"private"}' },
      { kind: 'tool-result', name: 'Shell', callId: 'call-1', output: 'failed result', failed: true },
      { kind: 'resource', resourceType: 'file', reference: '/private/attachment.txt', label: 'attachment.txt' },
      { kind: 'text', text: '{"type":"native-unknown","value":"preserved"}' }
    ])
    expect(await f.freshPage()).toEqual(page)
    expect(await readFile(f.path)).toEqual(native)
    await f.unchanged()
  })

  it('preserves two equal native body occurrences and stable positional identities across pagination and rereads', async () => {
    const f = await fixture([speech('equal'), speech('equal'), speech('third'), speech('fourth'), speech('fifth')])
    const items: AgentSessionHistoryItem[] = []
    let cursor: string | undefined
    do { const page = await f.page(2, cursor); items.unshift(...page.items); cursor = page.nextCursor ?? undefined } while (cursor)
    expect(items.map(text)).toEqual(['equal', 'equal', 'third', 'fourth', 'fifth'])
    expect(new Set(items.map(item => item.id)).size).toBe(5)
    expect(items[0]!.id).not.toBe(items[1]!.id)
    expect(f.ids[0]).toEqual(f.ids[1])
    expect((await f.freshPage()).items).toEqual(items)
    await f.unchanged()
  })

  it('preserves the native archive/root concatenation when equal content hashes occur in both positions', async () => {
    const equal = speech('native repeated archive and root body'), f = await fixture([equal, speech('current')], [[equal]])
    const page = await f.page()
    expect(page.items.map(text)).toEqual(['native repeated archive and root body', 'native repeated archive and root body', 'current'])
    expect(page.items.map(item => item.id)).toEqual([`0:${f.ids[0]!.toString('hex')}`, `1:${f.ids[0]!.toString('hex')}`, `2:${f.ids[1]!.toString('hex')}`])
    expect((await f.page(2)).items).toEqual(page.items.slice(1))
    await f.unchanged()
  })

  it.each(['append-wal', 'checkpoint'])('keeps the original root/cut during %s between pages and only includes append on explicit refresh', async mode => {
    const f = await fixture([speech('one'), speech('two'), speech('three'), speech('four')])
    const first = await f.page(2)
    expect(first.items.map(text)).toEqual(['three', 'four']); expect(first.nextCursor).toBeTypeOf('string')
    f.append(speech('new only on refresh'))
    if (mode === 'checkpoint') f.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const older = await f.page(2, first.nextCursor!)
    expect(older.items.map(text)).toEqual(['one', 'two']); expect(older.nextCursor).toBeNull()
    expect((await f.page()).items.map(text)).toEqual(['one', 'two', 'three', 'four', 'new only on refresh'])
    await f.unchanged()
  })

  it('rejects a main DB replacement instead of using an old cursor against identical copied bytes', async () => {
    const f = await fixture([speech('one'), speech('two')]), first = await f.page(1), bytes = await readFile(f.path)
    expect(first.items.map(text)).toEqual(['two'])
    await rename(f.path, `${f.path}.previous`); await writeFile(f.path, bytes)
    await expect(f.page(1, first.nextCursor!)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    await f.unchanged()
  })

  it.each(['missing-message', 'changed-message', 'foreign-metadata'])('diagnoses %s rather than skipping a native record', async mode => {
    const f = await fixture([speech('original')]), id = f.ids[0]!.toString('hex')
    if (mode === 'missing-message') f.writer.prepare('DELETE FROM blobs WHERE id=?').run(id)
    if (mode === 'changed-message') f.writer.prepare('UPDATE blobs SET data=? WHERE id=?').run(Buffer.from(JSON.stringify(speech('different'))), id)
    if (mode === 'foreign-metadata') f.metadata(f.rootId(f.ids), 'other-native-session')
    await expect(f.page()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    await f.unchanged()
  })

  it.each(['message', 'metadata'])('rejects invalid UTF-8 in a complete native %s JSON value without replacing original bytes', async mode => {
    const f = await fixture([speech('valid native input')])
    const invalid = Buffer.concat([Buffer.from('{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}')])
    const id = f.blob(invalid)
    if (mode === 'message') f.metadata(f.rootId([id]))
    else f.writer.prepare('UPDATE meta SET value=? WHERE key=?').run(invalid.toString('hex'), '0')
    const native = await readFile(f.path), wal = await readFile(`${f.path}-wal`)
    await expect(f.page()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    expect(Buffer.from(f.writer.prepare('SELECT data FROM blobs WHERE id=?').get(id.toString('hex'))!.data as Uint8Array)).toEqual(invalid)
    expect(await readFile(f.path)).toEqual(native); expect(await readFile(`${f.path}-wal`)).toEqual(wal)
    await f.unchanged()
  })

  it.each(['root', 'archive', 'missing-archive'])('reports a broken native %s structure without empty or partial success', async mode => {
    const f = await fixture([speech('valid native input')]), brokenId = f.blob(Buffer.from([0xff]))
    if (mode === 'root') f.metadata(brokenId.toString('hex'))
    else {
      const root = f.blob(new NativeRoot({ rootPromptMessagesJson: f.ids, summaryArchives: [brokenId] }).toBinary())
      f.metadata(root.toString('hex'))
      if (mode === 'missing-archive') f.writer.prepare('DELETE FROM blobs WHERE id=?').run(brokenId.toString('hex'))
    }
    await expect(f.page()).rejects.toMatchObject({ code: mode === 'missing-archive' ? 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' : 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    await f.unchanged()
  })

  it('keeps the actual native summary marker neutral rather than manufacturing a user input', async () => {
    const f = await fixture([{ ...speech('generated summary'), providerOptions: { cursor: { isSummary: true } } }, speech('real input')])
    expect((await f.page()).items.map(item => [item.kind, text(item), item.title])).toEqual([
      ['activity', 'generated summary', 'Cursor summary'], ['user-message', 'real input', undefined]
    ])
    await f.unchanged()
  })

  it('preserves native assistant reasoning-only roles and unknown blocks without guessing a failed tool result', async () => {
    const malformedTool = { type: 'tool-call', toolCallId: 'no-name', args: { original: true } }
    const f = await fixture([
      { role: 'assistant', content: [{ type: 'reasoning', text: 'only native reasoning' }] },
      { role: 'assistant', content: [malformedTool, 'unknown native block', { type: 'tool-result', name: '', toolName: '', toolCallId: 'native-result', output: 'actual output', is_error: 'false' }] }
    ])
    expect((await f.page()).items.map(item => [item.kind, item.contentParts])).toEqual([
      ['assistant-message', [{ kind: 'reasoning', text: 'only native reasoning' }]],
      ['assistant-message', [{ kind: 'text', text: JSON.stringify(malformedTool) }, { kind: 'text', text: '"unknown native block"' },
        { kind: 'tool-result', callId: 'native-result', output: 'actual output' }]]
    ])
    await f.unchanged()
  })

  it('does not let repeated cached blobs expand the materialized public page past its independent 4MiB limit', async () => {
    const f = await fixture(Array.from({ length: 20 }, () => speech('x'.repeat(256 * 1024))))
    const get = vi.spyOn(NativeSqliteHistoryReader.prototype, 'get')
    await expect(f.page()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
    const bodyReads = get.mock.calls.filter(([sql, values]) => sql === 'SELECT data FROM blobs WHERE id = ?' && values?.[0] === f.ids[0]!.toString('hex'))
    expect(bodyReads.length).toBeGreaterThan(0)
    expect(bodyReads.length).toBeLessThan(20)
    await f.unchanged()
  })

  it('rejects a real Source commit after a selected message before exposing page or continuation', async () => {
    const f = await fixture([speech('selected native input')]), get = NativeSqliteHistoryReader.prototype.get
    let changed = false
    vi.spyOn(NativeSqliteHistoryReader.prototype, 'get').mockImplementation(async function (this: NativeSqliteHistoryReader, sql, parameters) {
      const result = await get.call(this, sql, parameters)
      if (!changed && sql === 'SELECT data FROM blobs WHERE id = ?' && parameters?.[0] === f.ids[0]!.toString('hex')) {
        changed = true; f.append(speech('new concurrent native commit'))
      }
      return result
    })
    await expect(f.page()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    expect(changed).toBe(true)
    await f.unchanged()
  })

  it('never falls back to supplementary JSONL when the actual SQLite source is missing', async () => {
    const f = await fixture([speech('real native input')])
    await mkdir(join(f.transcript, '..'), { recursive: true })
    await writeFile(f.transcript, JSON.stringify({ role: 'user', content: 'false supplementary body' }) + '\n')
    await rename(f.path, `${f.path}.unavailable`)
    await expect(f.page()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
    await f.unchanged()
  })
})

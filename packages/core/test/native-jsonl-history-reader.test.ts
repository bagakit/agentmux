import { appendFile, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import type { AgentProviderSessionHistoryContext } from '../src/types.js'

const roots: string[] = []
const readers: NativeJsonlHistoryReader[] = []
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(data: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-jsonl-')); roots.push(root)
  const path = join(root, 'transcript.jsonl'); await writeFile(path, data)
  const context: AgentProviderSessionHistoryContext = { source: { providerId: 'pi', nativeSessionId: 'native-main' },
    transcriptPath: path, command: 'unused', args: [], env: {}, workspacePath: root, limit: 2, signal: new AbortController().signal }
  return { path, context }
}
async function open(context: AgentProviderSessionHistoryContext) {
  const reader = await NativeJsonlHistoryReader.open(context); readers.push(reader); return reader
}
const lines = (...ids: string[]) => ids.map((id) => JSON.stringify({ id, text: `exact 中 ${id}` })).join('\n') + '\n'

it('reads newest-first bounded records and keeps older pages fixed across append without writing', async () => {
  const { path, context } = await fixture(lines('one', 'two', 'three'))
  const reader = await open(context)
  expect((await reader.readFirst())?.id).toBe('one')
  expect((await reader.readPrevious())?.value).toEqual({ id: 'three', text: 'exact 中 three' })
  const cursor = await reader.nextCursor('parent-two')
  expect(cursor).toBeTypeOf('string')
  await appendFile(path, lines('four'))
  const expectedBytes = await readFile(path)
  const older = await open({ ...context, cursor: cursor! })
  expect(older.continuation).toBe('parent-two')
  expect((await older.readPrevious())?.value.id).toBe('two')
  expect((await older.readPrevious())?.value.id).toBe('one')
  expect(await older.readPrevious()).toBeNull()
  expect(await older.nextCursor()).toBeNull()
  expect(await readFile(path)).toEqual(expectedBytes)
})

it('excludes partial UTF8 append but rejects a malformed complete JSON line', async () => {
  const partial = Buffer.concat([Buffer.from(lines('complete') + '{"text":"'), Buffer.from([0xe4, 0xb8])])
  const { path, context } = await fixture(partial)
  const reader = await open(context)
  expect((await reader.readPrevious())?.value.id).toBe('complete')
  expect(await reader.nextCursor()).toBeNull()
  expect(await readFile(path)).toEqual(partial)
  const bad = await fixture(lines('one') + '{bad}\n')
  await expect((await open(bad.context)).readPrevious()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
})

it('accepts a fully decoded final record without repairing its missing newline', async () => {
  const bytes = Buffer.from('{"id":"final","text":"中"}')
  const { path, context } = await fixture(bytes)
  expect((await (await open(context)).readPrevious())?.value).toEqual({ id: 'final', text: '中' })
  expect(await readFile(path)).toEqual(bytes)
})

it('rejects complete non-object JSON and malformed UTF8 even without a trailing newline', async () => {
  for (const tail of [Buffer.from('null'), Buffer.from('[]'), Buffer.from('42'),
    Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff])])]) {
    const f = await fixture(Buffer.concat([Buffer.from(lines('one')), tail]))
    await expect((await open(f.context)).readPrevious()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    expect(await readFile(f.path)).toEqual(Buffer.concat([Buffer.from(lines('one')), tail]))
  }
})

it.each(['replace', 'truncate', 'boundary-rewrite', 'source'] as const)('rejects stale cursors after %s', async (change) => {
  const { path, context } = await fixture(lines('one', 'two', 'three'))
  const reader = await open(context); await reader.readPrevious()
  const cursor = (await reader.nextCursor())!
  let next = { ...context, cursor }
  if (change === 'replace') { await rename(path, `${path}.old`); await writeFile(path, lines('one', 'two', 'three')) }
  if (change === 'truncate') await truncate(path, 10)
  if (change === 'boundary-rewrite') await writeFile(path, lines('NEW', 'two', 'three'))
  if (change === 'source') next = { ...next, source: { providerId: 'pi', nativeSessionId: 'another' } }
  await expect(open(next)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('bounds skipped/scanned input, rejects directories, and obeys cancellation before IO', async () => {
  const large = await fixture(JSON.stringify({ body: 'x'.repeat(4 * 1024 * 1024) }) + '\n')
  await expect((await open(large.context)).readPrevious()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
  const { context } = await fixture(lines('one'))
  await expect(open({ ...context, transcriptPath: context.workspacePath })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await expect(open({ ...context, signal: controller.signal })).rejects.toThrow('cancelled')
})

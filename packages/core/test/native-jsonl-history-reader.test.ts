import { appendFile, mkdtemp, open as openFile, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeJsonlHistoryReader, readNativeHistoryBytes, type NativeHistoryReadBudget } from '../dist/native-jsonl-history-reader.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../dist/session-history.js'
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
  return { path, context, root }
}
async function open(context: AgentProviderSessionHistoryContext) {
  const reader = await NativeJsonlHistoryReader.open(context); readers.push(reader); return reader
}
async function openWithBudget(context: AgentProviderSessionHistoryContext, budget?: NativeHistoryReadBudget) {
  const reader = await NativeJsonlHistoryReader.open(context, budget); readers.push(reader); return reader
}
const lines = (...ids: string[]) => ids.map((id) => JSON.stringify({ id, text: `exact 中 ${id}` })).join('\n') + '\n'

it('reads newest-first bounded records and keeps older pages fixed across append without writing', async () => {
  const { path, context } = await fixture(lines('one', 'two', 'three'))
  const reader = await open(context)
  expect((await reader.readFirst())?.id).toBe('one')
  expect((await reader.readPrevious())?.value).toEqual({ id: 'three', text: 'exact 中 three' })
  const cursor = await reader.nextCursor('parent-two')
  expect(cursor).toBeTypeOf('string')
  expect(Object.keys(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).sort()).toEqual([
    'before', 'continuation', 'cut', 'dev', 'head', 'ino', 'nativeSessionId', 'path', 'providerId', 'tail', 'version'
  ])
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

it('repeats the complete record at its true end after partial UTF8 exclusion and valid append', async () => {
  const prefix = lines('older')
  const batch = { messages: [
    { id: 'one', text: '中🙂'.repeat(18_000) },
    { id: 'two', text: '答复 二' },
    { id: 'three', text: '答复 三' }
  ] }
  const complete = Buffer.from(prefix + JSON.stringify(batch) + '\n')
  const partial = Buffer.concat([complete, Buffer.from('{"text":"'), Buffer.from([0xe4, 0xb8])])
  const { path, context } = await fixture(partial)
  const reader = await open(context)
  const expectedRecord = { value: batch, start: Buffer.byteLength(prefix) }
  expect(await reader.readPrevious()).toEqual(expectedRecord)
  reader.repeatPrevious()
  const firstCursor = await reader.nextCursor('batch:1')
  expect(firstCursor).toBeTypeOf('string')
  const firstState = JSON.parse(Buffer.from(firstCursor!, 'base64url').toString('utf8'))
  expect(firstState).toEqual({
    version: 1, providerId: 'pi', nativeSessionId: 'native-main', path,
    dev: expect.any(Number), ino: expect.any(Number), cut: complete.length, before: complete.length,
    head: expect.stringMatching(/^[a-f0-9]{64}$/), tail: expect.stringMatching(/^[a-f0-9]{64}$/), continuation: 'batch:1'
  })
  expect(Buffer.byteLength(firstCursor!)).toBeLessThan(1024)
  await appendFile(path, Buffer.concat([Buffer.from([0xad]), Buffer.from('"}\n' + lines('newer'))]))
  const appended = await readFile(path)
  const second = await open({ ...context, cursor: firstCursor! })
  expect(second.continuation).toBe('batch:1')
  expect(await second.readPrevious()).toEqual(expectedRecord)
  second.repeatPrevious()
  const secondCursor = await second.nextCursor('batch:2')
  expect(secondCursor).toBeTypeOf('string')
  expect(JSON.parse(Buffer.from(secondCursor!, 'base64url').toString('utf8'))).toEqual({
    ...firstState, continuation: 'batch:2'
  })
  const third = await open({ ...context, cursor: secondCursor! })
  expect(third.continuation).toBe('batch:2')
  expect(await third.readPrevious()).toEqual(expectedRecord)
  expect((await third.readPrevious())?.value).toEqual({ id: 'older', text: 'exact 中 older' })
  expect(await third.readPrevious()).toBeNull()
  expect(await third.nextCursor()).toBeNull()
  expect(await readFile(path)).toEqual(appended)
})

it('repeats only the most recently returned record, including after exhaustion', async () => {
  const newest = { id: 'newest', text: 'exact 中 newest' }
  const oldest = { id: 'oldest', text: 'exact 中 oldest' }
  const { context } = await fixture(lines('oldest', 'newest'))
  const reader = await open(context)
  expect((await reader.readPrevious())?.value).toEqual(newest)
  expect((await reader.readPrevious())?.value).toEqual(oldest)
  expect(await reader.readPrevious()).toBeNull()
  reader.repeatPrevious()
  const cursor = await reader.nextCursor('unfinished-oldest')
  expect(cursor).toBeTypeOf('string')
  const resumed = await open({ ...context, cursor: cursor! })
  expect(resumed.continuation).toBe('unfinished-oldest')
  expect((await resumed.readPrevious())?.value).toEqual(oldest)
  expect(await resumed.readPrevious()).toBeNull()
  expect(await resumed.nextCursor()).toBeNull()
})

it.each([true, false])('can repeat the sole complete record with a trailing newline: %s', async (terminated) => {
  const value = { messages: ['一', '二🙂'] }
  const { context } = await fixture(JSON.stringify(value) + (terminated ? '\n' : ''))
  const reader = await open(context)
  expect(await reader.readPrevious()).toEqual({ value, start: 0 })
  expect(await reader.nextCursor()).toBeNull()
  reader.repeatPrevious()
  const cursor = await reader.nextCursor('remaining:1')
  expect(cursor).toBeTypeOf('string')
  const resumed = await open({ ...context, cursor: cursor! })
  expect(resumed.continuation).toBe('remaining:1')
  expect(await resumed.readPrevious()).toEqual({ value, start: 0 })
  expect(await resumed.nextCursor()).toBeNull()
})

it('requires a successful reverse record read before repetition and obeys cancellation', async () => {
  const { context } = await fixture(lines('one'))
  const controller = new AbortController()
  const reader = await open({ ...context, signal: controller.signal })
  expect(() => reader.repeatPrevious()).toThrowError(expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' }))
  expect(await reader.readFirst()).toEqual({ id: 'one', text: 'exact 中 one' })
  expect(() => reader.repeatPrevious()).toThrowError(expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' }))
  expect((await reader.readPrevious())?.value).toEqual({ id: 'one', text: 'exact 中 one' })
  controller.abort(new Error('cancelled'))
  expect(() => reader.repeatPrevious()).toThrow('cancelled')
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

it('enforces shared page budget across two JSONL readers on independent files', async () => {
  const payload1 = 'A'.repeat(2_500_000)
  const payload2 = 'B'.repeat(2_500_000)
  const f1 = await fixture(JSON.stringify({ id: 'f1-one', data: payload1 }) + '\n')
  const f2 = await fixture(JSON.stringify({ id: 'f2-one', data: payload2 }) + '\n')

  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const reader1 = await openWithBudget(f1.context, budget)
  const reader2 = await openWithBudget(f2.context, budget)

  const rec1 = await reader1.readPrevious()
  expect(rec1?.value.id).toBe('f1-one')
  const bytesAfter1 = budget.bytesRead
  expect(bytesAfter1).toBeGreaterThan(2_500_000)
  expect(bytesAfter1).toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)

  await expect(reader2.readPrevious()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
  expect(budget.bytesRead).toBeGreaterThan(bytesAfter1)
  expect(budget.bytesRead).toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)

  const smallBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const s1 = await fixture(lines('s1-alpha', 's1-beta'))
  const s2 = await fixture(lines('s2-gamma', 's2-delta'))
  const smallReader1 = await openWithBudget(s1.context, smallBudget)
  const smallReader2 = await openWithBudget(s2.context, smallBudget)

  const s1Record = await smallReader1.readPrevious()
  const s2Record = await smallReader2.readPrevious()
  expect(s1Record?.value).toEqual({ id: 's1-beta', text: 'exact 中 s1-beta' })
  expect(s2Record?.value).toEqual({ id: 's2-delta', text: 'exact 中 s2-delta' })
  expect(smallBudget.bytesRead).toBeGreaterThan(0)
  expect(smallBudget.bytesRead).toBeLessThan(SESSION_HISTORY_MAX_PAGE_BYTES)
})

it('enforces shared page budget across auxiliary JSON reading and JSONL reader', async () => {
  const metaRoot = await mkdtemp(join(tmpdir(), 'agentmux-native-meta-'))
  roots.push(metaRoot)
  const metaPath = join(metaRoot, 'summary.json')
  const metaPayload = { id: 'summary-001', kind: 'meta', padding: 'M'.repeat(1024 * 1024) }
  const metaBuffer = Buffer.from(JSON.stringify(metaPayload))
  await writeFile(metaPath, metaBuffer)

  const transcriptPayload = 'T'.repeat(3_500_000)
  const fTranscript = await fixture(JSON.stringify({ id: 't-one', data: transcriptPayload }) + '\n')

  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const signal = new AbortController().signal

  const metaFile = await openFile(metaPath, constants.O_RDONLY)
  try {
    const metaStat = await metaFile.stat()
    const readMetaBuf = await readNativeHistoryBytes(metaFile, 0, metaStat.size, signal, budget)
    expect(readMetaBuf.length).toBe(metaStat.size)
    expect(budget.bytesRead).toBe(metaStat.size)
    const parsed = JSON.parse(readMetaBuf.toString('utf8')) as Record<string, unknown>
    expect(parsed.id).toBe('summary-001')
    expect(parsed.kind).toBe('meta')
  } finally {
    await metaFile.close()
  }

  const jsonlReader = await openWithBudget(fTranscript.context, budget)
  await expect(jsonlReader.readPrevious()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })

  const posBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const posMetaPath = join(metaRoot, 'small-summary.json')
  const posMetaBuf = Buffer.from(JSON.stringify({ id: 'small-summary', session: 'sess-123' }))
  await writeFile(posMetaPath, posMetaBuf)
  const posTranscript = await fixture(lines('aux-item-1', 'aux-item-2'))

  const posMetaFile = await openFile(posMetaPath, constants.O_RDONLY)
  let posMetaReadBytes = 0
  try {
    const s = await posMetaFile.stat()
    const buf = await readNativeHistoryBytes(posMetaFile, 0, s.size, signal, posBudget)
    posMetaReadBytes = buf.length
    expect(posMetaReadBytes).toBe(posMetaBuf.length)
    expect(JSON.parse(buf.toString('utf8'))).toEqual({ id: 'small-summary', session: 'sess-123' })
  } finally {
    await posMetaFile.close()
  }
  expect(posBudget.bytesRead).toBe(posMetaReadBytes)

  const posReader = await openWithBudget(posTranscript.context, posBudget)
  const posItem = await posReader.readPrevious()
  expect(posItem?.value).toEqual({ id: 'aux-item-2', text: 'exact 中 aux-item-2' })
  expect(posBudget.bytesRead).toBeGreaterThan(posMetaReadBytes)
  expect(posBudget.bytesRead).toBeLessThan(SESSION_HISTORY_MAX_PAGE_BYTES)
})

it('synchronously reserves length before first await so parallel in-flight requests share budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-parallel-'))
  roots.push(root)
  const filePath = join(root, 'data.bin')
  const data = Buffer.alloc(3_500_000, 0x42)
  await writeFile(filePath, data)

  const file = await openFile(filePath, constants.O_RDONLY)
  try {
    const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
    const signal = new AbortController().signal

    const req1 = readNativeHistoryBytes(file, 0, 3_000_000, signal, budget)
    expect(budget.bytesRead).toBe(3_000_000)

    const req2 = readNativeHistoryBytes(file, 0, 3_000_000, signal, budget)

    await expect(req2).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })

    const res1 = await req1
    expect(res1.length).toBe(3_000_000)
    expect(res1[0]).toBe(0x42)
    expect(budget.bytesRead).toBe(3_000_000)
  } finally {
    await file.close()
  }
})

it('emits non-empty nextCursor when remaining budget is sufficient and verifies older page', async () => {
  const { path, context } = await fixture(lines('rec-1', 'rec-2', 'rec-3'))
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const reader = await openWithBudget(context, budget)

  const rec3 = await reader.readPrevious()
  expect(rec3?.value).toEqual({ id: 'rec-3', text: 'exact 中 rec-3' })

  const cursor = await reader.nextCursor('continuation-pi-alpha')
  expect(cursor).toBeTypeOf('string')
  expect(cursor!.length).toBeGreaterThan(0)

  const state = JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))
  expect(state.continuation).toBe('continuation-pi-alpha')
  expect(state.path).toBe(path)
  expect(state.providerId).toBe('pi')
  expect(state.nativeSessionId).toBe('native-main')
  expect(state.cut).toBeGreaterThan(0)
  expect(state.before).toBeGreaterThan(0)
  expect(state.head).toMatch(/^[a-f0-9]{64}$/)
  expect(state.tail).toMatch(/^[a-f0-9]{64}$/)

  const olderReader = await openWithBudget({ ...context, cursor: cursor! }, budget)
  expect(olderReader.continuation).toBe('continuation-pi-alpha')
  const rec2 = await olderReader.readPrevious()
  expect(rec2?.value).toEqual({ id: 'rec-2', text: 'exact 中 rec-2' })
  const rec1 = await olderReader.readPrevious()
  expect(rec1?.value).toEqual({ id: 'rec-1', text: 'exact 中 rec-1' })
  expect(await olderReader.readPrevious()).toBeNull()
  expect(await olderReader.nextCursor()).toBeNull()
})

it('rejects nextCursor and emits no unverified cursor when remaining budget is insufficient', async () => {
  const { context } = await fixture(lines('one', 'two'))
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const reader = await openWithBudget(context, budget)

  const item = await reader.readPrevious()
  expect(item?.value).toEqual({ id: 'two', text: 'exact 中 two' })

  budget.bytesRead = SESSION_HISTORY_MAX_PAGE_BYTES - 10

  await expect(reader.nextCursor('must-not-be-issued')).rejects.toMatchObject({
    code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
  })
})

it('rejects before allocation and IO when signal was aborted during pending fstat await barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-abort-'))
  roots.push(root)
  const filePath = join(root, 'abort-probe.txt')
  await writeFile(filePath, 'hello world'.repeat(50))

  const file = await openFile(filePath, constants.O_RDONLY)
  try {
    const controller = new AbortController()
    const origStat = file.stat.bind(file)
    let statPending = false
    let statFinished = false
    let resolveBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { resolveBarrier = resolve })

    file.stat = (async (...args: Parameters<typeof origStat>) => {
      statPending = true
      const res = await origStat(...args)
      await barrier
      statFinished = true
      return res
    }) as typeof file.stat

    // Initiate stat await barrier
    const statPromise = file.stat()
    expect(statPending).toBe(true)
    expect(statFinished).toBe(false)

    // Abort while stat is actively pending in flight
    controller.abort(new Error('cancelled-during-fstat'))

    // Release barrier so stat completes
    resolveBarrier()
    const st = await statPromise
    expect(statFinished).toBe(true)
    expect(st.isFile()).toBe(true)
    expect(controller.signal.aborted).toBe(true)

    let readCalled = false
    const origRead = file.read.bind(file)
    file.read = (async (...args: Parameters<typeof origRead>) => {
      readCalled = true
      return origRead(...args)
    }) as typeof file.read

    const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
    await expect(readNativeHistoryBytes(file, 0, 234, controller.signal, budget)).rejects.toThrow('cancelled-during-fstat')

    expect(readCalled).toBe(false)
    expect(budget.bytesRead).toBe(0)
  } finally {
    // Borrowed handle is closed by caller in finally
    await file.close()
  }
})

it('wraps physical FileHandle.read across aux JSON and dual JSONL readers, verifying call counts, exact bytes, fingerprints, and shared limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-wrapped-'))
  roots.push(root)

  // 1. Auxiliary JSON file
  const metaPath = join(root, 'summary.json')
  const metaPayload = { id: 'aux-meta-001', kind: 'meta', version: 1 }
  const metaBuffer = Buffer.from(JSON.stringify(metaPayload))
  await writeFile(metaPath, metaBuffer)

  // 2. Transcript 1 (3 records)
  const t1Path = join(root, 'transcript1.jsonl')
  await writeFile(t1Path, lines('t1-alpha', 't1-beta', 't1-gamma'))
  const t1Context: AgentProviderSessionHistoryContext = {
    source: { providerId: 'pi', nativeSessionId: 'sess-1' },
    transcriptPath: t1Path, command: 'unused', args: [], env: {}, workspacePath: root, limit: 10, signal: new AbortController().signal
  }

  // 3. Transcript 2 (2 records)
  const t2Path = join(root, 'transcript2.jsonl')
  await writeFile(t2Path, lines('t2-delta', 't2-epsilon'))
  const t2Context: AgentProviderSessionHistoryContext = {
    source: { providerId: 'pi', nativeSessionId: 'sess-2' },
    transcriptPath: t2Path, command: 'unused', args: [], env: {}, workspacePath: root, limit: 10, signal: new AbortController().signal
  }

  // Probe a dummy FileHandle to obtain the FileHandle prototype
  const probeHandle = await openFile(metaPath, constants.O_RDONLY)
  const proto = Object.getPrototypeOf(probeHandle)
  await probeHandle.close()

  type PhysicalReadLog = { position: number; requested: number; returned: number }
  const physicalReads: PhysicalReadLog[] = []
  const origProtoRead = proto.read

  proto.read = async function(buffer: Buffer, offset: number, length: number, position: number | null) {
    const res = await origProtoRead.apply(this, [buffer, offset, length, position])
    physicalReads.push({
      position: position ?? 0,
      requested: length,
      returned: res.bytesRead
    })
    return res
  }

  const sharedBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const signal = new AbortController().signal

  try {
    // Step 1: Auxiliary JSON read via readNativeHistoryBytes
    const metaFile = await openFile(metaPath, constants.O_RDONLY)
    let metaBytes: Buffer
    try {
      metaBytes = await readNativeHistoryBytes(metaFile, 0, metaBuffer.length, signal, sharedBudget)
    } finally {
      await metaFile.close()
    }
    expect(metaBytes.length).toBe(metaBuffer.length)
    expect(JSON.parse(metaBytes.toString('utf8'))).toEqual(metaPayload)
    expect(physicalReads.length).toBe(1)
    expect(physicalReads[0]).toEqual({
      position: 0,
      requested: metaBuffer.length,
      returned: metaBuffer.length
    })
    expect(sharedBudget.bytesRead).toBe(metaBuffer.length)

    // Step 2: First JSONL reader
    const reader1 = await openWithBudget(t1Context, sharedBudget)
    const rec1 = await reader1.readPrevious()
    expect(rec1?.value).toEqual({ id: 't1-gamma', text: 'exact 中 t1-gamma' })

    const cursor1 = await reader1.nextCursor('cont-t1')
    expect(cursor1).toBeTypeOf('string')
    expect(cursor1!.length).toBeGreaterThan(0)

    // Verify fingerprint reads occurred physically (head and tail fingerprints each read Math.min(128, cut))
    const t1Size = (await readFile(t1Path)).length
    const expectedFingerprintLen = Math.min(128, t1Size)
    const fingerprintReads = physicalReads.filter((r) => r.requested === expectedFingerprintLen)
    expect(fingerprintReads.length).toBeGreaterThanOrEqual(2)

    // Step 3: Second JSONL reader sharing the same budget
    const reader2 = await openWithBudget(t2Context, sharedBudget)
    const rec2 = await reader2.readPrevious()
    expect(rec2?.value).toEqual({ id: 't2-epsilon', text: 'exact 中 t2-epsilon' })

    // Step 4: Validate cumulative physical counts and byte sums
    expect(physicalReads.length).toBeGreaterThanOrEqual(4)
    const totalRequested = physicalReads.reduce((sum, r) => sum + r.requested, 0)
    const totalReturned = physicalReads.reduce((sum, r) => sum + r.returned, 0)
    expect(totalReturned).toBe(totalRequested)
    expect(sharedBudget.bytesRead).toBe(totalRequested)
    expect(totalRequested).toBeLessThan(SESSION_HISTORY_MAX_PAGE_BYTES)

    // Step 5: Enforce shared upper bound - request that exceeds budget rejects before any physical FileHandle.read
    const callCountBeforeLimit = physicalReads.length
    const probeFile = await openFile(metaPath, constants.O_RDONLY)
    try {
      const overLength = SESSION_HISTORY_MAX_PAGE_BYTES - sharedBudget.bytesRead + 1
      await expect(readNativeHistoryBytes(probeFile, 0, overLength, signal, sharedBudget)).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
      // ZERO physical reads occurred for the rejected call
      expect(physicalReads.length).toBe(callCountBeforeLimit)
    } finally {
      await probeFile.close()
    }
  } finally {
    proto.read = origProtoRead
  }
})

it('enforces real deadline, preserves short read diagnostics without refund, and verifies FD lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-native-deadline-'))
  roots.push(root)
  const filePath = join(root, 'target.bin')
  await writeFile(filePath, Buffer.from('1234567890'))

  const file = await openFile(filePath, constants.O_RDONLY)
  const signal = new AbortController().signal
  try {
    const expiredBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() - 10_001 }
    await expect(readNativeHistoryBytes(file, 0, 5, signal, expiredBudget)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_TIMEOUT'
    })
    expect(expiredBudget.bytesRead).toBe(0)

    const paramBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
    await expect(readNativeHistoryBytes(file, -1, 5, signal, paramBudget)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
    })
    await expect(readNativeHistoryBytes(file, 0, -1, signal, paramBudget)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
    })

    const shortBudget: NativeHistoryReadBudget = { bytesRead: 50, startedAt: Date.now() }
    await expect(readNativeHistoryBytes(file, 0, 100, signal, shortBudget)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
    expect(shortBudget.bytesRead).toBe(150)

    const validBudget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
    const buf = await readNativeHistoryBytes(file, 0, 5, signal, validBudget)
    expect(buf.toString('utf8')).toBe('12345')
    expect(validBudget.bytesRead).toBe(5)
    const st = await file.stat()
    expect(st.isFile()).toBe(true)
  } finally {
    await file.close()
  }

  const { context } = await fixture(lines('item-one'))
  const reader = await open(context)
  expect((await reader.readPrevious())?.value.id).toBe('item-one')
  await reader.close()
  await expect(reader.readFirst()).rejects.toThrow()
})

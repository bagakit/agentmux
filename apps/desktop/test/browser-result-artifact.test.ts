import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { durableWriteFile } from '@agentmux/core'
import { durableWriteFile as realWrite, DurableWriteError } from '../../../packages/core/src/durable-write'
import { BrowserResultArtifactStore, readBrowserResultArtifact } from '@agentmux/browser/operations'
import { runBrowserScript } from '@agentmux/browser/operations'
import { browserRunOutcomeFromFailure } from '@agentmux/browser/operations'
import { BROWSER_RESULT_INLINE_BYTES, BROWSER_RESULT_MAX_BYTES, BROWSER_RESULT_MAX_READ_BYTES,
  type BrowserResultArtifactReference, type BrowserResultContext } from '@agentmux/browser/model'

const context: BrowserResultContext = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const owner = { workspaceId: context.workspaceId, browserId: context.browserId }
const fault = vi.hoisted(() => ({ remove: '', syncDirectory: '' }))
vi.mock('@agentmux/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core')>()
  return { ...actual, durableWriteFile: vi.fn(actual.durableWriteFile) }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === fault.remove) throw Object.assign(new Error('owned cleanup denied'), { code: 'EACCES' })
      return await actual.rm(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === fault.syncDirectory) handle.sync = async () => { throw new Error('directory acknowledgement unavailable') }
      return handle
    }
  }
})
const owned: string[] = []
afterEach(async () => {
  fault.remove = ''; fault.syncDirectory = ''
  vi.mocked(durableWriteFile).mockImplementation(realWrite)
  vi.restoreAllMocks()
  for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(value: unknown = 'seed') {
  const directory = await mkdtemp(join(tmpdir(), 'amux-result-test-'))
  owned.push(directory)
  const source = join(directory, 'source.json')
  const storePath = join(directory, 'artifacts')
  await writeFile(source, JSON.stringify(value), { mode: 0o600 })
  const store = new BrowserResultArtifactStore(storePath)
  return { directory, source, storePath, store }
}

async function fill(store: BrowserResultArtifactStore) {
  const references: BrowserResultArtifactReference[] = []
  for (let n = 0; n < 128; n++) references.push(await store.registerJSON({ ...context, operationId: `retained-${n}` }, { n }))
  return references
}

async function expectRetained(store: BrowserResultArtifactStore, references: BrowserResultArtifactReference[]) {
  for (const [n, reference] of references.entries()) {
    const read = await readBrowserResultArtifact(store, reference, owner)
    expect(JSON.parse(Buffer.from(read.data, 'base64').toString('utf8'))).toEqual({ n })
  }
}

describe('bounded durable Browser result continuation', () => {
  it.each(['data', 'json'])('pre-publication %s failure preserves every published reference at capacity', async extension => {
    const { store, storePath } = await fixture()
    const references = await fill(store)
    const before = (await readdir(storePath)).sort()
    const failure = Object.assign(new Error('candidate disk full'), { code: 'ENOSPC' })
    vi.mocked(durableWriteFile).mockImplementation(async (path, bytes, options) => {
      if (path.endsWith(`.${extension}`)) throw new DurableWriteError(path, 'before-replace', failure)
      await realWrite(path, bytes, options)
    })
    await expect(store.registerJSON(context, { next: true })).rejects.toMatchObject({ code: 'ENOSPC', phase: 'before-replace' })
    expect((await readdir(storePath)).sort()).toEqual(before)
    await expectRetained(new BrowserResultArtifactStore(storePath), references)
  }, 30_000)

  it('directory ACK unknown preserves its exact candidate and old references before another explicit candidate', async () => {
    const { store, storePath } = await fixture()
    const references = await fill(store)
    let candidate = ''
    vi.mocked(durableWriteFile).mockImplementation(async (path, bytes, options) => {
      if (path.endsWith('.json')) { candidate = path; fault.syncDirectory = storePath; expect(options?.requireDirectorySync).toBe(true) }
      await realWrite(path, bytes, options)
    })
    await expect(store.registerJSON(context, { next: 'unconfirmed' })).rejects.toMatchObject({ path: candidate || expect.any(String), phase: 'after-replace' })
    expect(candidate).not.toBe('')
    const document = JSON.parse(await readFile(candidate, 'utf8'))
    expect(document.reference.byteLength).toBe(Buffer.byteLength(JSON.stringify({ next: 'unconfirmed' })))
    await expectRetained(new BrowserResultArtifactStore(storePath), references)
    expect((await readdir(storePath)).length).toBe(258)
    const writes = vi.mocked(durableWriteFile).mock.calls.length
    await expect(store.registerJSON(context, { next: 'no second candidate' })).rejects.toThrow('directory acknowledgement unavailable')
    expect(vi.mocked(durableWriteFile).mock.calls.length).toBe(writes)
    expect((await readdir(storePath)).length).toBe(258)
    fault.syncDirectory = ''
    vi.mocked(durableWriteFile).mockImplementation(realWrite)
    const latest = await store.registerJSON(context, { next: 'explicit later request' })
    const restarted = new BrowserResultArtifactStore(storePath)
    for (const reference of [document.reference, latest]) expect((await restarted.read(reference, owner)).returnedBytes).toBeGreaterThan(0)
    expect((await readdir(storePath)).length).toBe(256)
  }, 30_000)

  it('committed reference survives retention failure and no second candidate bypasses unfinished cleanup', async () => {
    const { store, storePath } = await fixture()
    const references = await fill(store)
    fault.remove = join(storePath, `${references[0]!.id}.json`)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reference = await store.registerJSON(context, { committed: true })
    expect(warning).toHaveBeenCalledWith('Browser result committed; retention cleanup remains incomplete.', expect.objectContaining({ reference, error: expect.any(Error) }))
    expect((await new BrowserResultArtifactStore(storePath).read(reference, owner)).returnedBytes).toBeGreaterThan(0)
    expect((await readdir(storePath)).length).toBe(258)
    const writes = vi.mocked(durableWriteFile).mock.calls.length
    await expect(store.registerJSON(context, { notAdmitted: true })).rejects.toThrow('owned cleanup denied')
    expect(vi.mocked(durableWriteFile).mock.calls.length).toBe(writes)
    expect((await readdir(storePath)).length).toBe(258)
    fault.remove = ''
    const latest = await store.registerJSON(context, { healthy: true })
    const restarted = new BrowserResultArtifactStore(storePath)
    for (const item of [reference, latest]) expect((await restarted.read(item, owner)).returnedBytes).toBeGreaterThan(0)
    expect((await readdir(storePath)).length).toBe(256)
  }, 30_000)

  it('candidate cleanup failure preserves the original write error and published results', async () => {
    const { store, storePath } = await fixture()
    const references = await fill(store)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let original: DurableWriteError | undefined
    vi.mocked(durableWriteFile).mockImplementation(async (path, bytes, options) => {
      if (path.endsWith('.json')) {
        fault.remove = path.replace(/\.json$/, '.data')
        original = new DurableWriteError(path, 'before-replace', Object.assign(new Error('candidate full'), { code: 'ENOSPC' }))
        throw original
      }
      await realWrite(path, bytes, options)
    })
    let caught: unknown
    try { await store.registerJSON(context, { unpublished: true }) } catch (error) { caught = error }
    expect(caught).toBe(original)
    expect(caught).toMatchObject({ code: 'ENOSPC', phase: 'before-replace' })
    expect(warning).toHaveBeenCalledWith('Browser result candidate cleanup failed; original write error retained.', expect.objectContaining({ error: expect.objectContaining({ code: 'EACCES' }) }))
    await expectRetained(store, references)
    expect((await readdir(storePath)).length).toBe(257)
  }, 30_000)

  it('the original tail admits one bounded candidate while later captures wait', async () => {
    const { store, storePath } = await fixture()
    const references = await fill(store)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    let metadataWrites = 0, largestFileCount = 0, secondLoads = 0
    vi.mocked(durableWriteFile).mockImplementation(async (path, bytes, options) => {
      if (path.endsWith('.json') && ++metadataWrites === 1) { entered(); await gate }
      await realWrite(path, bytes, options)
      largestFileCount = Math.max(largestFileCount, (await readdir(storePath)).length)
    })
    const first = store.registerJSON(context, { first: '候选🙂' })
    await reached
    const second = store.registerJSON(context, { get later() { secondLoads++; return 'original later capture' } })
    try {
      expect(metadataWrites).toBe(1)
      expect(secondLoads).toBe(0)
      expect((await readdir(storePath)).length).toBe(257)
      await expectRetained(store, references)
    } finally { release() }
    const saved = await Promise.all([first, second])
    expect(metadataWrites).toBe(2)
    expect(secondLoads).toBe(1)
    expect(largestFileCount).toBe(258)
    expect((await readdir(storePath)).length).toBe(256)
    const restarted = new BrowserResultArtifactStore(storePath)
    for (const reference of saved) expect((await restarted.read(reference, owner)).returnedBytes).toBeGreaterThan(0)
  }, 30_000)

  it('a clock rollback cannot evict the just-confirmed reference at capacity', async () => {
    const { store, storePath } = await fixture()
    await fill(store)
    vi.spyOn(Date, 'now').mockReturnValue(1)
    const reference = await store.registerJSON(context, { rollback: 'still published' })
    expect(reference.capturedAt).toBe(1)
    expect((await readdir(storePath)).length).toBe(256)
    const read = await new BrowserResultArtifactStore(storePath).read(reference, owner)
    expect(JSON.parse(Buffer.from(read.data, 'base64').toString('utf8'))).toEqual({ rollback: 'still published' })
  }, 30_000)

  it('rejects a repeated random allocation using its original index and keeps both full results readable', async () => {
    const { store, storePath } = await fixture()
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockReturnValueOnce(new Uint8Array(9))
    let first: BrowserResultArtifactReference
    try { first = await store.registerJSON(context, { original: 'full retained bytes' }) } finally { random.mockRestore() }
    expect(first.id).toBe('111111111111')
    const repeated = vi.spyOn(globalThis.crypto, 'getRandomValues').mockReturnValueOnce(new Uint8Array(9))
    let second: BrowserResultArtifactReference
    try { second = await store.registerJSON(context, { next: 'independent bytes' }); expect(repeated.mock.calls.length).toBeGreaterThan(1) } finally { repeated.mockRestore() }
    expect(second.id).not.toBe(first.id)
    const restarted = new BrowserResultArtifactStore(storePath)
    for (const [reference, expected] of [[first, { original: 'full retained bytes' }], [second, { next: 'independent bytes' }]] as const) {
      const read = await restarted.read(reference, owner)
      expect(JSON.parse(Buffer.from(read.data, 'base64').toString('utf8'))).toEqual(expected)
    }
  })

  it('reads an original UUID artifact after restart and retains it beside a newly allocated short ID', async () => {
    const { store, storePath } = await fixture()
    const current = await store.registerJSON(context, { retained: 'original' })
    const id = '11111111-1111-4111-8111-111111111111', reference = { ...current, id }
    const document = JSON.parse(await readFile(join(storePath, `${current.id}.json`), 'utf8'))
    document.reference = reference
    await writeFile(join(storePath, `${id}.json`), JSON.stringify(document))
    await writeFile(join(storePath, `${id}.data`), await readFile(join(storePath, `${current.id}.data`)))
    await rm(join(storePath, `${current.id}.json`)); await rm(join(storePath, `${current.id}.data`))
    const restarted = new BrowserResultArtifactStore(storePath)
    const next = await restarted.registerJSON(context, { new: true })
    expect(next.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    const read = await restarted.read(reference, owner)
    expect(JSON.parse(Buffer.from(read.data, 'base64').toString('utf8'))).toEqual({ retained: 'original' })
    expect((await readdir(storePath)).sort()).toEqual([`${id}.data`, `${id}.json`, `${next.id}.data`, `${next.id}.json`].sort())
  })

  it('Main JSON registration shares retained bytes, original ownership and restart reads with script imports', async () => {
    const { store, storePath } = await fixture()
    const value = { fields: [{ key: 'empty', value: '' }, { key: 'zero', value: 0 }, { key: 'flag', value: false }], text: '中文🙂'.repeat(8000) }
    const reference = await store.registerJSON(context, value)
    expect(reference.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(reference).toMatchObject({ ...context, kind: 'browser-result-artifact', byteLength: Buffer.byteLength(JSON.stringify(value)) })
    const restarted = new BrowserResultArtifactStore(storePath)
    const first = await restarted.read(reference, owner, { maxBytes: 65536 })
    expect(first.returnedBytes).toBe(65536)
    expect(first.nextOffset).toBe(65536)
    const second = await restarted.read(reference, owner, { offset: first.nextOffset!, maxBytes: 65536 })
    expect(second.returnedBytes).toBeGreaterThan(0)
    expect(second.nextOffset).toBeNull()
    expect(JSON.parse(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]).toString('utf8'))).toEqual(value)
    await expect(restarted.read({ ...reference, navigationId: 'forged' }, owner)).rejects.toThrow(/original operation/)
    await expect(store.registerJSON({ ...context, workspaceId: null }, value)).rejects.toThrow(/Workspace binding/)
    await expect(store.registerJSON(context, undefined)).rejects.toThrow(/not JSON/)
    await expect(store.registerJSON(context, 'x'.repeat(BROWSER_RESULT_MAX_BYTES))).rejects.toThrow(/storage budget/)
    expect((await store.read(reference, owner)).returnedBytes).toBeGreaterThan(0)
  })

  it('real runner returns a bounded artifact; restart/byte slices recover JSON without rerunning actions', async () => {
    const { store, storePath } = await fixture()
    let actions = 0
    let captures = 0
    let capturedPath = ''
    const value = { text: '中文🙂'.repeat(150_000), count: 7 }
    const result = await runBrowserScript({
      code: 'await click("@e1"); console.log("action completed"); return {text:"中文🙂".repeat(150000),count:7}',
      onPageCall: async name => { expect(name).toBe('click'); actions += 1 },
      captureResultArtifact: async source => {
        captures += 1
        capturedPath = source
        expect((await stat(source)).mode & 0o777).toBe(0o600)
        return await store.import(context, source)
      }
    })
    expect(result.completed, JSON.stringify(result)).toBe(true)
    expect(result.logs).toEqual(['action completed'])
    expect(actions).toBe(1)
    expect(captures).toBe(1)
    expect(result.capture?.stdoutBytes).toBeLessThan(512)
    expect(result.capture?.peakBufferedBytes).toBeLessThan(512)
    const reference = (result as { value: BrowserResultArtifactReference }).value
    expect(reference).toMatchObject({ ...context, kind: 'browser-result-artifact', format: 'json', maxReadBytes: BROWSER_RESULT_MAX_READ_BYTES })
    expect(reference.byteLength).toBe(Buffer.byteLength(JSON.stringify(value)))
    expect(result.capture?.resultBytes).toBe(reference.byteLength)
    expect(JSON.stringify(reference).length).toBeLessThan(1024)
    await expect(stat(capturedPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = new BrowserResultArtifactStore(storePath)
    const chunks: Buffer[] = []
    let offset: number | null = 0
    let maxRead = 0
    while (offset !== null) {
      // 49,153 deliberately splits UTF8 and crosses integrity-block boundaries.
      const chunk = await readBrowserResultArtifact(restarted, reference, owner, { offset, maxBytes: 49_153 })
      expect(chunk.offset).toBe(offset)
      expect(chunk.returnedBytes).toBeGreaterThan(0)
      expect(chunk.returnedBytes).toBeLessThanOrEqual(49_153)
      expect(chunk.readCost.metadataBytes).toBeGreaterThan(0)
      maxRead = Math.max(maxRead, chunk.readCost.payloadBytes)
      expect(chunk.totalBytes).toBe(reference.byteLength)
      chunks.push(Buffer.from(chunk.data, chunk.encoding))
      offset = chunk.nextOffset
    }
    expect(chunks.length).toBeGreaterThan(20)
    expect(maxRead).toBeLessThanOrEqual(2 * BROWSER_RESULT_MAX_READ_BYTES)
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(value)
    expect(actions).toBe(1)
    expect(captures).toBe(1)
  }, 30_000)

  it('small/empty values stay inline and never call artifact capture', async () => {
    const seen: unknown[] = []
    let captures = 0
    for (const code of ['return undefined', 'return null', 'return []', 'return {ok:true}', `return 'x'.repeat(${BROWSER_RESULT_INLINE_BYTES - 2})`]) {
      const result = await runBrowserScript({ code, captureResultArtifact: async () => { captures += 1; throw new Error('small results must not reach storage') } })
      expect(result.completed, JSON.stringify(result)).toBe(true)
      seen.push(result.completed ? result.value : result.failure)
    }
    expect(seen).toEqual([undefined, null, [], { ok: true }, 'x'.repeat(BROWSER_RESULT_INLINE_BYTES - 2)])
    expect(captures).toBe(0)
  }, 30_000)

  it('failed storage/unknown Workspace/oversized result report indeterminate after one action, never empty success', async () => {
    const { store } = await fixture()
    let actions = 0
    const failures = []
    for (const captureResultArtifact of [
      async () => { throw new Error('disk is unavailable') },
      (source: string) => store.import({ ...context, workspaceId: null }, source),
      undefined
    ]) {
      const result = await runBrowserScript({ code: 'await click("@e1"); return "x".repeat(1100000)',
        onPageCall: async () => { actions += 1 }, ...(captureResultArtifact ? { captureResultArtifact } : {}) })
      expect(result.completed).toBe(false)
      if (result.completed) throw new Error('missing large result was reported as success')
      expect(result.failure.kind).toBe('result-unavailable')
      const outcome = browserRunOutcomeFromFailure(result.failure)
      expect(outcome.kind).toBe('indeterminate')
      expect(outcome.kind !== 'completed' && outcome.message).toContain('Do not automatically rerun')
      failures.push(result.failure)
    }
    expect(failures).toHaveLength(3)
    expect(actions).toBe(3)
    let captures = 0
    const oversized = await runBrowserScript({ code: `return 'x'.repeat(${BROWSER_RESULT_MAX_BYTES})`, captureResultArtifact: async source => { captures += 1; return await store.import(context, source) } })
    expect(oversized.completed).toBe(false)
    expect(!oversized.completed && oversized.failure.kind).toBe('result-unavailable')
    expect(captures).toBe(0)
    expect(oversized.capture?.stdoutBytes).toBeLessThan(512)
    const healthy = await runBrowserScript({ code: 'return "still healthy"' })
    expect(healthy.completed && healthy.value).toBe('still healthy')
  }, 30_000)

  it('reference and stored original identity cannot be changed, while a new read operation/navigation is not required', async () => {
    const { store, source, storePath } = await fixture({ text: 'retained' })
    const reference = await store.import(context, source)
    const changed = [
      { ...reference, operationId: 'another-operation' }, { ...reference, navigationId: 'another-document' },
      { ...reference, workspaceId: 'foreign-workspace' }, { ...reference, browserId: 'foreign-browser' },
      { ...reference, byteLength: reference.byteLength + 1 }, { ...reference, capturedAt: reference.capturedAt + 1 },
      { ...reference, id: '../outside' }
    ]
    for (const forged of changed) await expect(store.read(forged, owner)).rejects.toThrow()
    await expect(store.read({ ...reference, id: '../outside' }, owner)).rejects.toThrow('Workspace and Browser')
    expect(changed).toHaveLength(7)
    for (const current of [{ ...owner, workspaceId: 'foreign-workspace' }, { ...owner, browserId: 'foreign-browser' }, { ...owner, workspaceId: null }]) {
      await expect(store.read(reference, current)).rejects.toThrow(/Workspace and Browser/)
    }
    const restarted = new BrowserResultArtifactStore(storePath)
    const saved = await restarted.read(reference, owner)
    expect(JSON.parse(Buffer.from(saved.data, saved.encoding).toString('utf8'))).toEqual({ text: 'retained' })
    const metadataPath = join(storePath, `${reference.id}.json`)
    const document = JSON.parse(await readFile(metadataPath, 'utf8'))
    document.reference.operationId = 'different-original-operation'
    await writeFile(metadataPath, JSON.stringify(document))
    await expect(restarted.read(reference, owner)).rejects.toThrow(/original operation/)
  })

  it('bounded reads reject invalid budgets and return precise EOF rather than pretending there is another segment', async () => {
    const { store, source } = await fixture('中文🙂')
    const reference = await store.import(context, source)
    for (const options of [{ offset: -1 }, { offset: 1.5 }, { offset: reference.byteLength + 1 }, { maxBytes: 0 }, { maxBytes: BROWSER_RESULT_MAX_READ_BYTES + 1 }, { maxBytes: Infinity }]) {
      await expect(store.read(reference, owner, options)).rejects.toThrow()
    }
    const chunk = await store.read(reference, owner, { offset: 1, maxBytes: 1 })
    expect(chunk.returnedBytes).toBe(1)
    expect(chunk.nextOffset).toBe(2)
    expect(Buffer.from(chunk.data, chunk.encoding)).toEqual(Buffer.from(JSON.stringify('中文🙂')).subarray(1, 2))
    const end = await store.read(reference, owner, { offset: reference.byteLength })
    expect(end).toMatchObject({ data: '', returnedBytes: 0, nextOffset: null, readCost: { payloadBytes: 0 } })
  })

  it('missing, truncated or same-length modified data is explicitly unavailable; imports reject symlinks and over-budget sources', async () => {
    const { store, source, storePath, directory } = await fixture('original bytes')
    const reference = await store.import(context, source)
    const payload = join(storePath, `${reference.id}.data`)
    const original = await readFile(payload)
    const changed = Buffer.from(original)
    changed[1] = changed[1]! ^ 1
    await writeFile(payload, changed)
    await expect(store.read(reference, owner)).rejects.toThrow(/integrity/)
    await writeFile(payload, original.subarray(0, original.length - 1))
    await expect(store.read(reference, owner)).rejects.toThrow(/truncated/)
    await rm(payload)
    await expect(store.read(reference, owner)).rejects.toMatchObject({ code: 'ENOENT' })
    await symlink(source, join(directory, 'linked.json'))
    await expect(store.import(context, join(directory, 'linked.json'))).rejects.toThrow()
    await writeFile(source, 'x'.repeat(BROWSER_RESULT_MAX_BYTES + 1))
    await expect(store.import(context, source)).rejects.toThrow(/budget/)
  })

  it('storage is capped at 64 MiB including metadata and preserves unrelated files', async () => {
    const { store, source, storePath } = await fixture('x'.repeat(BROWSER_RESULT_MAX_BYTES - 2))
    let peakOwnedBytes = 0
    vi.mocked(durableWriteFile).mockImplementation(async (path, bytes, options) => {
      await realWrite(path, bytes, options)
      const sizes = await Promise.all((await readdir(storePath)).filter(name => /\.(json|data)$/.test(name)).map(name => stat(join(storePath, name))))
      peakOwnedBytes = Math.max(peakOwnedBytes, sizes.reduce((sum, info) => sum + info.size, 0))
    })
    const references: BrowserResultArtifactReference[] = []
    for (let i = 0; i < 9; i += 1) references.push(await store.import({ ...context, operationId: `operation-${i}` }, source))
    await writeFile(join(storePath, 'unrelated.txt'), 'preserve me')
    const payloadNames = (await readdir(storePath)).filter(name => /\.(json|data)$/.test(name))
    expect(payloadNames.length).toBeGreaterThan(0)
    const bytes = (await Promise.all(payloadNames.map(name => stat(join(storePath, name))))).reduce((sum, info) => sum + info.size, 0)
    expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(peakOwnedBytes).toBeGreaterThan(64 * 1024 * 1024)
    expect(peakOwnedBytes).toBeLessThanOrEqual(64 * 1024 * 1024 + BROWSER_RESULT_MAX_BYTES + 16 * 1024)
    await expect(store.read(references[0]!, owner)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.read(references.at(-1)!, owner)).returnedBytes).toBe(16 * 1024)
    expect(await readFile(join(storePath, 'unrelated.txt'), 'utf8')).toBe('preserve me')
  }, 30_000)

  it('startup discards interrupted owned payloads and capture keeps its original context', async () => {
    const { store, source, storePath } = await fixture({ retained: true })
    await mkdir(storePath)
    const orphan = join(storePath, `${randomUUID()}.data`)
    await writeFile(orphan, 'an interrupted unpublished result')
    await writeFile(join(storePath, 'unrelated.data'), 'leave this alone')
    const mutable = { ...context }
    const pending = store.import(mutable, source)
    mutable.operationId = 'later-operation'
    mutable.navigationId = 'later-navigation'
    const reference = await pending
    expect(reference.operationId).toBe(context.operationId)
    expect(reference.navigationId).toBe(context.navigationId)
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(storePath, 'unrelated.data'), 'utf8')).toBe('leave this alone')
    expect((await store.read(reference, owner)).returnedBytes).toBeGreaterThan(0)
  })

  it('the largest permitted continuation chunk stays inline through the real runner', async () => {
    const { store, source } = await fixture('x'.repeat(250_000))
    const reference = await store.import(context, source)
    const chunk = await store.read(reference, owner, { maxBytes: BROWSER_RESULT_MAX_READ_BYTES })
    expect(chunk.returnedBytes).toBe(BROWSER_RESULT_MAX_READ_BYTES)
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(BROWSER_RESULT_INLINE_BYTES)
    let captures = 0
    const result = await runBrowserScript({ code: `return ${JSON.stringify(chunk)}`,
      captureResultArtifact: async sourcePath => { captures += 1; return await store.import(context, sourcePath) } })
    expect(result.completed && result.value).toEqual(chunk)
    expect(captures).toBe(0)
  }, 30_000)
})

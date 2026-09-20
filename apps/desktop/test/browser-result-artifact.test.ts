import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserResultArtifactStore, readBrowserResultArtifact } from '../src/main/browser-result-artifact.js'
import { runBrowserScript } from '../src/main/browser-script-runner.js'
import { browserRunOutcomeFromFailure } from '../src/main/browser-run-outcome.js'
import { BROWSER_RESULT_INLINE_BYTES, BROWSER_RESULT_MAX_BYTES, BROWSER_RESULT_MAX_READ_BYTES,
  type BrowserResultArtifactReference, type BrowserResultContext } from '../src/shared/browser-result-artifact.js'

const context: BrowserResultContext = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const owner = { workspaceId: context.workspaceId, browserId: context.browserId }
const owned: string[] = []
afterEach(async () => { for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(value: unknown = 'seed') {
  const directory = await mkdtemp(join(tmpdir(), 'amux-result-test-'))
  owned.push(directory)
  const source = join(directory, 'source.json')
  const storePath = join(directory, 'artifacts')
  await writeFile(source, JSON.stringify(value), { mode: 0o600 })
  const store = new BrowserResultArtifactStore(storePath)
  return { directory, source, storePath, store }
}

describe('bounded durable Browser result continuation', () => {
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
    const references: BrowserResultArtifactReference[] = []
    for (let i = 0; i < 9; i += 1) references.push(await store.import({ ...context, operationId: `operation-${i}` }, source))
    await writeFile(join(storePath, 'unrelated.txt'), 'preserve me')
    const payloadNames = (await readdir(storePath)).filter(name => /\.(json|data)$/.test(name))
    expect(payloadNames.length).toBeGreaterThan(0)
    const bytes = (await Promise.all(payloadNames.map(name => stat(join(storePath, name))))).reduce((sum, info) => sum + info.size, 0)
    expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const io = vi.hoisted(() => ({ rename: vi.fn(), rm: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  io.rename.mockImplementation(actual.rename)
  io.rm.mockImplementation(actual.rm)
  return { ...actual, rename: io.rename, rm: io.rm }
})

import { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'
import {
  BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX, BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES,
  type BrowserRecoveryPreview, type BrowserRecoveryPreviewScope
} from '../src/shared/browser-recovery-preview.js'

const scope: BrowserRecoveryPreviewScope = {
  browserId: 'original-browser', profileId: 'original-profile', mode: 'normal', workspaceId: 'original-workspace'
}
// Storage checks canonical bounded JPEG framing. Actual native decoding belongs to the capture producer.
const jpeg = BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
const preview = (actual: BrowserRecoveryPreviewScope = scope, title = 'Previously viewed page'): BrowserRecoveryPreview => ({
  scope: { ...actual }, url: 'https://preview.invalid/old-page', title,
  navigationId: 'original-document', capturedAt: 1, image: { dataUrl: jpeg, width: 320, height: 200 }
})
const roots: string[] = []
const stores: BrowserRecoveryPreviewStore[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const pathFor = (directory: string, actual = scope) => join(directory, hash(actual.profileId!), `${hash(actual.browserId)}.json`)
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-recovery-preview-'))
  roots.push(directory)
  const store = new BrowserRecoveryPreviewStore(directory)
  stores.push(store)
  return { directory, store, path: pathFor(directory) }
}
function latch() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

beforeEach(() => { io.rename.mockClear(); io.rm.mockClear() })
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('optional Browser recovery preview owner', () => {
  it('persists one complete normal record and reads its original source in a new owner without a live page', async () => {
    const f = await fixture(), original = preview()
    expect(await f.store.read(scope)).toEqual({ status: 'missing' })
    expect(await f.store.record(scope, original, () => true)).toEqual({ status: 'recorded' })
    original.title = 'Caller changed after publication'
    const restarted = new BrowserRecoveryPreviewStore(f.directory)
    expect(await restarted.read(scope)).toEqual({ status: 'available', preview: preview() })
    const files = await readdir(dirname(f.path))
    expect(files).toEqual([`${hash(scope.browserId)}.json`])
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ version: 1, preview: preview() })
    if (process.platform !== 'win32') expect((await stat(f.path)).mode & 0o777).toBe(0o600)
  })

  it('keeps private appearance only in this owner across reads and clears it at close or App end without disk IO', async () => {
    const f = await fixture(), privateScope: BrowserRecoveryPreviewScope = { ...scope, mode: 'private', profileId: null }
    expect(await f.store.record(privateScope, preview(privateScope), () => true)).toEqual({ status: 'recorded' })
    const first = await f.store.read(privateScope)
    expect(first).toMatchObject({ status: 'available', preview: preview(privateScope) })
    if (first.status === 'available') first.preview.title = 'Reader mutation'
    expect(await f.store.read(privateScope)).toMatchObject({ status: 'available', preview: { title: 'Previously viewed page' } })
    expect(await new BrowserRecoveryPreviewStore(f.directory).read(privateScope)).toEqual({ status: 'missing' })
    expect(await readdir(f.directory)).toEqual([])
    expect(await f.store.remove(privateScope)).toEqual({ status: 'removed' })
    expect(await f.store.read(privateScope)).toEqual({ status: 'missing' })
    await f.store.record(privateScope, preview(privateScope), () => true)
    await f.store.dispose()
    expect(await f.store.read(privateScope)).toEqual({ status: 'missing' })
    expect(await readdir(f.directory)).toEqual([])
  })

  it('does not merge Browser, Profile, Workspace or normal/private scopes', async () => {
    const f = await fixture()
    await f.store.record(scope, preview(), () => true)
    expect(await f.store.read({ ...scope, browserId: 'other-browser' })).toEqual({ status: 'missing' })
    expect(await f.store.read({ ...scope, profileId: 'other-profile' })).toEqual({ status: 'missing' })
    expect(await f.store.read({ ...scope, workspaceId: 'other-workspace' })).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
    expect(await f.store.read({ ...scope, mode: 'private', profileId: null })).toEqual({ status: 'missing' })
    expect(await f.store.record(scope, preview({ ...scope, profileId: 'other-profile' }), () => true))
      .toMatchObject({ status: 'unavailable', warning: expect.any(String) })
    expect(await f.store.read(scope)).toMatchObject({ status: 'available', preview: preview(), warning: expect.any(String) })
  })

  it('keeps the previous view when a stale source is rejected, without requiring it to match a later failed URL', async () => {
    const f = await fixture()
    await f.store.record(scope, preview(), () => true)
    expect(await f.store.record(scope, { ...preview(), url: 'https://preview.invalid/new-page' }, () => false))
      .toEqual({ status: 'skipped' })
    expect(await f.store.read(scope)).toEqual({ status: 'available', preview: preview() })
  })

  it('rechecks the source after asynchronous preparation before publication', async () => {
    const f = await fixture()
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    expect(await f.store.record(scope, preview(), current)).toEqual({ status: 'skipped' })
    expect(io.rename).not.toHaveBeenCalled()
    expect(await f.store.read(scope)).toEqual({ status: 'missing' })
  })

  it('retires a publication which lost its original source while native IO was in flight', async () => {
    const f = await fixture(), entered = latch(), gate = latch()
    let current = true
    const rename = io.rename.getMockImplementation()!
    io.rename.mockImplementationOnce(async (...args) => { entered.release(); await gate.promise; return rename(...args) })
    const record = f.store.record(scope, preview(), () => current)
    await entered.promise; current = false; gate.release()
    expect(await record).toEqual({ status: 'skipped' })
    expect(await f.store.read(scope)).toEqual({ status: 'missing' })
  })

  it('leaves a previous record intact when its capture signal was already cancelled', async () => {
    const f = await fixture()
    await f.store.record(scope, preview(), () => true)
    const signal = AbortSignal.abort()
    expect(await f.store.record(scope, preview(scope, 'Cancelled view'), () => true, signal)).toEqual({ status: 'skipped' })
    expect(await f.store.read(scope)).toMatchObject({ status: 'available', preview: preview() })
  })

  it('orders explicit Close after a queued write so the old asynchronous write cannot resurrect it', async () => {
    const f = await fixture(), entered = latch(), gate = latch()
    const rename = io.rename.getMockImplementation()!
    io.rename.mockImplementationOnce(async (...args) => { entered.release(); await gate.promise; return rename(...args) })
    const record = f.store.record(scope, preview(), () => true)
    await entered.promise
    const remove = f.store.remove(scope), read = f.store.read(scope)
    gate.release()
    expect(await record).toEqual({ status: 'recorded' })
    expect(await remove).toEqual({ status: 'removed' })
    expect(await read).toEqual({ status: 'missing' })
  })

  it('clears only the exact Profile after its pending writes, leaving another Profile readable', async () => {
    const f = await fixture(), other = { ...scope, profileId: 'unaffected-profile' }
    await f.store.record(other, preview(other), () => true)
    const before = await readFile(pathFor(f.directory, other)), entered = latch(), gate = latch()
    const rename = io.rename.getMockImplementation()!
    io.rename.mockImplementationOnce(async (...args) => { entered.release(); await gate.promise; return rename(...args) })
    const record = f.store.record(scope, preview(), () => true)
    await entered.promise
    const clear = f.store.clearProfile(scope.profileId!)
    gate.release()
    expect(await record).toEqual({ status: 'recorded' })
    expect(await clear).toEqual({ status: 'removed' })
    expect(await f.store.read(scope)).toEqual({ status: 'missing' })
    expect(await readFile(pathFor(f.directory, other))).toEqual(before)
    expect(await f.store.read(other)).toMatchObject({ status: 'available' })
  })

  it('reports write failure while preserving the previous readable appearance and recovers on a later real write', async () => {
    const f = await fixture()
    await f.store.record(scope, preview(), () => true)
    const before = await readFile(f.path)
    io.rename.mockRejectedValueOnce(Object.assign(new Error('fixture write unavailable'), { code: 'EACCES' }))
    expect(await f.store.record(scope, preview(scope, 'Not confirmed'), () => true))
      .toMatchObject({ status: 'unavailable', warning: expect.stringContaining('EACCES') })
    expect(await readFile(f.path)).toEqual(before)
    expect(await f.store.read(scope)).toMatchObject({ status: 'available', preview: preview(), warning: expect.any(String) })
    expect(await f.store.record(scope, preview(scope, 'Later actual view'), () => true)).toEqual({ status: 'recorded' })
    expect(await f.store.read(scope)).toEqual({ status: 'available', preview: preview(scope, 'Later actual view') })
    expect(await readdir(dirname(f.path))).toEqual([`${hash(scope.browserId)}.json`])
  })

  it.each([
    ['invalid JSON', '{'],
    ['bad UTF-8', Buffer.from([0xff])],
    ['oversized file', Buffer.alloc(BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES + 1)],
    ['wrong version', JSON.stringify({ version: 0, preview: preview() })],
    ['cross-scope file', JSON.stringify({ version: 1, preview: preview({ ...scope, browserId: 'other-browser' }) })],
    ['damaged image', JSON.stringify({ version: 1, preview: { ...preview(), image: { ...preview().image, dataUrl: BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX + 'AAAA' } } })]
  ])('keeps %s distinct from missing without overwriting the file', async (_name, bytes) => {
    const f = await fixture()
    await mkdir(dirname(f.path), { recursive: true }); await writeFile(f.path, bytes)
    const before = await readFile(f.path)
    expect(await f.store.read(scope)).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
    expect(await readFile(f.path)).toEqual(before)
    expect(io.rename).not.toHaveBeenCalled()
  })

  it('does not follow a substituted cache-file symlink or treat an inaccessible root as missing', async () => {
    const f = await fixture(), outside = join(f.directory, 'unrelated-file')
    await writeFile(outside, JSON.stringify({ version: 1, preview: preview() }))
    await mkdir(dirname(f.path), { recursive: true }); await symlink(outside, f.path)
    expect(await f.store.read(scope)).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
    expect(await readFile(outside, 'utf8')).toContain('Previously viewed page')
    const badRoot = new BrowserRecoveryPreviewStore(outside)
    expect(await badRoot.read(scope)).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
  })

  it('bounds metadata, encoded image and dimensions without removing a healthy existing record', async () => {
    const f = await fixture()
    await f.store.record(scope, preview(), () => true)
    for (const invalid of [
      { ...preview(), title: 'x'.repeat(BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES) },
      { ...preview(), image: { ...preview().image, width: 481 } },
      { ...preview(), image: { ...preview().image, height: 301 } },
      { ...preview(), image: { ...preview().image, dataUrl: BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX + Buffer.alloc(64 * 1024 + 1).toString('base64') } }
    ]) expect(await f.store.record(scope, invalid, () => true)).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
    expect(await f.store.read(scope)).toMatchObject({ status: 'available', preview: preview(), warning: expect.any(String) })
  })
})

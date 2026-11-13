import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'
import { BROWSER_PAGE_MEMORY_MAX_ENTRIES, type BrowserPageMemory } from '../src/shared/browser-page-memory.js'
import type { BrowserRecoveryPreviewScope } from '../src/shared/browser-recovery-preview.js'

const scope: BrowserRecoveryPreviewScope = { browserId: 'original-browser', profileId: 'original-profile', mode: 'normal', workspaceId: 'original-workspace' }
const privateScope: BrowserRecoveryPreviewScope = { browserId: 'private-browser', profileId: null, mode: 'private', workspaceId: null }
const icon = 'data:image/png;base64,iVBORw0KGgo='
const memory = (actual: BrowserRecoveryPreviewScope = scope): BrowserPageMemory => ({
  scope: { ...actual }, url: 'https://page.invalid/current', favicon: { dataUrl: icon },
  history: { index: 1, entries: [{ url: 'https://page.invalid/start', title: 'Start' }, { url: 'https://page.invalid/current', title: 'Current' }] }
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
const stores: BrowserRecoveryPreviewStore[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-page-memory-'))
  roots.push(directory)
  const store = new BrowserRecoveryPreviewStore(directory)
  stores.push(store)
  return { directory, store, pagePath: join(directory, hash(scope.profileId!), `${hash(scope.browserId)}.page.json`) }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Browser page memory in the last-seen appearance owner', () => {
  it('keeps a normal page memory across a new owner instance without a live page', async () => {
    const f = await fixture()
    expect(await f.store.readPage(scope)).toEqual({ status: 'missing' })
    expect(await f.store.recordPage(scope, memory(), () => true)).toEqual({ status: 'recorded' })
    const restarted = new BrowserRecoveryPreviewStore(f.directory)
    stores.push(restarted)
    expect(await restarted.readPage(scope)).toEqual({ status: 'available', memory: memory() })
  })

  it('keeps private page memory in this process only', async () => {
    const f = await fixture()
    expect(await f.store.recordPage(privateScope, memory(privateScope), () => true)).toEqual({ status: 'recorded' })
    expect(await f.store.readPage(privateScope)).toEqual({ status: 'available', memory: memory(privateScope) })
    expect(await readdir(f.directory)).toEqual([])
    const restarted = new BrowserRecoveryPreviewStore(f.directory)
    stores.push(restarted)
    expect(await restarted.readPage(privateScope)).toEqual({ status: 'missing' })
  })

  it('drops page memory with the Browser close and with Profile deletion', async () => {
    const f = await fixture()
    await f.store.recordPage(scope, memory(), () => true)
    expect(await f.store.remove(scope)).toEqual({ status: 'removed' })
    expect(await f.store.readPage(scope)).toEqual({ status: 'missing' })
    await f.store.recordPage(privateScope, memory(privateScope), () => true)
    await f.store.remove(privateScope)
    expect(await f.store.readPage(privateScope)).toEqual({ status: 'missing' })
    await f.store.recordPage(scope, memory(), () => true)
    expect(await f.store.clearProfile(scope.profileId!)).toEqual({ status: 'removed' })
    expect(await f.store.readPage(scope)).toEqual({ status: 'missing' })
  })

  it('skips a superseded publication and refuses another scope or an unbounded record', async () => {
    const f = await fixture()
    expect(await f.store.recordPage(scope, memory(), () => false)).toEqual({ status: 'skipped' })
    expect(await f.store.readPage(scope)).toEqual({ status: 'missing' })
    expect((await f.store.recordPage(scope, memory({ ...scope, browserId: 'another' }), () => true)).status).toBe('unavailable')
    const entries = Array.from({ length: BROWSER_PAGE_MEMORY_MAX_ENTRIES + 1 }, (_, index) => ({ url: `https://page.invalid/${index}`, title: '' }))
    expect((await f.store.recordPage(scope, { ...memory(), history: { index: 0, entries } }, () => true)).status).toBe('unavailable')
    expect((await f.store.recordPage(scope, { ...memory(), history: { index: 2, entries: entries.slice(0, 2) } }, () => true)).status).toBe('unavailable')
    expect((await f.store.recordPage(scope, { ...memory(), favicon: { dataUrl: 'javascript:alert(1)' } }, () => true)).status).toBe('unavailable')
    expect(await f.store.readPage(scope)).toEqual({ status: 'missing' })
  })

  it('reports an unreadable record as unavailable instead of missing', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, hash(scope.profileId!)), { recursive: true })
    await writeFile(f.pagePath, '{"version":1,"memory":{"broken":true}}\n')
    expect((await f.store.readPage(scope)).status).toBe('unavailable')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'
import { BROWSER_PAGE_MEMORY_MAX_ENTRIES, BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH, browserPageMemory, type BrowserPageMemory } from '../src/shared/browser-page-memory.js'
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

describe('bounding one native page observation into a record', () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({ url: `https://page.invalid/${index}`, title: `Page ${index}` }))

  it('keeps the current entry with up to ten forward entries inside the entry budget', () => {
    const late = browserPageMemory(scope, entries[55]!.url, icon, { index: 55, entries })!
    expect(late.history!.entries).toHaveLength(BROWSER_PAGE_MEMORY_MAX_ENTRIES)
    expect(late.history!.entries[late.history!.index]).toEqual(entries[55])
    expect(late.history!.entries.at(-1)).toEqual(entries[59])
    const early = browserPageMemory(scope, entries[5]!.url, icon, { index: 5, entries })!
    expect(early.history).toEqual({ index: 5, entries: entries.slice(0, BROWSER_PAGE_MEMORY_MAX_ENTRIES) })
    const middle = browserPageMemory(scope, entries[45]!.url, undefined, { index: 45, entries })!
    expect(middle.history!.entries[0]).toEqual(entries[6]); expect(middle.history!.entries.at(-1)).toEqual(entries[55])
  })

  it('shortens long titles and omits a favicon or history that does not fit instead of the whole record', () => {
    const long = browserPageMemory(scope, entries[0]!.url, icon, { index: 0, entries: [{ url: entries[0]!.url, title: 'x'.repeat(5000) }] })!
    expect(long.history!.entries[0]!.title).toHaveLength(BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH)
    expect(browserPageMemory(scope, entries[1]!.url, 'javascript:alert(1)', { index: 0, entries: [entries[1]!] }))
      .toEqual({ scope, url: entries[1]!.url, history: { index: 0, entries: [entries[1]!] } })
    expect(browserPageMemory(scope, entries[1]!.url, icon, { index: 0, entries: [{ url: 'x'.repeat(9000), title: '' }] }))
      .toEqual({ scope, url: entries[1]!.url, favicon: { dataUrl: icon } })
    expect(browserPageMemory(scope, 'x'.repeat(9000), icon, undefined)).toBeNull()
  })
})

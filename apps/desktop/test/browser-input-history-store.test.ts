// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fs = vi.hoisted(() => ({ rename: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  fs.rename.mockImplementation(actual.rename)
  return { ...actual, rename: fs.rename }
})
import {
  BrowserInputHistoryStore, MAX_BROWSER_INPUT_HISTORY_ENTRIES,
  MAX_BROWSER_INPUT_HISTORY_TEXT_BYTES, MAX_BROWSER_INPUT_HISTORY_FILE_BYTES
} from '../src/main/browser-input-history.js'
import type { BrowserInputHistoryScope } from '../src/shared/browser-input-history.js'
import { BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH } from '../src/shared/browser-page-memory.js'

const PROFILE_A = '11111111-1111-4111-8111-111111111111'
const PROFILE_B = '22222222-2222-4222-8222-222222222222'
const scope: BrowserInputHistoryScope = { workspaceId: 'history-workspace-A', profileId: PROFILE_A }
const roots: string[] = []
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const pathFor = (directory: string, value = scope) => join(directory,
  `${createHash('sha256').update(JSON.stringify([value.workspaceId, value.profileId])).digest('hex')}.json`)

afterEach(async () => {
  fs.rename.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-input-history-store-'))
  roots.push(directory)
  return { directory, store: new BrowserInputHistoryStore(directory), path: pathFor(directory) }
}

describe('actual bounded Browser input history store', () => {
  it('[existing-appearance] fills one durable batch and keeps newer redirect facts and original input identity', async () => {
    const f = await fixture(), input = 'https://input.invalid/start', document = 'https://page.invalid/document', other = 'https://page.invalid/other'
    const icon = 'data:image/png;base64,AA=='
    await f.store.record(scope, input); await f.store.record(scope, other); await f.store.record(scope, 'human search')
    await f.store.decorate(scope, input, { url: document, title: 'New live title' })
    const before = (await f.store.list(scope)).entries
    fs.rename.mockClear()
    const after = await f.store.fillAppearance(scope, [
      { url: input, title: 'Wrong former input title', faviconDataUrl: 'data:image/png;base64,AQ==' },
      { url: document, title: 'Old stored title', faviconDataUrl: icon },
      { url: other, title: 'Stored other page', faviconDataUrl: icon }, { url: 'https://unsubmitted.invalid/', title: 'Never admit a visit' }
    ])
    expect(after.entries.map(({ appearance: _appearance, ...entry }) => entry)).toEqual(before.map(({ appearance: _appearance, ...entry }) => entry))
    expect(after.entries.find(entry => entry.text === input)!.appearance).toEqual({ url: document, title: 'New live title', faviconDataUrl: icon })
    expect(after.entries.find(entry => entry.text === other)!.appearance).toEqual({ url: other, title: 'Stored other page', faviconDataUrl: icon })
    expect(after.entries.find(entry => entry.text === 'human search')!.appearance).toBeUndefined()
    expect(fs.rename).toHaveBeenCalledOnce()
    expect((await new BrowserInputHistoryStore(f.directory).list(scope)).entries).toEqual(after.entries)
    fs.rename.mockClear(); await f.store.fillAppearance(scope, [{ url: document, title: 'Even older title', faviconDataUrl: 'data:image/png;base64,AQ==' }])
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('[existing-appearance] the batch rereads removals and preserves all input rows before auxiliary byte budgets', async () => {
    const f = await fixture(), urls = ['https://page.invalid/one', 'https://page.invalid/two', 'https://page.invalid/three']
    for (const url of urls) await f.store.record(scope, url)
    const before = (await f.store.list(scope)).entries
    const icon = 'data:image/png;base64,' + 'a'.repeat(BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH - 24)
    await f.store.decorate(scope, urls[0]!, { url: urls[0]!, title: 'Original live title', faviconDataUrl: icon })
    const patches = urls.map(url => ({ url, title: 'Real stored title', faviconDataUrl: icon }))
    const filled = await f.store.fillAppearance(scope, patches)
    expect(filled.entries.map(({ appearance: _appearance, ...entry }) => entry)).toEqual(before)
    expect(filled.entries.filter(entry => entry.appearance?.faviconDataUrl).length).toBeLessThan(3)
    expect(filled.entries.find(entry => entry.text === urls[0])!.appearance).toEqual({ url: urls[0], title: 'Original live title', faviconDataUrl: icon })
    expect((await stat(f.path)).size).toBeLessThanOrEqual(MAX_BROWSER_INPUT_HISTORY_FILE_BYTES)
    await f.store.remove(scope, urls[0]!)
    const after = await f.store.fillAppearance(scope, patches)
    expect(after.entries.some(entry => entry.text === urls[0])).toBe(false)
    await f.store.clear(scope)
    expect((await f.store.fillAppearance(scope, patches)).entries).toEqual([])
  })

  it('[page-appearance] decorates exact original/redirect addresses durably without changing submission identity or search', async () => {
    const f = await fixture(), original = 'https://example.invalid/start?q=%2B#part', final = 'https://other.invalid/final?q=%2B#part'
    await f.store.record(scope, original); await f.store.record(scope, final); await f.store.record(scope, 'human search')
    const before = (await f.store.list(scope)).entries
    const appearance = { url: final, title: 'Real redirected title', faviconDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }
    await f.store.decorate(scope, original, appearance)
    const after = (await new BrowserInputHistoryStore(f.directory).list(scope)).entries
    expect(after.map(({ appearance: _appearance, ...entry }) => entry)).toEqual(before)
    expect(after.filter(entry => entry.text !== 'human search').map(entry => entry.appearance)).toEqual([appearance, appearance])
    expect(after.find(entry => entry.text === 'human search')!.appearance).toBeUndefined()
    const bytes = await readFile(f.path); fs.rename.mockClear()
    await f.store.decorate(scope, original, appearance)
    expect(fs.rename).not.toHaveBeenCalled(); expect(await readFile(f.path)).toEqual(bytes)
    expect((await f.store.record(scope, original)).entries[0]).toMatchObject({ text: original, appearance })
  })

  it('[page-appearance] cannot admit visits, borrow same-origin paths or write a different Workspace/Profile', async () => {
    const f = await fixture(), url = 'https://example.invalid/first?q=one#first'
    const appearance = { url, title: 'First document' }
    await f.store.decorate(scope, url, appearance)
    expect(await readdir(f.directory)).toEqual([])
    for (const text of ['https://example.invalid/second?q=one#first', 'https://example.invalid/first?q=two#first', 'https://example.invalid/first?q=one#second']) await f.store.record(scope, text)
    const before = await readFile(f.path)
    await f.store.decorate(scope, url, appearance)
    expect(await readFile(f.path)).toEqual(before)
    for (const foreign of [{ ...scope, workspaceId: 'other-workspace' }, { ...scope, profileId: PROFILE_B }]) {
      await f.store.decorate(foreign, url, appearance)
      expect(await readFile(f.path)).toEqual(before)
    }
    expect(await readdir(f.directory)).toHaveLength(1)
  })

  it('[page-appearance] serializes remove/clear against both early and late observations without resurrection', async () => {
    const f = await fixture(), url = 'https://example.invalid/page', appearance = { url, title: 'Real title' }
    await f.store.record(scope, url)
    await Promise.all([f.store.decorate(scope, url, appearance), f.store.remove(scope, url), f.store.decorate(scope, url, appearance)])
    expect((await f.store.list(scope)).entries).toEqual([])
    await f.store.record(scope, url); await f.store.record(scope, 'keep other human input')
    await Promise.all([f.store.clear(scope), f.store.decorate(scope, url, appearance)])
    expect((await new BrowserInputHistoryStore(f.directory).list(scope)).entries).toEqual([])
  })

  it('[page-appearance] spends the existing byte budget on inputs before optional artwork, including later submissions', async () => {
    const f = await fixture(), icon = 'data:image/png;base64,' + 'a'.repeat(BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH - 24)
    for (let index = 0; index < 50; index++) await f.store.record(scope, `https://example.invalid/${index}?q=${'x'.repeat(3500)}`)
    const before = (await f.store.list(scope)).entries
    for (const entry of before.slice(0, 4)) await f.store.decorate(scope, entry.text, { url: entry.text, title: 'Real page', faviconDataUrl: icon })
    const decorated = (await f.store.list(scope)).entries
    expect(decorated.map(({ appearance: _appearance, ...entry }) => entry)).toEqual(before)
    expect(decorated.filter(entry => entry.appearance?.faviconDataUrl).length).toBeLessThan(4)
    expect((await stat(f.path)).size).toBeLessThanOrEqual(MAX_BROWSER_INPUT_HISTORY_FILE_BYTES)
    const latest = 'https://example.invalid/new?q=' + 'y'.repeat(3500)
    expect((await f.store.record(scope, latest)).entries.map(entry => entry.text)).toEqual([latest, ...before.slice(0, 49).map(entry => entry.text)])
    await f.store.decorate(scope, latest, { url: latest, title: 'Kept title', faviconDataUrl: 'x'.repeat(BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH + 1) })
    expect((await f.store.list(scope)).entries[0]!.appearance).toEqual({ url: latest, title: 'Kept title' })
  }, 20_000)

  it('[page-appearance] keeps committed text on decoration IO failure and allows later owner work', async () => {
    const f = await fixture(), url = 'https://example.invalid/retained'
    await f.store.record(scope, url); const before = await readFile(f.path)
    fs.rename.mockRejectedValueOnce(new Error('Appearance rename failure'))
    await expect(f.store.decorate(scope, url, { url, title: 'Not yet saved' })).rejects.toThrow('Appearance rename failure')
    expect(await readFile(f.path)).toEqual(before)
    await f.store.record(scope, 'later search')
    await f.store.decorate(scope, url, { url, title: 'Saved on retry' })
    expect((await f.store.list(scope)).entries.find(entry => entry.text === url)!.appearance?.title).toBe('Saved on retry')
  })

  it('stores a new short Profile scope beside the original UUID scope without merging or rewriting either', async () => {
    const f = await fixture(), short = { ...scope, profileId: 'AbCdEfGh1234' }
    await f.store.record(scope, 'original UUID profile')
    await f.store.record(short, 'new short profile')
    const restarted = new BrowserInputHistoryStore(f.directory)
    expect((await restarted.list(scope)).entries.map(entry => entry.text)).toEqual(['original UUID profile'])
    expect((await restarted.list(short)).entries.map(entry => entry.text)).toEqual(['new short profile'])
    expect((await readdir(f.directory)).sort()).toEqual([pathFor(f.directory).split('/').at(-1), pathFor(f.directory, short).split('/').at(-1)].sort())
    await expect(restarted.list({ ...scope, profileId: '../../escape' })).rejects.toThrow()
  })

  it('treats only absence as empty and keeps whitespace submissions off disk', async () => {
    const f = await fixture()
    expect(await f.store.list(scope)).toEqual({ scope, entries: [] })
    expect(await f.store.record(scope, ' \t ')).toEqual({ scope, entries: [], outcome: 'empty' })
    expect(await readdir(f.directory)).toEqual([])
  })

  it('keeps exact trimmed query, fragment and search intent, deduplicating by most recent submission', async () => {
    const f = await fixture()
    const address = 'HTTPS://Example.invalid/p?q=%2b&word=a+b#literal%20fragment'
    await f.store.record(scope, `  ${address}  `)
    await f.store.record(scope, 'a human search with password as a word')
    const repeated = f.store.record(scope, address)
    await expect(repeated).resolves.toMatchObject({ outcome: 'recorded' })
    const actual = await repeated
    expect(actual.outcome).toBe('recorded')
    expect(actual.entries.map(entry => entry.text)).toEqual([address, 'a human search with password as a word'])
    expect(actual.entries[0]!.submittedAt).toBeGreaterThan(0)
    expect((await new BrowserInputHistoryStore(f.directory).list(scope)).entries).toEqual(actual.entries)
    if (process.platform !== 'win32') expect((await stat(f.path)).mode & 0o777).toBe(0o600)
  })

  it('isolates real Workspace and Profile scopes, preserving other files across remove and clear', async () => {
    const f = await fixture()
    const otherWorkspace = { ...scope, workspaceId: 'history-workspace-B' }
    const otherProfile = { ...scope, profileId: PROFILE_B }
    await expect(Promise.all([f.store.record(scope, 'A first'), f.store.record(scope, 'A second'),
      f.store.record(otherWorkspace, 'workspace B'), f.store.record(otherProfile, 'profile B')])).resolves.toHaveLength(4)
    const otherBytes = await Promise.all([readFile(pathFor(f.directory, otherWorkspace)), readFile(pathFor(f.directory, otherProfile))])
    expect((await f.store.remove(scope, 'A first')).entries.map(entry => entry.text)).toEqual(['A second'])
    expect((await f.store.clear(scope)).entries).toEqual([])
    expect((await new BrowserInputHistoryStore(f.directory).list(otherWorkspace)).entries.map(entry => entry.text)).toEqual(['workspace B'])
    expect((await f.store.list(otherProfile)).entries.map(entry => entry.text)).toEqual(['profile B'])
    expect(await Promise.all([readFile(pathFor(f.directory, otherWorkspace)), readFile(pathFor(f.directory, otherProfile))])).toEqual(otherBytes)
    expect(await readdir(f.directory)).toHaveLength(3)
  })

  it('bounds actual count, UTF-8 text bytes and serialized escaped bytes without vacuous lists', async () => {
    const f = await fixture()
    for (let i = 0; i < 51; i++) await expect(f.store.record(scope, `human search ${i}`)).resolves.toMatchObject({ outcome: 'recorded' })
    expect((await f.store.list(scope)).entries.map(entry => entry.text)).toEqual(
      Array.from({ length: MAX_BROWSER_INPUT_HISTORY_ENTRIES }, (_, i) => `human search ${50 - i}`))
    await expect(f.store.record(scope, '汉'.repeat(Math.ceil(MAX_BROWSER_INPUT_HISTORY_TEXT_BYTES / 3)))).rejects.toThrow()
    // Internal JSON controls remain legitimate search characters; escaping must not defeat the disk bound.
    for (let i = 0; i < 12; i++) await expect(f.store.record(scope, `escaped ${i}:` + '\u0001'.repeat(4000))).resolves.toMatchObject({ outcome: 'recorded' })
    const entries = (await f.store.list(scope)).entries
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(MAX_BROWSER_INPUT_HISTORY_ENTRIES)
    expect(entries[0]!.text).toBe('escaped 11:' + '\u0001'.repeat(4000))
    expect((await stat(f.path)).size).toBeLessThanOrEqual(MAX_BROWSER_INPUT_HISTORY_FILE_BYTES)
  }, 15_000)

  it('excludes entire URL userinfo inputs without rewriting or treating arbitrary searches as secrets', async () => {
    const f = await fixture()
    await f.store.record(scope, 'ordinary search query')
    const before = await readFile(f.path)
    for (const text of ['https://user:secret@example.invalid/p?query=keep#hash', 'user@example.invalid/path',
      'https://user:secret@example.invalid/path with space', 'https:\\user:secret@example.invalid/path']) {
      const actual = await f.store.record(scope, text)
      expect(actual.outcome).toBe('url-userinfo')
      expect(actual.entries.map(entry => entry.text)).toEqual(['ordinary search query'])
      expect(await readFile(f.path)).toEqual(before)
    }
    const literal = 'find user:secret@example.invalid in a paragraph'
    expect((await f.store.record(scope, literal)).entries.map(entry => entry.text)).toEqual([literal, 'ordinary search query'])
  })

  it('rejects corrupt, invalid UTF-8, oversized and mismatched-scope files without empty success or overwriting', async () => {
    const f = await fixture()
    await f.store.record(scope, 'keep original')
    const original = JSON.parse(await readFile(f.path, 'utf8'))
    const corruptions = [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(MAX_BROWSER_INPUT_HISTORY_FILE_BYTES + 1, 32),
      Buffer.from(JSON.stringify({ ...original, scope: { ...scope, profileId: PROFILE_B } })),
      Buffer.from(JSON.stringify({ ...original, entries: [...original.entries, ...original.entries] }))]
    expect(corruptions.length).toBeGreaterThan(0)
    for (const bytes of corruptions) {
      await writeFile(f.path, bytes)
      await expect(f.store.list(scope)).rejects.toThrow()
      await expect(f.store.record(scope, 'new input')).rejects.toThrow()
      await expect(f.store.clear(scope)).rejects.toThrow()
      expect(await readFile(f.path)).toEqual(bytes)
    }
  })

  it('surfaces an actual durable rename failure, retains the old bytes and admits later history work', async () => {
    const f = await fixture()
    await f.store.record(scope, 'retained input')
    const bytes = await readFile(f.path)
    fs.rename.mockRejectedValueOnce(new Error('Owned durable rename failure'))
    await expect(f.store.record(scope, 'uncommitted input')).rejects.toThrow('Owned durable rename failure')
    expect(await readFile(f.path)).toEqual(bytes)
    expect((await f.store.list(scope)).entries.map(entry => entry.text)).toEqual(['retained input'])
    expect((await f.store.record(scope, 'later input')).entries.map(entry => entry.text)).toEqual(['later input', 'retained input'])
    expect(await readdir(f.directory)).toEqual([pathFor(f.directory).split('/').at(-1)])
  })

  it('restores saved inputs and deletions through two real private Node processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amx-input-history-process-'))
    roots.push(directory)
    const runs: Array<{ mode: string; exit: number | null; signal: NodeJS.Signals | null; output: string }> = []
    for (const mode of ['save', 'recover-delete']) {
      const result = await new Promise<{ exit: number | null; signal: NodeJS.Signals | null; output: string }>((yes, no) => {
        const child = spawn(process.execPath, [resolve(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
          'apps/desktop/scripts/fixtures/browser-input-history/vitest.process.config.mts', '--maxWorkers=1'], {
          cwd: repository, env: { ...process.env, AGENTMUX_HISTORY_PRIVATE_DIRECTORY: directory, AGENTMUX_HISTORY_PROCESS_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
        child.on('error', no); child.on('close', (exit, signal) => yes({ exit, signal, output }))
      })
      runs.push({ mode, ...result })
      expect(result.exit, result.output).toBe(0)
      expect(result.signal).toBeNull()
      expect(result.output).toMatch(/Tests\s+1 passed \(1\)/)
    }
    const first = JSON.parse(await readFile(join(directory, 'save.json'), 'utf8'))
    const second = JSON.parse(await readFile(join(directory, 'recover-delete.json'), 'utf8'))
    expect(first.pid).toBeGreaterThan(0)
    expect(second.pid).toBeGreaterThan(0)
    expect(second.pid).not.toBe(first.pid)
    expect(second.before).toEqual(first.after)
    expect(second.before.entries.map((entry: { text: string }) => entry.text)).toEqual(['https://example.invalid/path?q=keep%2Bcase#part', 'first process search'])
    expect(second.after).toEqual({ scope: first.scope, entries: [] })
    expect(await new BrowserInputHistoryStore(join(directory, 'history')).list(first.scope)).toEqual(second.after)
    const receipt = { scope: 'T026-private-Node-durable-only', passed: true, first, second, runs,
      desktopRestart: false, nativeBrowser: false, userRuntimeControl: [], systemClipboard: [] }
    const evidence = process.env.AGENTMUX_HISTORY_PROCESS_EVIDENCE
    if (evidence) await writeFile(evidence, `${JSON.stringify(receipt, null, 2)}\n`)
  }, 30_000)
})

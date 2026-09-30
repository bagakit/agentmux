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

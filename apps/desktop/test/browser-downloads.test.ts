import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import type { WebContents } from 'electron'
import { BrowserDownloads, readBrowserDownload, waitForBrowserDownload, type BrowserDownloadContext } from '../src/main/browser-downloads.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { BrowserDownloadReceipt } from '../src/shared/browser-download.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

class Download extends EventEmitter {
  path: string | null = null
  bytes = 0
  cancelled = false
  constructor(readonly total: number) { super() }
  setSavePath(path: string) { this.path = path }
  getFilename() { return 'report.bin' }
  getMimeType() { return 'application/octet-stream' }
  getReceivedBytes() { return this.bytes }
  getTotalBytes() { return this.total }
  cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') }
}
const roots: string[] = []
const payload = Buffer.from([0, 255, 128, 13, 10, 1])
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-download-'))
  roots.push(root)
  const workspace: WorkspaceRecord = { id: 'workspace-a', name: 'Workspace', hostId: 'local', path: join(root, 'workspace'), kind: 'folder' }
  await mkdir(workspace.path)
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const directory = join(root, 'downloads')
  const resolveWorkspace = (id: string) => { if (id !== workspace.id) throw new Error('Unknown Workspace'); return workspace }
  const downloads = new BrowserDownloads(directory, files, resolveWorkspace)
  const session = new EventEmitter()
  const contents = Object.assign(new EventEmitter(), { id: 41, session, isDestroyed: () => false })
  const context: BrowserDownloadContext = { workspaceId: workspace.id, browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a', url: 'https://example.test/document', contents: contents as unknown as WebContents }
  return { root, directory, workspace, files, downloads, session, contents, context, resolveWorkspace }
}
async function complete(f: Awaited<ReturnType<typeof fixture>>, options: { path?: string; onUpdate?: (receipt: BrowserDownloadReceipt) => void } = {}) {
  const item = new Download(payload.length)
  const receipt = await waitForBrowserDownload(f.downloads, f.context, async () => {
    expect(f.session.listenerCount('will-download')).toBe(1)
    f.session.emit('will-download', {}, item, f.contents)
    expect(item.path).toBeTruthy()
    await writeFile(item.path!, payload)
    item.bytes = payload.length
    item.emit('updated', {}, 'progressing')
    item.emit('done', {}, 'completed')
  }, { path: options.path ?? 'report.bin', timeoutMs: 2000, ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}) })
  return { receipt, item }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Browser event-first download owner', () => {
  it('registers before a synchronous trigger and publishes exact binary bytes only after Chromium completion', async () => {
    const f = await fixture(), updates: BrowserDownloadReceipt[] = []
    const { receipt } = await complete(f, { onUpdate: receipt => updates.push(receipt) })
    expect(updates.map(update => update.status)).toEqual(['received', 'in-progress', 'completed'])
    expect(updates[0]!.reference).toBeUndefined()
    expect(updates[1]!.reference).toBeUndefined()
    expect(receipt.status).toBe('completed')
    expect(receipt.reference).toMatchObject({ kind: 'browser-download-file', workspaceId: f.workspace.id, browserId: f.context.browserId, operationId: f.context.operationId, navigationId: f.context.navigationId, path: 'report.bin', byteLength: payload.length })
    expect(await readFile(join(f.workspace.path, 'report.bin'))).toEqual(payload)
    const chunk = await readBrowserDownload(f.downloads, receipt.reference!, f.context, { offset: 1, maxBytes: 3 })
    expect(Buffer.from(chunk.data, 'base64')).toEqual(payload.subarray(1, 4))
    expect(chunk).toMatchObject({ encoding: 'base64', offset: 1, returnedBytes: 3, totalBytes: payload.length, nextOffset: 4, revision: receipt.reference!.revision, readCost: { payloadBytes: payload.length } })
    expect(f.session.listenerCount('will-download')).toBe(0)
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    expect(await readdir(f.directory)).toEqual([`${receipt.id}.json`])
  })

  it('does not claim or cancel another Browser download in a shared Chromium Session', async () => {
    const f = await fixture(), foreign = new Download(1), own = new Download(payload.length)
    const event = { preventDefault: vi.fn() }
    const receipt = await waitForBrowserDownload(f.downloads, f.context, async () => {
      f.session.emit('will-download', event, foreign, { id: 99 })
      expect(foreign.path).toBeNull()
      f.session.emit('will-download', event, own, f.contents)
      await writeFile(own.path!, payload)
      own.bytes = payload.length
      own.emit('done', {}, 'completed')
    }, { path: 'ours.bin', timeoutMs: 2000 })
    expect(receipt.status).toBe('completed')
    expect(foreign.cancelled).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(await readFile(join(f.workspace.path, 'ours.bin'))).toEqual(payload)
  })

  it('distinguishes cancellation and terminal interruption without a readable file', async () => {
    const f = await fixture()
    for (const state of ['cancelled', 'interrupted']) {
      const item = new Download(0)
      const receipt = await waitForBrowserDownload(f.downloads, f.context, () => {
        f.session.emit('will-download', {}, item, f.contents)
        item.emit('done', {}, state)
      }, { path: `${state}.bin`, timeoutMs: 2000 })
      expect(receipt.status).toBe(state === 'cancelled' ? 'cancelled' : 'failed')
      expect(receipt.warning).toBe(state === 'cancelled' ? 'Chromium cancelled the download.' : 'Chromium did not complete the download.')
      expect(receipt.reference).toBeUndefined()
      expect(receipt.totalBytes).toBeNull()
      expect(f.session.listenerCount('will-download')).toBe(0)
      await expect(readFile(join(f.workspace.path, `${state}.bin`))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('cancels only its operation on abort and releases listeners without closing the Browser', async () => {
    const f = await fixture(), abort = new AbortController(), item = new Download(0)
    const receipt = await waitForBrowserDownload(f.downloads, f.context, () => {
      f.session.emit('will-download', {}, item, f.contents)
      abort.abort()
    }, { path: 'cancelled.bin', timeoutMs: 2000, signal: abort.signal })
    expect(receipt).toMatchObject({ status: 'cancelled', warning: 'Download was cancelled by its operation.' })
    expect(receipt.reference).toBeUndefined()
    expect(item.cancelled).toBe(true)
    expect(f.contents.isDestroyed()).toBe(false)
    expect(f.session.listenerCount('will-download')).toBe(0)
  })

  it('preserves an existing destination and rejects a path outside the Workspace', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace.path, 'keep.bin'), Buffer.from([4, 0, 9]))
    expect((await complete(f, { path: 'keep.bin' })).receipt).toMatchObject({ status: 'failed', warning: 'Download destination already exists; it was preserved.' })
    expect(await readFile(join(f.workspace.path, 'keep.bin'))).toEqual(Buffer.from([4, 0, 9]))
    const escape = (await complete(f, { path: '../outside.bin' })).receipt
    expect(escape.status).toBe('failed')
    expect(escape.reference).toBeUndefined()
    await expect(readFile(join(f.root, 'outside.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks the original Workspace, Browser, operation, navigation, path and file revision when reading', async () => {
    const f = await fixture(), { receipt } = await complete(f)
    const reference = receipt.reference!
    await expect(readBrowserDownload(f.downloads, reference, { ...f.context, workspaceId: 'other-workspace' })).rejects.toThrow('does not belong')
    await expect(readBrowserDownload(f.downloads, reference, { ...f.context, browserId: 'other-browser' })).rejects.toThrow('does not belong')
    for (const key of ['operationId', 'navigationId', 'path'] as const) {
      await expect(readBrowserDownload(f.downloads, { ...reference, [key]: 'foreign' }, f.context)).rejects.toThrow('does not match')
    }
    await writeFile(join(f.workspace.path, 'report.bin'), Buffer.from([0, 255, 128, 13, 10, 2]))
    await expect(readBrowserDownload(f.downloads, reference, f.context)).rejects.toMatchObject({ code: 'WORKSPACE_FILE_REVISION_MISMATCH' })
  })

  it('recovers a completed file for a new owner and marks unfinished persisted transfers unconfirmed', async () => {
    const f = await fixture(), { receipt } = await complete(f)
    const restarted = new BrowserDownloads(f.directory, f.files, f.resolveWorkspace)
    const recovered = await readBrowserDownload(restarted, receipt.reference!, f.context)
    expect(Buffer.from(recovered.data, 'base64')).toEqual(payload)
    const { reference: _reference, ...unfinished } = receipt
    const incomplete: BrowserDownloadReceipt = { ...unfinished, id: '11111111-1111-1111-1111-111111111111', status: 'in-progress', path: 'unfinished.bin', createdAt: receipt.createdAt + 1 }
    await writeFile(join(f.directory, `${incomplete.id}.json`), JSON.stringify({ schema: 'agentmux.browser-download.v1', receipt: incomplete }))
    await writeFile(join(f.directory, `${incomplete.id}.part`), Buffer.from([0, 1]))
    const next = new BrowserDownloads(f.directory, f.files, f.resolveWorkspace)
    const records = await next.list(f.context)
    expect(records.map(record => record.status)).toEqual(['completed', 'failed'])
    const failed = records.find(record => record.id === incomplete.id)!
    expect(failed.warning).toContain('unconfirmed')
    expect(failed.reference).toBeUndefined()
    expect((await readdir(f.directory)).sort()).toEqual([`${incomplete.id}.json`, `${receipt.id}.json`].sort())
    await expect(readBrowserDownload(next, { ...receipt.reference!, id: incomplete.id }, f.context)).rejects.toThrow('does not match')
  })

  it('fails bounded waiting and trigger errors without manufacturing a completed artifact', async () => {
    const f = await fixture()
    const timeout = await waitForBrowserDownload(f.downloads, f.context, () => {}, { path: 'timeout.bin', timeoutMs: 10 })
    expect(timeout).toMatchObject({ status: 'failed', warning: 'Download did not complete within its waiting budget.' })
    expect(timeout.reference).toBeUndefined()
    const failed = await waitForBrowserDownload(f.downloads, f.context, () => { throw new Error('click failed') }, { path: 'failed.bin', timeoutMs: 2000 })
    expect(failed).toMatchObject({ status: 'failed', warning: 'Download trigger failed: click failed' })
    expect(failed.reference).toBeUndefined()
    expect(f.session.listenerCount('will-download')).toBe(0)
  })

  it('bounds receipt retention during concurrent Browser transfers and refuses expired references while preserving files', async () => {
    const f = await fixture(), { receipt } = await complete(f)
    // Populate durable metadata at its retention boundary; only the initial file was transferred.
    await Promise.all(Array.from({ length: 127 }, async (_, index) => {
      const id = randomUUID()
      const retained = { ...receipt, id, createdAt: receipt.createdAt + index + 1, reference: { ...receipt.reference!, id } }
      await writeFile(join(f.directory, `${id}.json`), JSON.stringify({ schema: 'agentmux.browser-download.v1', receipt: retained }))
    }))
    const secondContents = Object.assign(new EventEmitter(), { id: 42, session: f.session, isDestroyed: () => false })
    const secondContext = { ...f.context, browserId: 'browser-b', operationId: 'operation-b', contents: secondContents as unknown as WebContents }
    const transfer = (context: BrowserDownloadContext, path: string) => waitForBrowserDownload(f.downloads, context, async () => {
      const item = new Download(payload.length)
      f.session.emit('will-download', {}, item, context.contents)
      await writeFile(item.path!, payload)
      item.bytes = payload.length
      item.emit('done', {}, 'completed')
    }, { path, timeoutMs: 2000 })
    const results = await Promise.all([transfer(f.context, 'first.bin'), transfer(secondContext, 'second.bin')])
    expect(results.map(result => result.status)).toEqual(['completed', 'completed'])
    expect((await readdir(f.directory)).filter(name => name.endsWith('.json'))).toHaveLength(128)
    await expect(readBrowserDownload(f.downloads, receipt.reference!, f.context)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.workspace.path, 'report.bin'))).toEqual(payload)
    expect(f.session.listenerCount('will-download')).toBe(0)
  })

  it('rejects over-budget bytes and missing Workspace ownership without triggering a transfer', async () => {
    const f = await fixture(), item = new Download(payload.length)
    const receipt = await waitForBrowserDownload(f.downloads, f.context, () => { f.session.emit('will-download', {}, item, f.contents) }, { path: 'large.bin', maxBytes: 1, timeoutMs: 2000 })
    expect(receipt).toMatchObject({ status: 'failed', warning: 'Download exceeded its byte budget.' })
    expect(receipt.reference).toBeUndefined()
    expect(item.cancelled).toBe(true)
    const trigger = vi.fn()
    await expect(waitForBrowserDownload(f.downloads, { ...f.context, workspaceId: null }, trigger, { path: 'unknown.bin' })).rejects.toThrow('no verified Workspace')
    expect(trigger).not.toHaveBeenCalled()
    expect(f.session.listenerCount('will-download')).toBe(0)
  })

  it('keeps the healthy download readable while making a projection callback failure explicit', async () => {
    const f = await fixture()
    const { receipt } = await complete(f, { onUpdate: () => { throw new Error('projection unavailable') } })
    expect(receipt).toMatchObject({ status: 'completed', warning: 'Download status projection failed: projection unavailable' })
    expect(Buffer.from((await readBrowserDownload(f.downloads, receipt.reference!, f.context)).data, 'base64')).toEqual(payload)
    expect(f.contents.isDestroyed()).toBe(false)
  })

  it('reports a native observation failure without throwing out of the Session event or closing the Browser', async () => {
    const f = await fixture(), item = new Download(1)
    item.setSavePath = () => { throw new Error('native download unavailable') }
    const receipt = await waitForBrowserDownload(f.downloads, f.context, () => {
      expect(() => f.session.emit('will-download', {}, item, f.contents)).not.toThrow()
    }, { path: 'native-failed.bin', timeoutMs: 2000 })
    expect(receipt).toMatchObject({ status: 'failed', warning: 'Download observation failed: native download unavailable' })
    expect(receipt.reference).toBeUndefined()
    expect(f.contents.isDestroyed()).toBe(false)
    expect(f.session.listenerCount('will-download')).toBe(0)
  })

  it('refuses a damaged completed receipt without removing the actual Workspace file', async () => {
    const f = await fixture(), { receipt } = await complete(f)
    await writeFile(join(f.directory, `${receipt.id}.json`), JSON.stringify({ schema: 'agentmux.browser-download.v1', receipt: { ...receipt, operationId: 'another-operation' } }))
    await expect(readBrowserDownload(f.downloads, receipt.reference!, f.context)).rejects.toThrow('does not match its recorded source')
    expect(await readFile(join(f.workspace.path, 'report.bin'))).toEqual(payload)
    expect(f.contents.isDestroyed()).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import type { WebContents } from 'electron'
import { BrowserDownloads, readBrowserDownload, waitForBrowserDownload, type BrowserDownloadContext } from '../src/main/browser-downloads.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal.js'
import { evaluateBrowserOutcomeCriteria, type BrowserOutcomeHost } from '../src/main/browser-outcome-criteria.js'
import type { BrowserOutcomeRegistration } from '../src/shared/browser-outcome-criteria.js'
import type { BrowserDownloadReceipt } from '../src/shared/browser-download.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

class Download extends EventEmitter {
  path: string | null = null
  bytes = 0
  constructor(readonly total: number) { super() }
  setSavePath(path: string) { this.path = path }
  getFilename() { return 'artifact.bin' }
  getMimeType() { return 'application/octet-stream' }
  getReceivedBytes() { return this.bytes }
  getTotalBytes() { return this.total }
  cancel() { this.emit('done', {}, 'cancelled') }
}
const payload = Buffer.from([0, 255, 128, 1, 10, 13])
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-outcome-download-owner-')); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'workspace-a', name: 'Workspace', hostId: 'local', path: join(root, 'workspace'), kind: 'folder' }
  await mkdir(workspace.path)
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const directory = join(root, 'downloads')
  const resolveWorkspace = (id: string) => { if (id !== workspace.id) throw new Error('Unknown Workspace'); return workspace }
  const downloads = new BrowserDownloads(directory, files, resolveWorkspace)
  const session = new EventEmitter()
  const contents = Object.assign(new EventEmitter(), { id: 41, session, isDestroyed: () => false })
  const context: BrowserDownloadContext = { workspaceId: workspace.id, browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a',
    url: 'https://generic.invalid/document', contents: contents as unknown as WebContents }
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json')))
  await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' }, summary: 'Declared file check', url: context.url })
  const registration: BrowserOutcomeRegistration = { context: { workspaceId: workspace.id, browserId: context.browserId,
    operationId: context.operationId, navigationId: context.navigationId }, criteria: [{ kind: 'download-readable', path: 'artifact.bin',
    producer: { operationId: context.operationId, navigationId: context.navigationId } }] }
  const saved = await journal.registerOutcome(context.operationId, registration)
  expect(saved?.saved).toBe(true)
  let triggers = 0
  const transfer = async (options: { signal?: AbortSignal; unfinished?: (metadata: Buffer, id: string) => void | Promise<void> } = {}) => {
    const item = new Download(payload.length)
    const receipt = await waitForBrowserDownload(downloads, context, async () => {
      triggers += 1
      expect(session.listenerCount('will-download')).toBe(1)
      expect((await journal.get(context.operationId))?.outcome?.registration).toEqual(registration)
      const ids = (await readdir(directory)).filter(name => name.endsWith('.json'))
      expect(ids).toHaveLength(1)
      const metadata = await readFile(join(directory, ids[0]!))
      session.emit('will-download', {}, item, contents)
      expect(item.path).toBeTruthy()
      await writeFile(item.path!, payload)
      if (options.unfinished) { await options.unfinished(metadata, ids[0]!.slice(0, -5)); return }
      item.bytes = payload.length; item.emit('done', {}, 'completed')
    }, { path: 'artifact.bin', timeoutMs: 2000, ...(options.signal ? { signal: options.signal } : {}) })
    return receipt
  }
  const host = (owner: BrowserDownloads, receipts?: BrowserDownloadReceipt[]): BrowserOutcomeHost => ({
    current: () => ({ workspaceId: workspace.id, browserId: context.browserId, navigationId: context.navigationId, assetRun: null }),
    getOperation: id => journal.get(id),
    getStepEvidence: async () => { throw new Error('File checks do not collect page evidence') },
    readStepResult: async () => { throw new Error('File checks do not collect structured values') },
    isStructuredSourceCurrent: async () => false,
    // Returned terminal receipts are actual owner output, including a failed metadata ACK.
    getDownloads: () => receipts ? Promise.resolve(receipts) : owner.list(context),
    readDownload: (reference, options) => readBrowserDownload(owner, reference, context, options)
  })
  return { root, directory, files, workspace, resolveWorkspace, downloads, session, contents, context, registration, transfer, host, triggers: () => triggers }
}

describe('download outcome consumes the actual download and Workspace owners', () => {
  it('requires real published binary and revision; a replaced file is unavailable without another trigger', async () => {
    const f = await fixture(), receipt = await f.transfer()
    expect(receipt.status).toBe('completed')
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
    const readable = await evaluateBrowserOutcomeCriteria(f.registration, f.host(f.downloads))
    expect(readable.conditions.map(item => item.status)).toEqual(['passed'])
    expect(readable.status).toBe('passed')
    await writeFile(join(f.workspace.path, 'artifact.bin'), Buffer.from([0, 255, 128, 1, 10, 14]))
    const replaced = await evaluateBrowserOutcomeCriteria(f.registration, f.host(f.downloads))
    expect(replaced.conditions.map(item => item.status)).toEqual(['unavailable'])
    expect(replaced.status).toBe('unavailable')
    expect(f.triggers()).toBe(1)
    expect(f.contents.isDestroyed()).toBe(false)
  })

  it('keeps an actual cancelled transfer not-met without claiming a file or an unknown success', async () => {
    const f = await fixture(), abort = new AbortController()
    const receipt = await f.transfer({ signal: abort.signal, unfinished: () => abort.abort() })
    expect(receipt.status).toBe('cancelled')
    expect(receipt.reference).toBeUndefined()
    const result = await evaluateBrowserOutcomeCriteria(f.registration, f.host(f.downloads))
    expect(result.conditions.map(item => item.status)).toEqual(['not-met'])
    expect(result.status).toBe('not-met')
    expect(f.triggers()).toBe(1)
    expect(f.contents.isDestroyed()).toBe(false)
  })

  it('ordinary owner restart retains an unfinished actual receipt as unavailable, rather than not-met', async () => {
    const f = await fixture(), abort = new AbortController()
    let beforeCrash!: { metadata: Buffer; id: string }
    await f.transfer({ signal: abort.signal, unfinished: (metadata, id) => { beforeCrash = { metadata, id }; abort.abort() } })
    // The bytes were written by the real owner before its terminal callback. Restore that
    // exact crash boundary after settling the old owner, so no old timer survives cleanup.
    await writeFile(join(f.directory, `${beforeCrash.id}.json`), beforeCrash.metadata)
    await writeFile(join(f.directory, `${beforeCrash.id}.part`), payload.subarray(0, 2))
    const restarted = new BrowserDownloads(f.directory, f.files, f.resolveWorkspace)
    const records = await restarted.list(f.context)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: beforeCrash.id, status: 'failed' })
    expect(records[0]!.warning).toContain('unconfirmed')
    expect(records[0]!.reference).toBeUndefined()
    const result = await evaluateBrowserOutcomeCriteria(f.registration, f.host(restarted))
    expect(result.conditions.map(item => item.status)).toEqual(['unavailable'])
    expect(result.status).toBe('unavailable')
    expect(await readdir(f.directory)).toEqual([`${beforeCrash.id}.json`])
    expect(f.triggers()).toBe(1)
    expect(f.session.listenerCount('will-download')).toBe(0)
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    expect(f.contents.isDestroyed()).toBe(false)
  })

  it('a real metadata save failure after binary publication is unavailable and preserves a healthy Browser', async () => {
    const f = await fixture()
    const publish = f.files.writeBytes.bind(f.files)
    vi.spyOn(f.files, 'writeBytes').mockImplementationOnce(async (...args) => {
      const result = await publish(...args)
      expect(result.status).toBe('written')
      const records = (await readdir(f.directory)).filter(name => name.endsWith('.json'))
      expect(records).toHaveLength(1)
      // A directory at the private receipt destination makes the real durable rename fail.
      const destination = join(f.directory, records[0]!)
      await rm(destination); await mkdir(destination)
      return result
    })
    const receipt = await f.transfer()
    expect(receipt.status).toBe('failed')
    expect(receipt.warning).toContain('File availability is unconfirmed')
    expect(receipt.reference).toBeUndefined()
    expect(await readFile(join(f.workspace.path, 'artifact.bin'))).toEqual(payload)
    const result = await evaluateBrowserOutcomeCriteria(f.registration, f.host(f.downloads, [receipt]))
    expect(result.conditions.map(item => item.status)).toEqual(['unavailable'])
    expect(result.status).toBe('unavailable')
    expect(f.triggers()).toBe(1)
    expect(f.session.listenerCount('will-download')).toBe(0)
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    expect(f.contents.isDestroyed()).toBe(false)
    const healthyContents = Object.assign(new EventEmitter(), { id: 42, session: f.session, isDestroyed: () => false })
    const healthyContext = { ...f.context, browserId: 'browser-b', operationId: 'operation-b', contents: healthyContents as unknown as WebContents }
    let healthyTriggers = 0
    const healthy = await waitForBrowserDownload(f.downloads, healthyContext, async () => {
      healthyTriggers += 1
      const item = new Download(payload.length)
      f.session.emit('will-download', {}, item, healthyContents)
      await writeFile(item.path!, payload); item.bytes = payload.length; item.emit('done', {}, 'completed')
    }, { path: 'healthy.bin', timeoutMs: 2000 })
    expect(healthy.status).toBe('completed')
    expect(Buffer.from((await readBrowserDownload(f.downloads, healthy.reference!, healthyContext)).data, 'base64')).toEqual(payload)
    expect(healthyTriggers).toBe(1)
    expect(healthyContents.isDestroyed()).toBe(false)
  })
})

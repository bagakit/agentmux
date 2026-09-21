import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadItem, WebContents } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type {
  BrowserDownloadSource, BrowserDownloadReceipt, BrowserDownloadReference,
  BrowserDownloadCurrentOwner, BrowserDownloadReadOptions, BrowserDownloadChunk
} from '../shared/browser-download.js'
import type { WorkspaceFiles } from './workspace-files.js'

const SCHEMA = 'agentmux.browser-download.v1'
const MAX_RECEIPTS = 128
const MAX_METADATA_BYTES = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const terminal = new Set(['completed', 'cancelled', 'failed'])
const states = new Set(['waiting', 'received', 'in-progress', ...terminal])
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export type BrowserDownloadContext = BrowserDownloadSource & { contents: WebContents }
export type BrowserDownloadOptions = {
  path: string
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  onUpdate?: (receipt: BrowserDownloadReceipt) => void
}

async function readOwnedBytes(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Download file exceeds its byte budget or is not a regular file.')
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length !== info.size || length > limit) throw new Error('Download file changed while being read.')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

/** Chromium owns transfer facts. WorkspaceFiles alone publishes and reads the real file. */
export class BrowserDownloads {
  private readyPromise: Promise<void> | null = null
  private receiptTail: Promise<void> = Promise.resolve()
  private readonly active = new Set<number>()

  constructor(
    private readonly directory: string,
    private readonly files: WorkspaceFiles,
    private readonly resolveWorkspace: (id: string) => WorkspaceRecord
  ) {}

  async wait(context: BrowserDownloadContext, trigger: () => void | Promise<unknown>, options: BrowserDownloadOptions): Promise<BrowserDownloadReceipt> {
    const timeoutMs = options.timeoutMs ?? 30_000, maxBytes = options.maxBytes ?? WORKSPACE_FILE_MAX_BYTES
    if (!context.workspaceId) throw new Error('This Browser has no verified Workspace binding; downloads are unavailable.')
    if (!context.browserId || !context.operationId || !context.navigationId || context.contents.isDestroyed()) throw new Error('Download source identity is unavailable.')
    if (!options.path || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WORKSPACE_FILE_MAX_BYTES) throw new Error('Download requires a destination and bounded timeout/byte budgets.')
    const workspace = this.resolveWorkspace(context.workspaceId)
    if (workspace.id !== context.workspaceId) throw new Error('Download Workspace does not match its verified owner.')
    const contents = context.contents, session = contents.session, source = {
      workspaceId: context.workspaceId, browserId: context.browserId, operationId: context.operationId, navigationId: context.navigationId, url: context.url
    }
    if (this.active.has(contents.id)) throw new Error('This Browser already has a pending download.')
    this.active.add(contents.id)
    try {
      await this.ready()
      const id = randomUUID(), stagingPath = join(this.directory, `${id}.part`), now = Date.now()
      let receipt: BrowserDownloadReceipt = { ...source, id, status: 'waiting', path: options.path, filename: null, mime: null, receivedBytes: 0, totalBytes: null, createdAt: now, updatedAt: now }
      await this.reserve(receipt)
      return await new Promise<BrowserDownloadReceipt>((resolve) => {
        let item: DownloadItem | null = null, finishing = false
        const notify = (): void => {
          try { options.onUpdate?.(structuredClone(receipt)) }
          catch (error) { receipt = { ...receipt, warning: `Download status projection failed: ${message(error)}` } }
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          session.removeListener('will-download', received)
          item?.removeListener('updated', updated)
          item?.removeListener('done', done)
          options.signal?.removeEventListener('abort', aborted)
          contents.removeListener('destroyed', destroyed)
        }
        const finish = async (status: 'completed' | 'cancelled' | 'failed', warning?: string): Promise<void> => {
          if (finishing) return
          finishing = true
          cleanup()
          let reference: BrowserDownloadReference | undefined
          try {
            if (status === 'completed') {
              const bytes = await readOwnedBytes(stagingPath, maxBytes)
              if (bytes.length !== receipt.receivedBytes) throw new Error('Download file does not match Chromium received bytes.')
              const published = await this.files.writeBytes(workspace, { path: options.path, bytes })
              if (published.status !== 'written') throw new Error(published.status === 'conflict' ? 'Download destination already exists; it was preserved.' : published.message)
              reference = { ...source, kind: 'browser-download-file', id, path: options.path, revision: published.revision,
                byteLength: bytes.length, filename: receipt.filename!, mime: receipt.mime!, capturedAt: Date.now() }
            } else item?.cancel()
          } catch (error) { status = 'failed'; warning = message(error) }
          receipt = { ...receipt, status, updatedAt: Date.now(), ...(reference ? { reference } : {}), ...(warning ? { warning } : {}) }
          try { await this.save(receipt) }
          catch (error) {
            const { reference: unpublished, ...rest } = receipt
            receipt = { ...rest, status: 'failed', warning: `Download receipt could not be recorded. File availability is unconfirmed: ${message(error)}` }
            void unpublished
          }
          try { await rm(stagingPath, { force: true }) }
          catch (error) {
            receipt = { ...receipt, warning: `${receipt.warning ? receipt.warning + '\n' : ''}Download staging cleanup failed: ${message(error)}` }
            await this.save(receipt).catch(() => {}) // The completed publication remains usable; the returned warning is authoritative.
          }
          notify()
          resolve(structuredClone(receipt))
        }
        const observe = (read: () => void): void => {
          try { read() } catch (error) { void finish('failed', `Download observation failed: ${message(error)}`) }
        }
        const updated = (_event: Electron.Event, state: string): void => observe(() => {
          if (finishing || !item) return
          receipt = { ...receipt, status: 'in-progress', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() || null, updatedAt: Date.now(),
            ...(state === 'interrupted' ? { warning: 'Chromium reports the transfer interrupted; completion is unconfirmed.' } : {}) }
          if (receipt.receivedBytes > maxBytes || (receipt.totalBytes !== null && receipt.totalBytes > maxBytes)) void finish('failed', 'Download exceeded its byte budget.')
          else notify()
        })
        const done = (_event: Electron.Event, state: string): void => observe(() => {
          if (!item || finishing) return
          receipt = { ...receipt, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() || null }
          void finish(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed',
            state === 'completed' ? undefined : state === 'cancelled' ? 'Chromium cancelled the download.' : 'Chromium did not complete the download.')
        })
        const received = (_event: Electron.Event, download: DownloadItem, owner: WebContents): void => observe(() => {
          if (finishing || item || !owner || owner.id !== contents.id) return
          item = download
          download.setSavePath(stagingPath)
          download.on('updated', updated)
          download.once('done', done)
          receipt = { ...receipt, status: 'received', filename: download.getFilename(), mime: download.getMimeType(), receivedBytes: download.getReceivedBytes(), totalBytes: download.getTotalBytes() || null, updatedAt: Date.now() }
          notify()
          if (receipt.receivedBytes > maxBytes || (receipt.totalBytes !== null && receipt.totalBytes > maxBytes)) void finish('failed', 'Download exceeded its byte budget.')
        })
        const aborted = (): void => { void finish('cancelled', 'Download was cancelled by its operation.') }
        const destroyed = (): void => { void finish('failed', 'The owning Browser closed before download completion was confirmed.') }
        const timer = setTimeout(() => { void finish('failed', 'Download did not complete within its waiting budget.') }, timeoutMs)
        session.on('will-download', received)
        contents.once('destroyed', destroyed)
        options.signal?.addEventListener('abort', aborted, { once: true })
        if (options.signal?.aborted) aborted()
        else Promise.resolve().then(trigger).catch(error => { if (!item) void finish('failed', `Download trigger failed: ${message(error)}`) })
      })
    } finally { this.active.delete(contents.id) }
  }

  async read(reference: BrowserDownloadReference, current: BrowserDownloadCurrentOwner, options: BrowserDownloadReadOptions = {}): Promise<BrowserDownloadChunk> {
    await this.ready()
    if (!reference || reference.kind !== 'browser-download-file' || !UUID.test(reference.id) || !current.workspaceId ||
      reference.workspaceId !== current.workspaceId || reference.browserId !== current.browserId) throw new Error('Download reference does not belong to this Workspace and Browser.')
    const receipt = await this.load(reference.id)
    const original = receipt.reference
    if (receipt.status !== 'completed' || !original || Object.keys(original).length === 0 ||
      Object.keys(original).length !== Object.keys(reference).length || Object.entries(original).some(([key, value]) => value !== reference[key as keyof BrowserDownloadReference])) {
      throw new Error('Download reference does not match a durably completed transfer.')
    }
    const workspace = this.resolveWorkspace(current.workspaceId)
    if (workspace.id !== current.workspaceId) throw new Error('Download Workspace does not match its verified owner.')
    const read = await this.files.readBytes(workspace, reference.path, { ...options, expectedRevision: reference.revision })
    if (read.totalBytes !== reference.byteLength) throw new Error('Download file no longer matches its recorded length.')
    return { reference: structuredClone(original), encoding: 'base64', data: Buffer.from(read.bytes).toString('base64'),
      offset: read.offset, returnedBytes: read.returnedBytes, totalBytes: read.totalBytes, revision: read.revision,
      nextOffset: read.nextOffset, readCost: read.readCost }
  }

  async list(current: BrowserDownloadCurrentOwner): Promise<BrowserDownloadReceipt[]> {
    await this.ready()
    const receipts = await Promise.all((await this.ids()).map(id => this.load(id)))
    return receipts.filter(receipt => receipt.workspaceId === current.workspaceId && receipt.browserId === current.browserId).sort((a, b) => a.createdAt - b.createdAt)
  }

  private async save(receipt: BrowserDownloadReceipt): Promise<void> {
    const document = JSON.stringify({ schema: SCHEMA, receipt })
    if (Buffer.byteLength(document) > MAX_METADATA_BYTES) throw new Error('Download receipt exceeds its metadata budget.')
    await durableWriteFile(join(this.directory, `${receipt.id}.json`), document)
  }

  private async reserve(receipt: BrowserDownloadReceipt): Promise<void> {
    const reservation = this.receiptTail.then(async () => { await this.makeRoom(); await this.save(receipt) })
    this.receiptTail = reservation.catch(() => {})
    await reservation
  }

  private async load(id: string): Promise<BrowserDownloadReceipt> {
    const record = JSON.parse((await readOwnedBytes(join(this.directory, `${id}.json`), MAX_METADATA_BYTES)).toString('utf8')) as { schema: string; receipt: BrowserDownloadReceipt }
    const receipt = record.receipt, reference = receipt?.reference
    if (record.schema !== SCHEMA || receipt?.id !== id || !receipt.workspaceId || !receipt.browserId ||
      !receipt.operationId || !receipt.navigationId || typeof receipt.url !== 'string' || !receipt.path || !states.has(receipt.status)) throw new Error('Download receipt is unavailable or invalid.')
    if (receipt.status === 'completed' && (!reference || reference.kind !== 'browser-download-file' || reference.id !== id ||
      reference.workspaceId !== receipt.workspaceId || reference.browserId !== receipt.browserId || reference.operationId !== receipt.operationId ||
      reference.navigationId !== receipt.navigationId || reference.url !== receipt.url || reference.path !== receipt.path ||
      !/^sha256:[0-9a-f]{64}$/.test(reference.revision) || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 ||
      reference.byteLength > WORKSPACE_FILE_MAX_BYTES)) throw new Error('Completed download receipt does not match its recorded source and file.')
    return receipt
  }

  private async ids(): Promise<string[]> {
    return (await readdir(this.directory)).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).map(name => name.slice(0, -5))
  }

  private async makeRoom(): Promise<void> {
    const ids = await this.ids()
    if (ids.length < MAX_RECEIPTS) return
    const receipts = (await Promise.all(ids.map(id => this.load(id)))).filter(receipt => terminal.has(receipt.status)).sort((a, b) => a.createdAt - b.createdAt)
    let count = ids.length
    for (const receipt of receipts) {
      if (count < MAX_RECEIPTS) break
      await rm(join(this.directory, `${receipt.id}.json`), { force: true })
      count--
    }
    if (count >= MAX_RECEIPTS) throw new Error('The download receipt budget is occupied by pending transfers.')
  }

  private ready(): Promise<void> {
    return this.readyPromise ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const receipts = await Promise.all((await this.ids()).map(id => this.load(id)))
      receipts.sort((a, b) => a.createdAt - b.createdAt)
      for (const receipt of receipts) {
        if (!terminal.has(receipt.status)) await this.save({ ...receipt, status: 'failed', updatedAt: Date.now(), warning: 'Transfer completion was not recorded before the app restarted. File availability is unconfirmed.' })
        await rm(join(this.directory, `${receipt.id}.part`), { force: true })
      }
      for (const receipt of receipts.slice(0, Math.max(0, receipts.length - MAX_RECEIPTS))) await rm(join(this.directory, `${receipt.id}.json`), { force: true })
    })()
  }
}

export async function waitForBrowserDownload(downloads: BrowserDownloads, context: BrowserDownloadContext,
  trigger: () => void | Promise<unknown>, options: BrowserDownloadOptions): Promise<BrowserDownloadReceipt> {
  return await downloads.wait(context, trigger, options)
}

export async function readBrowserDownload(downloads: BrowserDownloads, reference: BrowserDownloadReference,
  current: BrowserDownloadCurrentOwner, options?: BrowserDownloadReadOptions): Promise<BrowserDownloadChunk> {
  return await downloads.read(reference, current, options)
}

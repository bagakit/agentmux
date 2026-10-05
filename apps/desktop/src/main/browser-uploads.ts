import { mintObjectId, isObjectId } from '@agentmux/core/object-id'
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import { basename, join } from 'node:path'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type { BrowserUploadFile, BrowserUploadReceipt, BrowserUploadSource, BrowserRetainedUploadSelection, BrowserRetainedUploads } from '../shared/browser-upload.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'
import type { WorkspaceFiles } from './workspace-files.js'

const MAX_FILES = 4
const MAX_RETAINED_BYTES = 128 * 1024 * 1024
const MAX_SELECTIONS = 128
type Selection = { directory: string; browserId: string; navigationId: string; workspaceId: string | null; operationId: string;
  documentSurvivesClient: boolean; bytes: number; files: BrowserUploadFile[]; released: boolean; unknown: boolean }
const metadataName = 'selection.json'
const text = z.string().min(1).max(2048)
const selectionMetadata = z.object({ version: z.literal(1), workspaceId: text, browserId: text, navigationId: text, operationId: text,
  documentSurvivesClient: z.boolean(), bytes: z.number().int().min(0).max(MAX_RETAINED_BYTES),
  files: z.array(z.object({ path: text, name: text, byteLength: z.number().int().min(0).max(WORKSPACE_FILE_MAX_BYTES), revision: text }).strict()).min(1).max(MAX_FILES) }).strict()
export class BrowserUploadUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('Files may already be selected, but the upload action could not be confirmed. Check the original page before retrying; selected-file snapshots remain available until navigation or close.', { cause })
    this.name = 'BrowserUploadUnconfirmedError'
  }
}
export type BrowserUploadContext = BrowserUploadSource & {
  currentNavigationId(): string
  /** The original document may outlive this Client process. This is an owner fact, not a browser brand. */
  documentSurvivesClient: boolean
  /** Exact current-snapshot resolution, on the target's original frame sender. Never semantic healing. */
  target: { objectId: string; sendCommand: BrowserCdpSender }
}

/** Operation-owned snapshots survive script completion so the page can submit its FileList later. */
export class BrowserUploads {
  private readyPromise: Promise<void> | null = null
  private readonly selections = new Map<string, Set<Selection>>()
  private selectionCount = 0
  private retainedBytes = 0
  private disposed = false
  private warning: string | undefined
  private unaccounted = false
  constructor(private readonly directory: string, private readonly files: WorkspaceFiles,
    private readonly resolveWorkspace: (id: string) => WorkspaceRecord) {}

  async upload(context: BrowserUploadContext, paths: unknown): Promise<BrowserUploadReceipt> {
    if (this.disposed) throw new Error('The upload owner is closed.')
    if (!context.workspaceId || !context.browserId || !context.operationId || !context.navigationId) throw new Error('Upload requires a verified Workspace and current Browser operation.')
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES || paths.some(path => typeof path !== 'string' || !path)) throw new Error(`Upload requires 1 to ${MAX_FILES} Workspace-relative file paths.`)
    const workspace = this.resolveWorkspace(context.workspaceId)
    if (workspace.id !== context.workspaceId) throw new Error('Upload Workspace does not match its verified owner.')
    const requireCurrent = (): void => {
      if (context.currentNavigationId() !== context.navigationId) throw new Error('The upload document changed. Take a fresh snapshot and choose the file input again.')
    }
    const inspect = async (): Promise<{ multiple: boolean }> => {
      requireCurrent()
      const result = await context.target.sendCommand('Runtime.callFunctionOn', {
        objectId: context.target.objectId, returnByValue: true,
        functionDeclaration: 'function(){if(!(this instanceof HTMLInputElement)||this.type!=="file"||!this.isConnected||this.disabled)throw new Error("Current target is not an enabled file input");return {multiple:this.multiple}}'
      }) as { result?: { value?: { multiple: boolean } }; exceptionDetails?: unknown }
      requireCurrent()
      if (result.exceptionDetails || !result.result?.value || typeof result.result.value.multiple !== 'boolean') throw new Error('The current target is unavailable or is not an enabled file input. File chooser dialogs are not supported; select an actual file input from a fresh snapshot.')
      return result.result.value
    }
    const target = await inspect()
    if (paths.length > 1 && !target.multiple) throw new Error('This file input accepts only one file.')
    await this.ready()
    requireCurrent()
    if (this.unaccounted) throw new Error('Some retained upload snapshots have no verified document metadata. Inspect selected files in Browser settings before adding another upload.')
    if (this.selectionCount >= MAX_SELECTIONS) throw new Error('Upload staging is full. Navigate or close an unused Browser to release its selected files.')
    const selection: Selection = { directory: await this.allocateSelectionDirectory(), browserId: context.browserId, navigationId: context.navigationId, workspaceId: context.workspaceId, operationId: context.operationId, documentSurvivesClient: context.documentSurvivesClient, bytes: 0, files: [], released: false, unknown: false }
    if (this.disposed || this.selectionCount >= MAX_SELECTIONS) {
      await rm(selection.directory, { recursive: true, force: true })
      throw new Error('Upload staging is full. Navigate or close an unused Browser to release its selected files.')
    }
    const selected = this.selections.get(context.browserId) ?? new Set<Selection>()
    selected.add(selection)
    this.selections.set(context.browserId, selected)
    ++this.selectionCount
    const requireOwned = (): void => {
      requireCurrent()
      if (this.disposed || selection.released) throw new Error('The Browser document released this upload before files were assigned.')
    }
    let actionStarted = false
    try {
      const staged: string[] = []
      for (const path of paths as string[]) {
        requireOwned()
        const snapshot = await this.files.snapshotBytes(workspace, path)
        requireOwned()
        if (snapshot.bytes.length !== snapshot.totalBytes || snapshot.totalBytes > WORKSPACE_FILE_MAX_BYTES || snapshot.nextOffset !== null) throw new Error('Upload requires a complete bounded Workspace file snapshot.')
        if (this.retainedBytes + snapshot.totalBytes > MAX_RETAINED_BYTES) throw new Error('Upload byte budget is full. Navigate or close an unused Browser to release its selected files.')
        // Reserve before the next asynchronous write, so concurrent Browsers share the same bound.
        this.retainedBytes += snapshot.totalBytes
        selection.bytes += snapshot.totalBytes
        const name = basename(path)
        if (!name || name === '.' || name === '..') throw new Error('Upload file has no usable filename.')
        const parent = join(selection.directory, String(staged.length))
        await mkdir(parent, { mode: 0o700 })
        const destination = join(parent, name)
        await durableWriteFile(destination, snapshot.bytes)
        staged.push(destination)
        selection.files.push({ path, name, byteLength: snapshot.totalBytes, revision: snapshot.revision })
      }
      const currentTarget = await inspect()
      if (paths.length > 1 && !currentTarget.multiple) throw new Error('The file input changed to accept only one file. No files were assigned.')
      requireOwned()
      // objectId binds the exact document object across the final CDP call. backend ids can be reused
      // after navigation; no selector, stale ref healing or wrong-frame fallback is allowed here.
      // Write ahead of the irreversible DOM assignment. A crash after this fact is
      // durable cannot prove that the page did not receive the files.
      await durableWriteFile(join(selection.directory, metadataName), JSON.stringify({ version: 1,
        workspaceId: selection.workspaceId, browserId: selection.browserId, navigationId: selection.navigationId,
        operationId: selection.operationId, documentSurvivesClient: selection.documentSurvivesClient, bytes: selection.bytes, files: selection.files }))
      requireOwned()
      actionStarted = true
      await context.target.sendCommand('DOM.setFileInputFiles', { objectId: context.target.objectId, files: staged })
      requireOwned()
      const observed = await context.target.sendCommand('Runtime.callFunctionOn', { objectId: context.target.objectId, returnByValue: true,
        functionDeclaration: 'function(){return Array.from(this.files, file=>({name:file.name,byteLength:file.size}))}' }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      requireOwned()
      const observedFiles = observed.result?.value
      if (observed.exceptionDetails || !Array.isArray(observedFiles) || observedFiles.length === 0 || observedFiles.length !== selection.files.length ||
        observedFiles.some((file, index) => !file || file.name !== selection.files[index]!.name || file.byteLength !== selection.files[index]!.byteLength)) {
        throw new Error('Files were sent to the current input, but its FileList could not be verified. Check the original page before retrying; selected-file snapshots remain available.')
      }
      return { kind: 'browser-upload-files', workspaceId: context.workspaceId, browserId: context.browserId,
        operationId: context.operationId, navigationId: context.navigationId,
        files: structuredClone(selection.files), byteLength: selection.bytes }
    } catch (error) {
      // A lost acknowledgement cannot prove that the input was unchanged. Keep any possible FileList
      // readable until its real document lifecycle ends, and never repeat the action automatically.
      if (!actionStarted) await this.remove(selection)
      else { selection.unknown = true; throw new BrowserUploadUnconfirmedError(error) }
      throw error
    }
  }

  /** A confirmed original document end, never merely a lost sharing connection. */
  async releaseDocument(browserId: string, navigationId: string): Promise<void> {
    await this.ready()
    const selections = [...(this.selections.get(browserId) ?? [])].filter(selection => selection.navigationId === navigationId)
    for (const selection of selections) selection.released = true
    await Promise.all(selections.map(selection => this.remove(selection)))
  }

  /** The native owner has ended all of its current documents. */
  async releaseBrowser(browserId: string): Promise<void> {
    await this.ready()
    const selections = [...(this.selections.get(browserId) ?? [])]
    for (const selection of selections) selection.released = true
    await Promise.all(selections.map(selection => this.remove(selection)))
  }

  async retained(): Promise<BrowserRetainedUploads> {
    await this.ready()
    const rows: BrowserRetainedUploadSelection[] = [...this.selections.values()].flatMap(selected => [...selected])
      .filter(selection => !selection.released && selection.documentSurvivesClient).map(selection => ({
        id: basename(selection.directory), browserId: selection.browserId || null, navigationId: selection.navigationId || null,
        workspaceId: selection.workspaceId, files: selection.files.map(file => file.name), byteLength: selection.bytes,
        status: selection.unknown ? 'unknown' : 'selected' }))
    return { selections: rows.slice(0, MAX_SELECTIONS), selectionCount: this.selectionCount, byteLength: this.retainedBytes,
      selectionLimit: MAX_SELECTIONS, byteLimit: MAX_RETAINED_BYTES,
      ...(this.warning || rows.length > MAX_SELECTIONS ? { warning: this.warning ?? 'More retained selections exist than this bounded view can show. No new upload can be staged.' } : {}) }
  }

  /** Called only after the local person confirms this exact displayed selection. */
  async confirmDiscardSelection(id: string, confirm: (selection: BrowserRetainedUploadSelection) => Promise<boolean>): Promise<boolean> {
    await this.ready()
    const selection = [...this.selections.values()].flatMap(selected => [...selected]).find(selection => basename(selection.directory) === id && !selection.released && selection.documentSurvivesClient)
    if (!selection) return false
    const accepted = await confirm({ id: basename(selection.directory), browserId: selection.browserId || null, navigationId: selection.navigationId || null,
      workspaceId: selection.workspaceId, files: selection.files.map(file => file.name), byteLength: selection.bytes, status: selection.unknown ? 'unknown' : 'selected' })
    if (!accepted || selection.released || !this.selections.get(selection.browserId)?.has(selection)) return false
    await this.remove(selection)
    if (!this.selections.get('')?.size) { this.unaccounted = false; this.warning = undefined }
    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const selections = [...this.selections.values()].flatMap(selected => [...selected]).filter(selection => !selection.documentSurvivesClient)
    for (const selection of selections) selection.released = true
    await Promise.all(selections.map(selection => this.remove(selection)))
  }

  private async remove(selection: Selection): Promise<void> {
    if (!this.selections.get(selection.browserId)?.has(selection)) return
    selection.released = true
    await rm(selection.directory, { recursive: true, force: true })
    const selected = this.selections.get(selection.browserId)
    if (selected?.delete(selection)) {
      this.retainedBytes -= selection.bytes
      --this.selectionCount
      if (!selected.size) this.selections.delete(selection.browserId)
    }
  }

  private async allocateSelectionDirectory(): Promise<string> {
    for (;;) {
      const directory = join(this.directory, mintObjectId())
      try { await mkdir(directory, { mode: 0o700 }); return directory }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }

  private ready(): Promise<void> {
    return this.readyPromise ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // Only a native document ends with this Client. Independent documents keep
      // their original files; restoring metadata never reconnects or observes a page.
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || (!isObjectId(entry.name) && !/^upload-[A-Za-z0-9]{6}$/.test(entry.name))) continue
        const directory = join(this.directory, entry.name)
        let data: z.infer<typeof selectionMetadata> | undefined
        try {
          const metadata = await lstat(join(directory, metadataName))
          if (!metadata.isFile() || metadata.size > 32 * 1024) throw new Error('Unbounded upload metadata')
          data = selectionMetadata.parse(JSON.parse(await readFile(join(directory, metadataName), 'utf8')))
          if (data.files.reduce((sum, file) => sum + file.byteLength, 0) !== data.bytes) throw new Error('Upload byte count differs')
          for (const [index, file] of data.files.entries()) {
            if (basename(file.path) !== file.name || basename(file.name) !== file.name || ['.', '..'].includes(file.name)) throw new Error('Upload filename differs')
            const parent = await lstat(join(directory, String(index)))
            const snapshot = await lstat(join(directory, String(index), file.name))
            if (!parent.isDirectory() || !snapshot.isFile() || snapshot.size !== file.byteLength) throw new Error('Upload snapshot differs')
          }
        } catch { data = undefined }
        if (data && !data.documentSurvivesClient) { await rm(directory, { recursive: true, force: true }); continue }
        let bytes = data?.bytes ?? 0
        if (!data) {
          // No invented document owner and no silent deletion. Count bounded original
          // snapshot positions; unknown extra content blocks new staging, not a page.
          this.unaccounted = true
          this.warning = 'Some upload snapshots have no verified document metadata. They remain on disk; no new upload is staged until you inspect and discard these exact selections in Browser settings.'
          for (let index = 0; index < MAX_FILES; index++) {
            try {
              const parent = join(directory, String(index))
              if (!(await lstat(parent)).isDirectory()) continue
              for (const file of await readdir(parent, { withFileTypes: true })) if (file.isFile()) bytes += (await lstat(join(parent, file.name))).size
            } catch { /* Unknown ownership stays visible and blocks new staging. */ }
          }
        }
        const selection: Selection = { directory, browserId: data?.browserId ?? '', navigationId: data?.navigationId ?? '',
          workspaceId: data?.workspaceId ?? null, operationId: data?.operationId ?? '', documentSurvivesClient: true,
          bytes, files: data?.files ?? [], released: false, unknown: true }
        const selected = this.selections.get(selection.browserId) ?? new Set<Selection>()
        selected.add(selection); this.selections.set(selection.browserId, selected)
        ++this.selectionCount; this.retainedBytes += selection.bytes
      }
    })()
  }
}

export async function uploadBrowserFiles(owner: BrowserUploads, context: BrowserUploadContext, paths: unknown): Promise<BrowserUploadReceipt> {
  return await owner.upload(context, paths)
}

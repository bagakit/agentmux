import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type { BrowserUploadFile, BrowserUploadReceipt, BrowserUploadSource } from '../shared/browser-upload.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'
import type { WorkspaceFiles } from './workspace-files.js'

const MAX_FILES = 4
const MAX_RETAINED_BYTES = 128 * 1024 * 1024
const MAX_SELECTIONS = 128
type Selection = { directory: string; browserId: string; navigationId: string; bytes: number; files: BrowserUploadFile[]; released: boolean }
export class BrowserUploadUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('Files may already be selected, but the upload action could not be confirmed. Check the original page before retrying; selected-file snapshots remain available until navigation or close.', { cause })
    this.name = 'BrowserUploadUnconfirmedError'
  }
}
export type BrowserUploadContext = BrowserUploadSource & {
  currentNavigationId(): string
  /** Exact current-snapshot resolution, on the target's original frame sender. Never semantic healing. */
  target: { objectId: string; send: BrowserCdpSender }
}

/** Operation-owned snapshots survive script completion so the page can submit its FileList later. */
export class BrowserUploads {
  private readyPromise: Promise<void> | null = null
  private readonly selections = new Map<string, Set<Selection>>()
  private selectionCount = 0
  private retainedBytes = 0
  private disposed = false
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
      const result = await context.target.send('Runtime.callFunctionOn', {
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
    if (this.selectionCount >= MAX_SELECTIONS) throw new Error('Upload staging is full. Navigate or close an unused Browser to release its selected files.')
    const selection: Selection = { directory: await mkdtemp(join(this.directory, 'upload-')), browserId: context.browserId, navigationId: context.navigationId, bytes: 0, files: [], released: false }
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
        await writeFile(destination, snapshot.bytes, { flag: 'wx', mode: 0o600 })
        staged.push(destination)
        selection.files.push({ path, name, byteLength: snapshot.totalBytes, revision: snapshot.revision })
      }
      const currentTarget = await inspect()
      if (paths.length > 1 && !currentTarget.multiple) throw new Error('The file input changed to accept only one file. No files were assigned.')
      requireOwned()
      // objectId binds the exact document object across the final CDP call. backend ids can be reused
      // after navigation; no selector, stale ref healing or wrong-frame fallback is allowed here.
      actionStarted = true
      await context.target.send('DOM.setFileInputFiles', { objectId: context.target.objectId, files: staged })
      requireOwned()
      const observed = await context.target.send('Runtime.callFunctionOn', { objectId: context.target.objectId, returnByValue: true,
        functionDeclaration: 'function(){return Array.from(this.files, file=>({name:file.name,byteLength:file.size}))}' }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      requireOwned()
      if (observed.exceptionDetails || JSON.stringify(observed.result?.value) !== JSON.stringify(selection.files.map(file => ({ name: file.name, byteLength: file.byteLength })))) {
        throw new Error('Files were sent to the current input, but its FileList could not be verified. Check the original page before retrying; selected-file snapshots remain available.')
      }
      return { kind: 'browser-upload-files', workspaceId: context.workspaceId, browserId: context.browserId,
        operationId: context.operationId, navigationId: context.navigationId,
        files: structuredClone(selection.files), byteLength: selection.bytes }
    } catch (error) {
      // A lost acknowledgement cannot prove that the input was unchanged. Keep any possible FileList
      // readable until its real document lifecycle ends, and never repeat the action automatically.
      if (!actionStarted) await this.remove(selection)
      else throw new BrowserUploadUnconfirmedError(error)
      throw error
    }
  }

  /** Only the related document's lifecycle releases its snapshots; unrelated Browser churn is free. */
  async releaseBrowser(browserId: string): Promise<void> {
    const selections = [...(this.selections.get(browserId) ?? [])]
    // Mark precisely this lifecycle's current selections before any asynchronous cleanup. A later
    // document may select files while old IO finishes; those new selections are not in this batch.
    for (const selection of selections) selection.released = true
    await Promise.all(selections.map(selection => this.remove(selection)))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const selections = [...this.selections.values()].flatMap(selected => [...selected])
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

  private ready(): Promise<void> {
    return this.readyPromise ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // A new native document cannot restore a prior process's FileList. Remove only this owner's
      // bounded ephemeral namespace, never Workspace files or other app payloads.
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^upload-[A-Za-z0-9]{6}$/.test(entry.name)) await rm(join(this.directory, entry.name), { recursive: true, force: true })
      }
    })()
  }
}

export async function uploadBrowserFiles(owner: BrowserUploads, context: BrowserUploadContext, paths: unknown): Promise<BrowserUploadReceipt> {
  return await owner.upload(context, paths)
}

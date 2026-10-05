import type { WorkspaceRecord } from '../shared/contracts.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { WorkspacePreviewResourceRequest, WorkspacePreviewResourceResult } from '../shared/workspace-file-preview.js'
import type { WorkspaceFiles } from './workspace-files.js'

/** Own only transient read cancellation; WorkspaceFiles owns bytes, Host, paths and revisions. */
export class FilePreviewResources {
  private readonly reads = new Map<string, AbortController>()
  private disposed = false
  constructor(private readonly files: Pick<WorkspaceFiles, 'read' | 'readPreview'>,
    private readonly workspace: (id: string) => WorkspaceRecord | undefined) {}

  async read(request: WorkspacePreviewResourceRequest): Promise<WorkspacePreviewResourceResult> {
    if (this.disposed) throw new Error('File preview resources are closed. Source was kept.')
    if (!request || typeof request.id !== 'string' || !request.id || this.reads.has(request.id) ||
        typeof request.workspaceId !== 'string' || typeof request.path !== 'string' || !['data', 'image'].includes(request.kind))
      throw new Error('File preview resource requires an exact new read request.')
    const current = this.workspace(request.workspaceId)
    if (!current) throw new Error('The original preview Workspace is unavailable. Source was kept.')
    const original = { ...current }, controller = new AbortController()
    this.reads.set(request.id, controller)
    const check = () => {
      controller.signal.throwIfAborted()
      const next = this.workspace(original.id)
      if (next?.hostId !== original.hostId || next.path !== original.path || next.kind !== original.kind)
        throw new Error('The original preview Workspace changed. Retry preview.')
    }
    try {
      if (request.kind === 'data') {
        const result = await this.files.read(original, request.path, { maxFileBytes: WORKSPACE_FILE_MAX_BYTES, signal: controller.signal })
        check()
        if (result.status !== 'read') throw new Error('message' in result ? result.message : `Chart data could not load (${result.status}). Source was kept.`)
        return { kind: 'data', content: result.document.content }
      }
      const result = await this.files.readPreview(original, request.path, { signal: controller.signal })
      check()
      if (result.status !== 'ready' || result.kind !== 'image' || result.mimeType === 'image/svg+xml')
        throw new Error('message' in result ? result.message : 'Chart image is unavailable or unsupported. Source was kept.')
      return { kind: 'image', bytes: result.bytes, mimeType: result.mimeType }
    } finally { this.reads.delete(request.id) }
  }
  cancel(id: string): void { this.reads.get(id)?.abort() }
  cancelAll(): void { for (const controller of this.reads.values()) controller.abort() }
  dispose(): void { this.disposed = true; this.cancelAll() }
}

import { presentError } from '@agentmux/client-ui/error-presentation'
import type { Loader } from 'vega'
import { api } from '../api'
import { useAppStore } from '../../store'

/** Resolve a relative chart resource without ever granting file:, HTTP or another Workspace. */
export function chartResourcePath(sourcePath: string, uri: string): string {
  if (!uri || /^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('/') || /[\\\0?#]/.test(uri)) throw new Error('Chart resources must be relative Workspace files.')
  let decoded: string
  try { decoded = decodeURIComponent(uri) } catch { throw new Error('Invalid chart resource path.') }
  if (/[\\\0?#]/.test(decoded) || decoded.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) throw new Error('Invalid chart resource path.')
  const parts = sourcePath.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) throw new Error('Chart resource leaves its Workspace.'); parts.pop() }
    else parts.push(part)
  }
  return parts.join('/')
}

function binding(workspaceId: string): string {
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)
  return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
}

/** WorkspaceFiles remains the bytes/revision/Host authority. Image bytes are encoded only in the chart Worker. */
export function createWorkspaceVegaLoader(workspaceId: string, sourcePath: string, signal: AbortSignal): Loader & { dispose(): void } {
  const original = binding(workspaceId)
  let disposed = false, invalidated = false
  const pending = new Set<string>()
  const cancelPending = () => { for (const id of pending) void api.files.cancelPreviewResource(id).catch(error => console.warn('Preview resource cancellation failed.', error)) }
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.config !== previous.config && binding(workspaceId) !== original) { invalidated = true; cancelPending() }
  })
  const dispose = () => {
    if (disposed) return
    disposed = true; cancelPending(); unsubscribe(); signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  const check = () => {
    if (disposed || signal.aborted) throw new DOMException('Chart preview was cancelled.', 'AbortError')
    if (invalidated || binding(workspaceId) !== original) throw new Error('The chart Workspace changed. Retry preview.')
  }
  const read = async (kind: 'data' | 'image', uri: string) => {
    check()
    const path = chartResourcePath(sourcePath, uri), id = crypto.randomUUID()
    pending.add(id)
    try {
      const result = await api.files.readPreviewResource({ id, workspaceId, path, kind })
      check()
      return result
    } catch (error) {
      check()
      throw new Error(presentError(error))
    } finally { pending.delete(id) }
  }
  if (signal.aborted) dispose()
  const denied = async (): Promise<never> => { throw new Error('Chart resources are restricted to the original Workspace.') }
  return {
    async load(uri) {
      const result = await read('data', uri)
      if (result.kind !== 'data') throw new Error('Chart data returned an invalid resource.')
      return result.content
    },
    async sanitize(uri, options) {
      check()
      if (options?.context !== 'image') throw new Error('Chart navigation is unavailable in a read-only preview.')
      if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(uri)) return { href: uri }
      const result = await read('image', uri)
      if (result.kind !== 'image' || result.mimeType === 'image/svg+xml') throw new Error('Chart image is unavailable or unsupported.')
      // Private loader metadata crosses only our fixed sanitize port. Vega receives
      // the data URL after the Worker has encoded the already-authorized bytes.
      return { href: uri, bytes: new Uint8Array(result.bytes), mimeType: result.mimeType }
    },
    http: denied, file: denied,
    dispose
  }
}

import type { PickFilesOptions, PickFilesResult } from '@capawesome/capacitor-file-picker'

/** Browser change/cancel events own this selection; returning focus is not cancellation. */
export function pickWebFiles(options: PickFilesOptions = {}, signal?: AbortSignal): Promise<PickFilesResult> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = options.types?.join(',') ?? ''
    input.multiple = options.limit !== 1
    input.hidden = true
    const cleanup = () => { input.removeEventListener('change', changed); input.removeEventListener('cancel', cancelled); signal?.removeEventListener('abort', cancelled); input.remove() }
    const changed = () => {
      const files = Array.from(input.files ?? []).map(blob => ({ blob, name: blob.name, mimeType: blob.type, size: blob.size, modifiedAt: blob.lastModified }))
      cleanup(); resolve({ files })
    }
    const cancelled = () => { cleanup(); resolve({ files: [] }) }
    input.addEventListener('change', changed)
    input.addEventListener('cancel', cancelled)
    if (signal?.aborted) { cleanup(); resolve({ files: [] }); return }
    signal?.addEventListener('abort', cancelled, { once: true })
    document.body.append(input)
    try { input.click() }
    catch (error) { cleanup(); reject(error) }
  })
}

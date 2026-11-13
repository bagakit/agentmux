import type { ArchiveSource } from './types'
import { pageBook } from './page-book'

const imageType = (path: string) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' })[path.split('.').pop()?.toLowerCase() ?? '']

export async function openCbrBook(source: ArchiveSource, name: string, controller: AbortController) {
  const pages = (await source.entries(controller.signal)).filter(entry => imageType(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  controller.signal.throwIfAborted()
  if (!pages.length) throw new Error('This comic archive contains no supported image pages.')
  return pageBook(name, pages.map(page => ({ id: page.path, size: page.size })), controller, async (index, signal) => {
    const page = pages[index]!, bytes = await source.loadEntry(page.path, signal)
    signal.throwIfAborted()
    if (bytes.length !== page.size) throw new Error('The comic page changed while it was being read.')
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageType(page.path) ?? 'application/octet-stream' })
  })
}

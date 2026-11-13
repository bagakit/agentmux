import type { RandomAccessSource } from '../bytes'
import type { ArchiveSource } from './page-decoders/types'
import type { BookFormat, ReaderBook } from './types'
export type { ReaderBook, BookSection, BookFormat, BookMetadata, BookTocItem, BookLocation } from './types'

export interface OpenBookOptions {
  format: BookFormat
  name: string
  signal?: AbortSignal
  archiveSource?: ArchiveSource
}

/**
 * Run in an isolated reader document realm: upstream DOM adapters require DOMParser, not an App-global DOM or a pretend Worker.
 * The host retains source identity, access permission and closure. Closing a book cancels its own reads only.
 */
export async function openBook(source: RandomAccessSource, options: OpenBookOptions): Promise<ReaderBook> {
  const controller = new AbortController()
  const cancel = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  try {
    controller.signal.throwIfAborted()
    let book: ReaderBook
    switch (options.format) {
      case 'epub': book = await (await import('./adapters/epub')).openEpub(source, options.name, controller); break
      case 'cbz': book = await (await import('./adapters/cbz')).openCbz(source, options.name, controller); break
      case 'fb2': book = await (await import('./adapters/fb2')).openFb2(source, options.name, controller); break
      case 'djvu': book = await (await import('./page-decoders/djvu')).openDjvuBook(source, options.name, controller); break
      case 'cbr': {
        if (!options.archiveSource) throw Object.assign(new Error('Comic RAR reading needs the original host archive source'), { code: 'BOOK_ARCHIVE_SOURCE_UNAVAILABLE' })
        book = await (await import('./page-decoders/cbr')).openCbrBook(options.archiveSource, options.name, controller)
        break
      }
      case 'mobi': case 'azw3': book = await (await import('./adapters/mobi')).openMobi(source, options.name, controller); break
    }
    const destroy = book.destroy.bind(book)
    book.destroy = () => { options.signal?.removeEventListener('abort', cancel); destroy() }
    return book
  } catch (error) {
    controller.abort(error)
    options.signal?.removeEventListener('abort', cancel)
    throw error
  }
}

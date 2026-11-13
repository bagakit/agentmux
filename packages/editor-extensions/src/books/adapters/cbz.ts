import type { RandomAccessSource } from '../../bytes'
import { openBookArchive } from '../archive'
import { BookResources } from '../resources'
import { readerBook, type ParsedBook } from '../normalize'
import { sanitizeBookDocument } from '../security'
import { makeComicBook } from '../vendor/foliate/comic-book.js'

export async function openCbz(source: RandomAccessSource, name: string, controller: AbortController) {
  const archive = await openBookArchive(source, controller.signal), resources = new BookResources()
  try {
    const parsed = makeComicBook(archive, { name }, { urls: resources, sanitizeDocument: sanitizeBookDocument })
    return readerBook(parsed as ParsedBook, name, resources, controller, archive.close)
  } catch (error) { resources.destroy(); archive.close(); throw error }
}

import type { RandomAccessSource } from '../../bytes'
import { openBookArchive } from '../archive'
import { BookResources } from '../resources'
import { readerBook, type ParsedBook } from '../normalize'
import { sanitizeBookDocument } from '../security'
import { EPUB } from '../vendor/foliate/epub.js'

export async function openEpub(source: RandomAccessSource, name: string, controller: AbortController) {
  const archive = await openBookArchive(source, controller.signal), resources = new BookResources()
  try {
    const parser = new EPUB({ ...archive, urls: resources, sha1: undefined, sanitizeDocument: sanitizeBookDocument })
    const parsed = await parser.init()
    // Script manifest entries never need to be materialized as resources.
    parsed.transformTarget.addEventListener('load', (event: Event) => {
      const detail = (event as CustomEvent<{ isScript: boolean; allow: boolean }>).detail
      if (detail.isScript) detail.allow = false
    })
    return readerBook(parsed as ParsedBook, name, resources, controller, archive.close)
  } catch (error) { resources.destroy(); archive.close(); throw error }
}

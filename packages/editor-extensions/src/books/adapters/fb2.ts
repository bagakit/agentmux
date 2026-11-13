import type { RandomAccessSource } from '../../bytes'
import { BookResources } from '../resources'
import { readerBook, type ParsedBook } from '../normalize'
import { SourceFile } from '../source-file'
import { sanitizeBookDocument } from '../security'
import { makeFB2 } from '../vendor/foliate/fb2.js'

/** FB2 is one XML document; its initial parse reads that document. Chapters and page URLs are materialized lazily. */
export async function openFb2(source: RandomAccessSource, name: string, controller: AbortController) {
  const resources = new BookResources()
  try {
    const parsed = await makeFB2(new SourceFile(source, name, controller.signal), { urls: resources, sanitizeDocument: sanitizeBookDocument })
    return readerBook(parsed as ParsedBook, name, resources, controller)
  } catch (error) { resources.destroy(); throw error }
}

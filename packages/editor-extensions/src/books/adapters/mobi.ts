import type { RandomAccessSource } from '../../bytes'
import { unzlibSync } from 'fflate'
import { BookResources } from '../resources'
import { readerBook, type ParsedBook } from '../normalize'
import { SourceFile } from '../source-file'
import { sanitizeBookDocument } from '../security'
import { isMOBI, MOBI } from '../vendor/foliate/mobi.js'

/** PDB records are sliced from the host source. Legacy MOBI6 text must be decoded together; KF8 text is section-based. */
export async function openMobi(source: RandomAccessSource, name: string, controller: AbortController) {
  const resources = new BookResources(), file = new SourceFile(source, name, controller.signal)
  try {
    if (!await isMOBI(file)) throw Object.assign(new Error('This file does not have a MOBI/Kindle header'), { code: 'BOOK_FORMAT' })
    const parsed = await new MOBI({ unzlib: unzlibSync, urls: resources, sanitizeDocument: sanitizeBookDocument }).open(file)
    return readerBook(parsed as ParsedBook, name, resources, controller)
  } catch (error) { resources.destroy(); throw error }
}

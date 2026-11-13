import { BlobWriter, Reader, TextWriter, ZipReader } from '@zip.js/zip.js'
import type { RandomAccessSource } from '../bytes'
import { archivePath } from './security'

export async function openBookArchive(source: RandomAccessSource, signal: AbortSignal) {
  class BookReader extends Reader<Uint8Array> {
    constructor() { super(new Uint8Array()); this.size = source.size }
    async readUint8Array(offset: number, length: number) {
      signal.throwIfAborted()
      const bytes = await source.read(offset, length, signal)
      signal.throwIfAborted()
      return bytes
    }
  }
  // The consumer runs in the isolated reader realm. CompressionStream is native; no global worker configuration.
  const reader = new ZipReader(new BookReader(), { useWebWorkers: false, signal })
  try {
    const entries = (await reader.getEntries()).filter(entry => !entry.directory)
    const byPath = new Map(entries.map(entry => [archivePath(entry.filename), entry]))
    if (byPath.size !== entries.length) throw Object.assign(new Error('The book archive has duplicate resource paths'), { code: 'BOOK_ARCHIVE_PATH' })
    return {
      entries,
      async loadText(path: string): Promise<string | null> {
        const entry = byPath.get(archivePath(path))
        return entry ? await entry.getData!(new TextWriter(), { signal }) : null
      },
      async loadBlob(path: string): Promise<Blob | null> {
        const entry = byPath.get(archivePath(path))
        return entry ? await entry.getData!(new BlobWriter(), { signal }) : null
      },
      getSize(path: string): number { return byPath.get(archivePath(path))?.uncompressedSize ?? 0 },
      close(): void { void reader.close() }
    }
  } catch (error) { await reader.close(); throw error }
}

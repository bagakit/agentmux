import type { RandomAccessSource } from '../bytes'

/** The Blob slicing contract used by MOBI, backed by original host reads rather than a whole-file Blob. */
export class SourceFile {
  readonly size: number
  constructor(readonly source: RandomAccessSource, readonly name: string, readonly signal: AbortSignal,
    readonly offset = 0, size = source.size) { this.size = size }

  slice(start = 0, end = this.size): SourceFile {
    const at = (value: number) => Math.max(0, Math.min(this.size, value < 0 ? this.size + value : value))
    const from = at(start), to = Math.max(from, at(end))
    return new SourceFile(this.source, this.name, this.signal, this.offset + from, to - from)
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.signal.throwIfAborted()
    const bytes = await this.source.read(this.offset, this.size, this.signal)
    this.signal.throwIfAborted()
    if (bytes.byteLength !== this.size) throw Object.assign(new Error('The original book ended before the requested record'), { code: 'BOOK_TRUNCATED' })
    return bytes.slice().buffer as ArrayBuffer
  }
}

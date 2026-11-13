/** One original read-only file. The host owns identity, permissions and closure. */
export interface RandomAccessSource {
  readonly size: number
  /** Read exactly length bytes at offset; EOF returns only the remaining bytes. Reject cancellation or IO failure. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

/** An already-produced in-memory artifact, such as the result of an explicit document build. */
export class MemoryRandomAccessSource implements RandomAccessSource {
  private readonly bytes: Uint8Array
  readonly size: number
  constructor(bytes: Uint8Array) { this.bytes = bytes.slice(); this.size = bytes.length }
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError('A byte read needs a nonnegative integer span.')
    return this.bytes.slice(offset, offset + Math.min(length, Math.max(0, this.size - offset)))
  }
}

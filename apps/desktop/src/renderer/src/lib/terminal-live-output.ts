export type TerminalLiveOutputChunk = {
  data: string
  startByte: number
  endByte: number
}

/** Keep one visual live-output write bounded while coalescing small RuntimeEvents. */
export const TERMINAL_LIVE_OUTPUT_BATCH_BYTES = 64 * 1024

function chunkBytes(chunk: TerminalLiveOutputChunk): number {
  return Math.max(0, chunk.endByte - chunk.startByte)
}

/** Takes the largest ordered prefix that fits the visual batch budget. */
export function takeTerminalLiveOutputBatch(
  chunks: readonly TerminalLiveOutputChunk[],
  maxBytes = TERMINAL_LIVE_OUTPUT_BATCH_BYTES
): { batch: TerminalLiveOutputChunk[]; rest: TerminalLiveOutputChunk[] } {
  if (chunks.length === 0) return { batch: [], rest: [] }
  const limit = Math.max(1, Math.floor(maxBytes))
  let bytes = 0
  let count = 0
  while (count < chunks.length) {
    const chunk = chunks[count]
    if (!chunk) break
    const size = chunkBytes(chunk)
    if (count > 0 && bytes + size > limit) break
    bytes += size
    count += 1
  }
  return {
    batch: chunks.slice(0, count),
    rest: chunks.slice(count)
  }
}

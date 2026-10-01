import type { AgentMuxRunAttachment } from '@agentmux/core'
import { composeTerminalLiveOutputWrite } from './live-output.js'

export type TerminalReplayResult = Pick<AgentMuxRunAttachment, 'replay' | 'gap'>

export type TerminalReplayChunk = {
  dataBytes: Uint8Array
  endByte: number
}

/**
 * Keep one xterm write small enough that a large retained scrollback cannot monopolize the
 * renderer. A write still contains a contiguous sequence of terminal bytes; the boundary is
 * only a scheduling boundary, and xterm's parser is explicitly able to continue an escape
 * sequence in the next write.
 */
export const TERMINAL_REPLAY_BATCH_BYTES = 128 * 1024

/** Let the host process input, navigation, and close actions between parser batches. */
export function yieldTerminalWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Restores retained terminal bytes without turning a large replay into one uninterruptible write. */
async function writeTerminalBytes(
  chunks: readonly { dataBytes: Uint8Array }[],
  write: (data: Uint8Array) => Promise<void>,
  yieldWork: () => Promise<void> = yieldTerminalWork
): Promise<void> {
  if (chunks.length === 0) return
  let batch = new Uint8Array(TERMINAL_REPLAY_BATCH_BYTES)
  let length = 0
  const flush = async (): Promise<void> => {
    if (length === 0) return
    const current = batch.subarray(0, length)
    batch = new Uint8Array(TERMINAL_REPLAY_BATCH_BYTES)
    length = 0
    await write(current)
    await yieldWork()
  }
  for (const chunk of chunks) {
    // Split oversized daemon chunks as well as aggregating many small chunks. Terminal control
    // sequences remain ordered across writes, while the host gets a scheduling point at the
    // configured upper bound instead of waiting for the entire scrollback to parse.
    let offset = 0
    while (offset < chunk.dataBytes.byteLength) {
      const remaining = TERMINAL_REPLAY_BATCH_BYTES - length
      const take = Math.min(remaining, chunk.dataBytes.byteLength - offset)
      batch.set(chunk.dataBytes.subarray(offset, offset + take), length)
      length += take
      offset += take
      if (length >= TERMINAL_REPLAY_BATCH_BYTES) await flush()
    }
  }
  await flush()
}

/** A synthetic seed has no raw byte range and must not pass through output inspectors. */
export async function restoreTerminalCheckpoint(
  restoreBytes: Uint8Array,
  write: (data: Uint8Array) => Promise<void>,
  yieldWork: () => Promise<void> = yieldTerminalWork
): Promise<void> {
  await writeTerminalBytes([{ dataBytes: restoreBytes }], write, yieldWork)
}

/** Restores original output, returning its raw byte cursor rather than the parser write size. */
export async function hydrateTerminalReplay(
  chunks: readonly TerminalReplayChunk[],
  write: (data: Uint8Array) => Promise<void>,
  yieldWork: () => Promise<void> = yieldTerminalWork
): Promise<number | null> {
  if (chunks.length === 0) return null
  await writeTerminalBytes(chunks, write, yieldWork)
  return chunks.at(-1)!.endByte
}

/** Backfill from the last parsed cursor, leaving queued overlap to the existing byte composer. */
export async function recoverTerminalRetainedOutput(options: {
  cursor: number
  /** Latest known queued byte; an empty/short read cannot claim this discontinuity was recovered. */
  throughByte: number
  read(afterByte: number): Promise<TerminalReplayResult>
  write(data: Uint8Array): Promise<void>
}): Promise<{ cursor: number; gap: boolean; incomplete: boolean }> {
  const result = await options.read(options.cursor)
  const composed = composeTerminalLiveOutputWrite(result.replay, options.cursor)
  if (composed.gap && !result.gap) throw new Error('Retained history did not provide a continuous byte range.')
  // Use the byte composer's original byte suffix: an overlapping replay must never write
  // already-parsed bytes again. The hydration owner still yields between bounded parser writes.
  const cursor = await hydrateTerminalReplay(composed.dataBytes.byteLength
    ? [{ dataBytes: composed.dataBytes, endByte: composed.cursor }] : [], options.write)
  return {
    cursor: Math.max(options.cursor, cursor ?? options.cursor),
    gap: result.gap !== null,
    incomplete: result.gap === null && composed.cursor < options.throughByte
  }
}

/** Public parser facts; neither an alternate repaint nor a row cache is an output archive. */
export function terminalHistoryBoundary(buffer: { type: 'normal' | 'alternate'; length: number }, rows: number, scrollback: number): string | null {
  if (buffer.type === 'alternate') return 'The full-screen buffer has no terminal scrollback. Earlier output depends on the application’s history controls.'
  if (buffer.length >= rows + scrollback) return `This terminal view retains up to ${scrollback} normal-buffer history lines. Earlier Runtime bytes may still be retained.`
  return null
}


export type TerminalReplayChunk = {
  data: string
  endByte: number
}

/**
 * Keep one xterm write small enough that a large retained scrollback cannot monopolize the
 * renderer. A write still contains a contiguous sequence of terminal bytes; the boundary is
 * only a scheduling boundary, and xterm's parser is explicitly able to continue an escape
 * sequence in the next write.
 */
export const TERMINAL_REPLAY_BATCH_CHARS = 128 * 1024

/** Let Electron process input, tab switches, and close actions between parser batches. */
export function yieldTerminalWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Restores retained terminal bytes without turning a large replay into one uninterruptible write. */
export async function hydrateTerminalReplay(
  chunks: readonly TerminalReplayChunk[],
  write: (data: string) => Promise<void>,
  yieldWork: () => Promise<void> = yieldTerminalWork
): Promise<number | null> {
  if (chunks.length === 0) return null
  let batch = ''
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const current = batch
    batch = ''
    await write(current)
    await yieldWork()
  }
  for (const chunk of chunks) {
    // Split oversized daemon chunks as well as aggregating many small chunks. Terminal control
    // sequences remain ordered across writes, while the host gets a scheduling point at the
    // configured upper bound instead of waiting for the entire scrollback to parse.
    let offset = 0
    while (offset < chunk.data.length) {
      const remaining = TERMINAL_REPLAY_BATCH_CHARS - batch.length
      const take = Math.min(remaining, chunk.data.length - offset)
      batch += chunk.data.slice(offset, offset + take)
      offset += take
      if (batch.length >= TERMINAL_REPLAY_BATCH_CHARS) await flush()
    }
  }
  await flush()
  return chunks.at(-1)!.endByte
}

/**
 * Crosses the replay-to-live boundary in one fixed order. Gap redraw is last:
 * a TUI repaint must not race retained replay or the startup live buffer.
 */
export async function finishTerminalReplayRecovery(options: {
  gap: boolean
  canControlRun: boolean
  startLiveSynchronization(): Promise<void>
  releaseLiveOutput(): Promise<void>
  redrawCurrentScreen(): Promise<boolean>
  onRedrawError?(error: unknown): void
  onRecoveryError?(error: unknown): void
}): Promise<boolean> {
  // Release the startup buffer before resize/fit. Resize crosses the same per-Run
  // serialization boundary as attach; waiting for it first can leave a visible but
  // permanently frozen terminal when that optional sync is the step that stalled.
  try {
    await options.releaseLiveOutput()
  } catch (error) {
    options.onRecoveryError?.(error)
  }
  if (options.canControlRun) {
    try {
      await options.startLiveSynchronization()
    } catch (error) {
      // Attach and replay already succeeded. A viewport-sync failure is a local
      // recovery degradation, not an attach failure and must not replace the pane.
      options.onRecoveryError?.(error)
    }
  }
  if (!options.gap || !options.canControlRun) return false
  try {
    return await options.redrawCurrentScreen()
  } catch (error) {
    options.onRedrawError?.(error)
    return false
  }
}

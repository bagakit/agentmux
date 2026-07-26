export type TerminalReplayChunk = {
  data: string
  endByte: number
}

/** Restores retained terminal bytes as one parser transaction, not a visible history playback. */
export async function hydrateTerminalReplay(
  chunks: readonly TerminalReplayChunk[],
  write: (data: string) => Promise<void>
): Promise<number | null> {
  if (chunks.length === 0) return null
  await write(chunks.map((chunk) => chunk.data).join(''))
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

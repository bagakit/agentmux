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
}): Promise<boolean> {
  if (options.canControlRun) await options.startLiveSynchronization()
  await options.releaseLiveOutput()
  if (!options.gap || !options.canControlRun) return false
  try {
    return await options.redrawCurrentScreen()
  } catch (error) {
    options.onRedrawError?.(error)
    return false
  }
}

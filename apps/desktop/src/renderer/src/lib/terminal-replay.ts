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

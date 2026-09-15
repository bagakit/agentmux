import type { AgentMuxRunState } from '@agentmux/core'
import type { SessionReplayResult } from '../../../shared/contracts'
import { TERMINAL_REVEAL_DEADLINE_MS } from './terminal-reveal'
import { composeTerminalLiveOutputWrite } from './terminal-live-output'
import { agentViabilityFromProcessState, type StepOutcome } from './service-window-notice'

export function terminalReplayGeometryOutcome(unknown: boolean, processState: AgentMuxRunState): StepOutcome {
  if (!unknown) return { completed: true }
  return {
    completed: false,
    agentViability: agentViabilityFromProcessState(processState),
    step: {
      label: 'Confirming replay geometry',
      degradedMode: 'The terminal remains available. Retained output may have an incorrect layout because its size is unknown.',
      restore: 'Viewport synchronization requests a repaint of the current screen. Resize the pane to retry; historical layout cannot be confirmed.'
    }
  }
}

export function terminalViewportSyncOutcome(failed: boolean, processState: AgentMuxRunState): StepOutcome {
  if (!failed) return { completed: true }
  return {
    completed: false,
    agentViability: agentViabilityFromProcessState(processState),
    step: {
      label: 'Synchronizing terminal size',
      degradedMode: 'The terminal remains available, but the Runtime has not confirmed the requested screen size.',
      restore: 'Resize the pane or return to this tab to retry. This notice clears when the Runtime confirms the resize.'
    }
  }
}

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

/** Let Electron process input, tab switches, and close actions between parser batches. */
export function yieldTerminalWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Restores retained terminal bytes without turning a large replay into one uninterruptible write. */
export async function hydrateTerminalReplay(
  chunks: readonly TerminalReplayChunk[],
  write: (data: Uint8Array) => Promise<void>,
  yieldWork: () => Promise<void> = yieldTerminalWork
): Promise<number | null> {
  if (chunks.length === 0) return null
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
  return chunks.at(-1)!.endByte
}

/** A history read is optional recovery work; it cannot hold a healthy live pane indefinitely. */
export function boundedTerminalHistoryRead(read: Promise<SessionReplayResult>): Promise<SessionReplayResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Retained history read timed out; Runtime history availability is unknown.')), TERMINAL_REVEAL_DEADLINE_MS)
    // Keep rejection observed after the deadline. Core owns the transient Attachment's cleanup;
    // RuntimeController refuses another read for this Run until this operation actually settles.
    void read.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Backfill from the last parsed cursor, leaving queued overlap to the existing byte composer. */
export async function recoverTerminalRetainedOutput(options: {
  cursor: number
  /** Latest known queued byte; an empty/short read cannot claim this discontinuity was recovered. */
  throughByte: number
  read(afterByte: number): Promise<SessionReplayResult>
  write(data: Uint8Array): Promise<void>
}): Promise<{ cursor: number; gap: boolean; incomplete: boolean }> {
  const result = await boundedTerminalHistoryRead(options.read(options.cursor))
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

/**
 * Crosses the replay-to-live boundary in one fixed order. Gap redraw is last:
 * a TUI repaint must not race retained replay or the startup live buffer.
 */
export async function finishTerminalReplayRecovery(options: {
  gap: boolean
  canControlRun: boolean
  startLiveSynchronization(): Promise<void>
  releaseLiveOutput(): Promise<void>
  finishReplay(): void
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
  } finally {
    // The startup bytes were rendered at the attachment's size too. Unlock only after their
    // drain settles, including failed drains and historical Runs that cannot resize a PTY.
    options.finishReplay()
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

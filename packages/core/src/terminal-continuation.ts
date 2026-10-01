import { AgentMuxError } from './errors.js'
import type {
  AgentMuxRun,
  AgentMuxRunDataEvent,
  AgentMuxTerminalCheckpoint,
  AgentMuxTerminalContinuation,
  AgentMuxTerminalResize
} from './types.js'

export type AgentMuxTerminalContinuationStep =
  | { type: 'restore'; checkpoint: AgentMuxTerminalCheckpoint; restoreBytes: Uint8Array }
  | { type: 'data'; startByte: number; endByte: number; dataBytes: Uint8Array }
  | ({ type: 'resized' } & AgentMuxTerminalResize)

/** Validate synthetic restore facts before an emulator changes its geometry or history policy. */
export function assertTerminalCheckpointRestore(checkpoint: AgentMuxTerminalCheckpoint, restoreBytes: Uint8Array): void {
  const grid = (size: { cols: number; rows: number }): boolean =>
    Number.isSafeInteger(size.cols) && size.cols > 0 && Number.isSafeInteger(size.rows) && size.rows > 0
  if (!grid(checkpoint.size) || !grid(checkpoint.restoreSize) ||
      !Number.isSafeInteger(checkpoint.resizeAfterRestoreBytes) || checkpoint.resizeAfterRestoreBytes < 0 ||
      checkpoint.resizeAfterRestoreBytes > restoreBytes.byteLength ||
      checkpoint.restoreScrollbackRows !== null &&
        (!Number.isSafeInteger(checkpoint.restoreScrollbackRows) || checkpoint.restoreScrollbackRows < 0)) {
    throw new AgentMuxError('Terminal checkpoint restore has inconsistent geometry or prefix facts.', 'CTXMUX_EVENT_INVALID')
  }
}

/**
 * The two clients of this ordering are xterm views and Provider screen observations.
 * The Runtime owns every fact; this iterator only interleaves its original bytes and resizes.
 * Synthetic restore bytes have their own step and never enter an output byte range.
 */
export function* terminalContinuationSteps(snapshot: {
  run: Pick<AgentMuxRun, 'runId' | 'latestOutputBytes'>
  terminal: AgentMuxTerminalContinuation
  replay: readonly Pick<AgentMuxRunDataEvent, 'startByte' | 'endByte' | 'dataBytes'>[]
  resizeRevision: number
}): Generator<AgentMuxTerminalContinuationStep> {
  const terminal = snapshot.terminal
  if (terminal.type !== 'basic-vt') {
    for (const chunk of snapshot.replay) yield { type: 'data', ...chunk }
    return
  }
  const invalid = (): never => {
    throw new AgentMuxError('Terminal continuation has inconsistent byte or geometry ordering.', 'CTXMUX_EVENT_INVALID')
  }
  const checkpoint = terminal.checkpoint
  const resizes = terminal.resizes
  if (checkpoint.runId !== snapshot.run.runId) invalid()
  assertTerminalCheckpointRestore(checkpoint, terminal.restoreBytes)
  yield { type: 'restore', checkpoint, restoreBytes: terminal.restoreBytes }
  let cursor = checkpoint.throughByte
  let revision = checkpoint.resizeRevision
  let resizeIndex = 0
  function* resizeAtCursor(): Generator<AgentMuxTerminalContinuationStep> {
    while (resizeIndex < resizes.length) {
      const resize = resizes[resizeIndex]!
      if (resize.throughByte < cursor) invalid()
      if (resize.throughByte !== cursor) break
      if (resize.resizeRevision !== revision + 1) invalid()
      revision = resize.resizeRevision
      resizeIndex += 1
      yield { type: 'resized', ...resize }
    }
  }
  for (const chunk of snapshot.replay) {
    if (chunk.startByte !== cursor || chunk.endByte - chunk.startByte !== chunk.dataBytes.byteLength) invalid()
    yield* resizeAtCursor()
    while (cursor < chunk.endByte) {
      const nextResize = resizes[resizeIndex]
      const endByte = nextResize ? Math.min(chunk.endByte, nextResize.throughByte) : chunk.endByte
      if (endByte <= cursor) invalid()
      yield {
        type: 'data', startByte: cursor, endByte,
        dataBytes: chunk.dataBytes.subarray(cursor - chunk.startByte, endByte - chunk.startByte)
      }
      cursor = endByte
      yield* resizeAtCursor()
    }
  }
  yield* resizeAtCursor()
  if (resizeIndex !== resizes.length || cursor !== snapshot.run.latestOutputBytes ||
      revision !== snapshot.resizeRevision) invalid()
}

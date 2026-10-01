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

const invalidContinuation = (): never => {
  throw new AgentMuxError('Terminal continuation has inconsistent byte or geometry ordering.', 'CTXMUX_EVENT_INVALID')
}
function continuationRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return invalidContinuation()
  return value as Record<string, unknown>
}
function continuationCursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidContinuation()
  return value as number
}
function continuationSize(value: unknown): void {
  const size = continuationRecord(value, ['cols', 'rows'])
  for (const axis of ['cols', 'rows']) {
    const amount = continuationCursor(size[axis])
    if (amount < 1 || amount > 0xffff) invalidContinuation()
  }
}

/** Check the synthetic seed before an emulator mutates its grid or history policy. */
export function assertTerminalCheckpointRestore(checkpoint: AgentMuxTerminalCheckpoint, restoreBytes: Uint8Array): void {
  continuationSize(checkpoint.size)
  continuationSize(checkpoint.restoreSize)
  const prefix = continuationCursor(checkpoint.resizeAfterRestoreBytes)
  if (!(restoreBytes instanceof Uint8Array) || prefix > restoreBytes.byteLength) invalidContinuation()
  if (checkpoint.restoreScrollbackRows !== null) continuationCursor(checkpoint.restoreScrollbackRows)
}

/** Validate the original Attachment DTO at another client boundary. This owner
 * also supplies the existing byte/resize ordering; it does not recreate a screen. */
export function parseTerminalContinuation(value: unknown, snapshot: {
  run: Pick<AgentMuxRun, 'runId' | 'latestOutputBytes'>; resizeRevision: number
}): AgentMuxTerminalContinuation {
  const latest = continuationCursor(snapshot.run.latestOutputBytes)
  const revision = continuationCursor(snapshot.resizeRevision)
  if (!value || typeof value !== 'object') return invalidContinuation()
  const kind = (value as { type?: unknown }).type
  if (kind === 'not-requested') continuationRecord(value, ['type'])
  else if (kind === 'unknown' || kind === 'unavailable') {
    const terminal = continuationRecord(value, ['type', 'reason'])
    if (typeof terminal.reason !== 'string' || !['origin_unknown', 'source_gap', 'tail_evicted', 'checkpoint_too_large', 'invalid_checkpoint'].includes(terminal.reason)) invalidContinuation()
  } else if (kind === 'basic-vt') {
    const terminal = continuationRecord(value, ['type', 'checkpoint', 'restoreBytes', 'resizes'])
    const checkpoint = continuationRecord(terminal.checkpoint, ['runId', 'throughByte', 'resizeRevision', 'size', 'restoreSize', 'restoreScrollbackRows', 'resizeAfterRestoreBytes'])
    let throughByte = continuationCursor(checkpoint.throughByte), currentRevision = continuationCursor(checkpoint.resizeRevision)
    continuationSize(checkpoint.size)
    if (checkpoint.runId !== snapshot.run.runId || throughByte > latest ||
      !(terminal.restoreBytes instanceof Uint8Array) || terminal.restoreBytes.byteLength < 1 ||
      terminal.restoreBytes.byteLength > 32 * 1024 * 1024 || !Array.isArray(terminal.resizes) || terminal.resizes.length > 1024) return invalidContinuation()
    assertTerminalCheckpointRestore(checkpoint as AgentMuxTerminalCheckpoint, terminal.restoreBytes)
    for (const item of terminal.resizes) {
      const resize = continuationRecord(item, ['throughByte', 'resizeRevision', 'size'])
      const at = continuationCursor(resize.throughByte), nextRevision = continuationCursor(resize.resizeRevision)
      continuationSize(resize.size)
      if (at < throughByte || at > latest || nextRevision !== currentRevision + 1) invalidContinuation()
      throughByte = at; currentRevision = nextRevision
    }
    if (currentRevision !== revision) invalidContinuation()
  } else return invalidContinuation()
  return value as AgentMuxTerminalContinuation
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
  const terminal = parseTerminalContinuation(snapshot.terminal, snapshot)
  if (terminal.type !== 'basic-vt') {
    for (const chunk of snapshot.replay) yield { type: 'data', ...chunk }
    return
  }
  const invalid = invalidContinuation
  const checkpoint = terminal.checkpoint
  const resizes = terminal.resizes
  if (checkpoint.runId !== snapshot.run.runId) invalid()
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

import type { FileHistoryParams, FileRestoreParams, FileUndoParams, FileWriteReceipt } from '@agentmux/core/files'
import type { NoteResource } from '@agentmux/core/notebook-catalog'

/** Client recovery facts on the original File document; none are Markdown or another writable body. */
export type NoteFileEditing = {
  baseline?: { content: string; revision: string }
  attempt?: NoteFileAttempt | undefined
  receipt?: NoteWrittenReceipt
  /** Unconsumed editor delta and the exact newer draft it must be mapped onto. */
  input?: NoteFileInput | undefined
}
export type NoteFileInput = {
  baseContent: string
  observedContent: string
  proposedContent: string
  resource: NoteResource
  phase: 'mapping' | 'conflict'
  /** Later deltas keep the exact document each editor actually displayed. */
  queued?: { baseContent: string; proposedContent: string }[]
}
export type NoteWrittenReceipt = Omit<Extract<FileWriteReceipt, { status: 'written' }>, 'content'>
export type NoteFileHistoryTarget = Omit<FileHistoryParams, 'limit' | 'before' | 'eventId' | 'includeContent'>
export type NoteHistorySelection = { target: NoteFileHistoryTarget } & ({ eventId: string } | { batchId: string; batchLastEventId: string })
export type NoteFileAttempt = {
  operationId: string
  noteId: string | null
  content: string
  baseContent?: string
  enhanced?: true
  retainDraft?: true
  expectedRevision: string | null
  generation: number
  resource: NoteResource
  phase: 'sending' | 'unknown' | 'written'
  /** Fixed original public mapping, when it was confirmed for this intent. */
  target?: NoteFileHistoryTarget
  action?: { kind: 'restore'; params: FileRestoreParams } | { kind: 'undo'; params: FileUndoParams }
  canonical?: string
  written?: NoteWrittenReceipt
}

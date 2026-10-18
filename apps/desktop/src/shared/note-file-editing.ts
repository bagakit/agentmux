import type { FileHistoryParams, FileRestoreParams, FileUndoParams, FileWriteReceipt } from '@agentmux/core/files'
import type { NoteResource } from '@agentmux/core/notebook-catalog'

/** Client recovery facts on the original File document; none are Markdown or another writable body. */
export type NoteFileEditing = {
  baseline?: { content: string; revision: string }
  attempt?: NoteFileAttempt | undefined
  receipt?: NoteWrittenReceipt
  /** Unconsumed editor delta and the exact newer draft it must be mapped onto. */
  input?: NoteFileInput | undefined
  /** Unsaved reference capabilities, recovered with the existing File draft; never block bodies. */
  shares?: Record<string, PendingNoteShare>
  /** The whole original first-use intent survives settlement of any individual file. */
  share?: { params: import('@agentmux/core/files').FileShareParams; references: string[] } | undefined
  /** Known rejected first-send plan; retained for inspection, never replayed automatically. */
  shareRejection?: { params: import('@agentmux/core/files').FileShareParams; code: string; message: string }
  /** Removal and optional collection are one original intent, independently of one file receipt. */
  shareUndo?: { params: import('@agentmux/core/files').FileShareUndoParams } | undefined
  shareUndoReceipt?: { operationId: string; status?: import('@agentmux/core/files').FileShareUndoResult['status']; retained: { noteId?: string; code: string; message: string }[] } | undefined
}
export type NoteShareCopy = { version: 1; source: NoteResource & { noteId: string }; read?: import('@agentmux/core/files').FileReadParams; block: { path: number[]; fingerprint: string; blockId?: string }; proposalId?: string; include?: import('./note-document').NoteInclude }
export type PendingNoteShare = { copy: NoteShareCopy; operationId: string; include: import('./note-document').NoteInclude }
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

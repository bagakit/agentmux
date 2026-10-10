import { fileUploadRevision, type FileWriteReceipt } from '@agentmux/core/files'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'

export type NoteWrittenReceipt = Omit<Extract<FileWriteReceipt, { status: 'written' }>, 'content' | 'noteProvenance'>
export type NoteEditAttempt = {
  content: string; expectedRevision: string; phase: 'sending' | 'unknown' | 'written'
  noteHistory?: FileWriteReceipt['noteHistory']
  /** A known write whose canonical bytes have not yet been observed. */
  written?: NoteWrittenReceipt
  /** Exact saved bytes waiting for later local deltas to be reconciled. */
  canonicalContent?: string
}

export type NoteEditState = {
  noteId: string; draft: string; expectedRevision: string
  attempt?: NoteEditAttempt | undefined
  receipt?: NoteWrittenReceipt
  /** Actual editor delta waiting to be mapped onto this acknowledged draft. */
  input?: { baseContent: string; observedContent: string; proposedContent: string; issue?: string } | undefined
  unconfirmed?: { content: string; expectedRevision: string; noteHistory?: FileWriteReceipt['noteHistory']; written?: NoteWrittenReceipt }[]
  alternates?: { draft: string; expectedRevision: string }[]
}

/** Older ordinary CAS callbacks may omit an unchanged body; its exact hash proves those bytes. */
export function noteWriteCanonicalContent(sentContent: string, result: Extract<FileWriteReceipt, { status: 'written' }>): string | undefined {
  if (result.content !== undefined) return result.content
  return result.contentUnavailable === undefined && fileUploadRevision(new TextEncoder().encode(sentContent)) === result.revision ? sentContent : undefined
}

/** A canonical receipt advances the saved baseline without replacing a later local edit. */
export function acknowledgeNoteWrite(state: NoteEditState, sentContent: string, sentRevision: string, result: Extract<FileWriteReceipt, { status: 'written' }>, deferCanonical = false): NoteEditState {
  if (state.attempt && (state.attempt.content !== sentContent || state.attempt.expectedRevision !== sentRevision) ||
    state.expectedRevision !== sentRevision && state.expectedRevision !== result.revision) return state
  if (!deferCanonical && !state.attempt && state.receipt?.revision === result.revision &&
      state.receipt.noteHistory?.eventId === result.noteHistory?.eventId && state.receipt.noteHistory?.batchId === result.noteHistory?.batchId) return state
  const canonical = noteWriteCanonicalContent(sentContent, result)
  const pending = deferCanonical || canonical === undefined || canonical !== sentContent && state.draft !== sentContent && state.draft !== canonical
  const { content: _content, noteProvenance: _provenance, ...receipt } = result
  return { ...state, receipt, expectedRevision: result.revision,
    attempt: pending ? { content: sentContent, expectedRevision: sentRevision, phase: 'written', written: receipt, ...(canonical === undefined ? {} : { canonicalContent: canonical }),
      ...(result.noteHistory ? { noteHistory: result.noteHistory } : {}) } : undefined,
    ...(!pending && canonical !== undefined && state.draft === sentContent ? { draft: canonical } : {}) }
}

/** A later read observes only its own revision; it never settles an unknown original write. */
export function acknowledgeNoteCanonicalRead(state: NoteEditState, document: { content: string; revision: string }): NoteEditState {
  const attempt = state.attempt
  if (attempt?.phase !== 'written' || !attempt.written || attempt.written.revision !== document.revision || state.expectedRevision !== document.revision ||
      fileUploadRevision(new TextEncoder().encode(document.content)) !== document.revision) return state
  const header = readNoteMarkdownHeader(document.content)
  if (header.status !== 'valid' || header.noteId !== state.noteId) return state
  const { contentUnavailable: _unavailable, ...written } = attempt.written
  return { ...acknowledgeNoteWrite(state, attempt.content, attempt.expectedRevision, { ...written, content: document.content }),
    receipt: state.receipt ?? attempt.written }
}

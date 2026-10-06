import type { FileWriteReceipt } from '@agentmux/core/files'

export type NoteEditState = {
  noteId: string; draft: string; expectedRevision: string
  attempt?: { content: string; expectedRevision: string; phase: 'sending' | 'unknown' } | undefined
  unconfirmed?: { content: string; expectedRevision: string }[]
  alternates?: { draft: string; expectedRevision: string }[]
}

/** A canonical receipt advances the saved baseline without replacing a later local edit. */
export function acknowledgeNoteWrite(state: NoteEditState, sentContent: string, sentRevision: string, result: Extract<FileWriteReceipt, { status: 'written' }>): NoteEditState {
  if (state.attempt && (state.attempt.content !== sentContent || state.attempt.expectedRevision !== sentRevision) ||
    state.expectedRevision !== sentRevision && state.expectedRevision !== result.revision) return state
  return { ...state, attempt: undefined, expectedRevision: result.revision,
    ...(result.content !== undefined && state.draft === sentContent ? { draft: result.content } : {}) }
}

import type { GitDiffSide, GitFileDiff } from '../../../shared/contracts'

/**
 * The two text sides a Monaco DiffEditor renders, derived from a structured {@link GitFileDiff}.
 *
 * This is the one place the diff's directionality is decided, and getting it wrong is worse than
 * having no diff at all: a diff whose `original` and `modified` both came from the worktree always
 * shows "no changes" while looking like it works. So the mapping is fixed and asserted — `original`
 * is ALWAYS the old side (the HEAD blob) and `modified` is ALWAYS the new side (the worktree file),
 * exactly as {@link GitFileDiff} labels them. An absent side (added file has no old, deleted file has
 * no new) becomes empty text, which is how Monaco draws a pure insertion/deletion.
 *
 * `binary` is surfaced separately because a binary side carries no text at all — the caller shows a
 * placeholder rather than feeding two empty strings to the diff (which would read as "no changes").
 */
export type DiffEditorSides = {
  original: string
  modified: string
  binary: boolean
}

function sideText(side: GitDiffSide): string {
  // Absent or binary sides have no text; a present text side is the only one that carries content.
  return side.present && !side.binary ? side.text : ''
}

export function diffEditorSides(diff: GitFileDiff): DiffEditorSides {
  return {
    // old = HEAD (left/original), new = worktree (right/modified). Never the same source on both
    // sides — that is the "always empty diff" defect this function exists to make impossible to write
    // silently: swap these and the co-located test reddens.
    original: sideText(diff.old),
    modified: sideText(diff.new),
    binary: diff.binary
  }
}

/** Monaco's `wordWrap` option value for the current toggle state. One place maps the bit to the enum. */
export function wordWrapOption(wrap: boolean): 'on' | 'off' {
  return wrap ? 'on' : 'off'
}

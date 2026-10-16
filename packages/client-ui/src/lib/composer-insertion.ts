import { closeHistory } from '@tiptap/pm/history'
import { selectionToInsertionEnd, type Editor, type JSONContent } from '@tiptap/core'

export type ComposerInsert = (
  resolve: () => string | null | Promise<string | null>,
  options?: { separate?: boolean }
) => Promise<void>
export type ComposerInsertionHandle = {
  insert: ComposerInsert
  replace(value: string): void
  /** Replace a confirmed original editor range; returns false if that exact text no longer exists. */
  replaceRange?(range: { from: number; to: number; expected: string }, value: string): boolean
}
export type ComposerPasteImage = (file: File, insert: ComposerInsert) => void

/** An open document slice joins its edge paragraphs to the surrounding text, like a native paste. */
export function replaceComposerRange(editor: Editor, content: JSONContent, range: { from: number; to: number } = editor.state.selection): void {
  const parsed = editor.schema.nodeFromJSON(content)
  const slice = parsed.slice(1, parsed.content.size - 1)
  const selection = editor.state.selection
  const followInsertion = selection.from === range.from && selection.to === range.to
  const transaction = editor.state.tr.replaceRange(range.from, range.to, slice)
  if (followInsertion) selectionToInsertionEnd(transaction, transaction.steps.length - 1, -1)
  editor.view.dispatch(transaction.scrollIntoView())
}

/** Whole-draft history selection is a synchronous, single undoable edit in the same editor. */
export function replaceComposerDraft(editor: Editor, content: JSONContent): void {
  const parsed = editor.schema.nodeFromJSON(content)
  const transaction = closeHistory(editor.state.tr).replaceWith(0, editor.state.doc.content.size, parsed.content)
  selectionToInsertionEnd(transaction, transaction.steps.length - 1, -1)
  editor.view.dispatch(transaction.scrollIntoView())
  // A subsequent typed edit must not be grouped into this replacement either.
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.commands.focus()
}

/** Keep an async attachment anchored in the maintained editor's transaction history, not a draft copy. */
export async function insertComposerContent(
  editor: Editor,
  resolve: () => string | null | Promise<string | null>,
  parse: (value: string) => JSONContent,
  options: { separate?: boolean } = {}
): Promise<void> {
  if (!editor.isEditable || editor.view.composing) throw new Error('The message editor is not accepting this attachment. Your draft was not changed.')
  let bookmark = editor.state.selection.getBookmark()
  const document = editor.view.dom.ownerDocument
  const focusOwner = document.activeElement
  const map = ({ transaction }: { transaction: { mapping: Parameters<typeof bookmark.map>[0] } }) => {
    bookmark = bookmark.map(transaction.mapping)
  }
  editor.on('transaction', map)
  try {
    const value = await resolve()
    if (value === null || value === '') return
    if (editor.isDestroyed) throw new Error('The message editor closed before the attachment finished. The saved draft was not changed.')
    if (!editor.isEditable || editor.view.composing) throw new Error('The message editor is not accepting this attachment. Your draft was not changed.')
    const range = bookmark.resolve(editor.state.doc)
    const { from } = range
    const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\ufffc')
    const after = editor.state.doc.textBetween(range.to, Math.min(editor.state.doc.content.size, range.to + 1), '\n', '\ufffc')
    const prefix = options.separate && before && !/\s/u.test(before) ? ' ' : ''
    const suffix = options.separate && after && !/\s/u.test(after) && !/\s$/u.test(value) ? ' ' : ''
    // Every external insertion is one edit, isolated from neighboring manual typing.
    editor.view.dispatch(closeHistory(editor.state.tr))
    replaceComposerRange(editor, parse(`${prefix}${value}${suffix}`), range)
    editor.view.dispatch(closeHistory(editor.state.tr))
    if (document.activeElement === focusOwner || editor.isFocused) editor.commands.focus()
  } finally {
    editor.off('transaction', map)
  }
}

export type ComposerDropFiles = (files: readonly File[], insert: ComposerInsert) => void

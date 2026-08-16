import { selectionToInsertionEnd, type Editor, type JSONContent } from '@tiptap/core'

export type ComposerInsert = (
  resolve: () => string | null | Promise<string | null>,
  options?: { separate?: boolean }
) => Promise<void>
export type ComposerInsertionHandle = { insert: ComposerInsert }
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

/** Keep an async attachment anchored in the maintained editor's transaction history, not a draft copy. */
export async function insertComposerContent(
  editor: Editor,
  resolve: () => string | null | Promise<string | null>,
  parse: (value: string) => JSONContent,
  options: { separate?: boolean } = {}
): Promise<void> {
  let bookmark = editor.state.selection.getBookmark()
  const focusOwner = document.activeElement
  const map = ({ transaction }: { transaction: { mapping: Parameters<typeof bookmark.map>[0] } }) => {
    bookmark = bookmark.map(transaction.mapping)
  }
  editor.on('transaction', map)
  try {
    const value = await resolve()
    if (value === null || value === '') return
    if (editor.isDestroyed) throw new Error('The message editor closed before the attachment finished. The saved draft was not changed.')
    const range = bookmark.resolve(editor.state.doc)
    const { from } = range
    const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, '\n', ' ')
    const prefix = options.separate && before && !/\s/u.test(before) ? ' ' : ''
    replaceComposerRange(editor, parse(`${prefix}${value}`), range)
    if (document.activeElement === focusOwner || editor.isFocused) editor.commands.focus()
  } finally {
    editor.off('transaction', map)
  }
}

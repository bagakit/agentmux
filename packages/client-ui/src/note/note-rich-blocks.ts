import { Extension } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { BulletList, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'

/** Inline Markdown images belong to their original paragraph, including mixed text. */
export const NoteImageNode = Image.configure({ inline: true, resize: false })
export const NoteTaskItemNode = TaskItem.configure({ nested: true })
export const NoteTaskListNode = TaskList
// GFM allows checked and ordinary items in the same ordered or unordered list.
export const NoteBulletListNode = BulletList.extend({ content: '(listItem | taskItem)+' })
export const NoteOrderedListNode = OrderedList.extend({ content: '(listItem | taskItem)+' })
export const NoteTableNode = Table.configure({ resizable: false })
export const NoteTableRowNode = TableRow
export const NoteTableCellNode = TableCell.extend({ content: 'paragraph' })
export const NoteTableHeaderNode = TableHeader.extend({ content: 'paragraph' })
/** GFM cells have one inline flow; Enter retains a line break in that same cell. */
export const NoteTableEnter = Extension.create({
  name: 'noteTableEnter',
  priority: 1100,
  addKeyboardShortcuts() { return { Enter: () => (this.editor.isActive('tableCell') || this.editor.isActive('tableHeader')) && this.editor.commands.setHardBreak() } }
})

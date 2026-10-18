import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { TableMap } from '@tiptap/pm/tables'

/** Only expose operations representable in a normal Markdown table. */
export function NoteTableTools({ editor }: { editor: Editor }) {
  const table = useEditorState({ editor, selector: ({ editor }) => editor.isEditable && editor.isActive('table') })
  if (!table) return null
  return <div className="note-table-tools" role="group" aria-label="Table tools">
    <select className="note-rich-insert" aria-label="Edit table" value="" onChange={event => {
      const command = event.currentTarget.value
      if (command === 'row-before') editor.chain().focus().addRowBefore().run()
      else if (command === 'row-after') editor.chain().focus().addRowAfter().run()
      else if (command === 'remove-row') editor.chain().focus().deleteRow().run()
      else if (command === 'column-before') editor.chain().focus().addColumnBefore().run()
      else if (command === 'column-after') editor.chain().focus().addColumnAfter().run()
      else if (command === 'remove-column') editor.chain().focus().deleteColumn().run()
      else if (command === 'remove-table') editor.chain().focus().deleteTable().run()
    }}>
      <option value="" disabled>Table…</option><option value="row-before">Row above</option><option value="row-after">Row below</option><option value="remove-row">Delete row</option>
      <option value="column-before">Column before</option><option value="column-after">Column after</option><option value="remove-column">Delete column</option><option value="remove-table">Delete table</option>
    </select>
    <select className="note-rich-insert" aria-label="Align table column" value="" onChange={event => {
      const align = event.currentTarget.value
      const { $from } = editor.state.selection
      let cellDepth = $from.depth
      while (cellDepth > 0 && !['tableCell', 'tableHeader'].includes($from.node(cellDepth).type.name)) cellDepth--
      if (!cellDepth) return
      const tableDepth = cellDepth - 2, tableNode = $from.node(tableDepth), tableStart = $from.start(tableDepth)
      const map = TableMap.get(tableNode), column = map.colCount($from.before(cellDepth) - tableStart)
      const tr = editor.state.tr
      for (let row = 0; row < map.height; row++) {
        const pos = tableStart + map.map[row * map.width + column]!, cell = tr.doc.nodeAt(pos)!
        tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align })
      }
      editor.view.dispatch(tr); editor.commands.focus()
    }}><option value="" disabled>Align column…</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
  </div>
}

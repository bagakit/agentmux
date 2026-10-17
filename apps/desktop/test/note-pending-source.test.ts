// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { noteContentExtensions, closeHistory } from '../src/shared/note-content-schema'
import { observeNotePendingSource, notePendingSourceDecorations, retainNoteDraftEditor, stageNoteShare, copyNoteBlock, clearPendingNoteShares } from '../src/renderer/src/lib/note-share-staging'
import { useAppStore } from '../src/renderer/src/store'
import { serializeNoteDocument } from '../src/shared/note-document'
import { composerConfig } from './helpers/composer-dom-fixture'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixtureRoot = join(tmpdir(), 'note-pending-source')
const sourceKey = 'notes\0source.note.md', destinationKey = 'notes\0destination.note.md', callbacks: Array<() => void> = []
const initial = useAppStore.getState()
afterEach(() => { callbacks.splice(0).reverse().forEach(stop => stop()); useAppStore.setState(initial, true) })
function fixture(unanchored = false) {
 const workspace = { id: 'notes', hostId: 'local', path: fixtureRoot, name: 'Notes', kind: 'folder' as const }
 const content: JSONContent = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2, ...(unanchored ? {} : { blockId: 'chapter' }) }, content: [{ type: 'text', text: 'Chapter' }] },
  { type: 'paragraph', attrs: { blockId: 'body' }, content: [{ type: 'text', text: 'Body' }] },
  { type: 'heading', attrs: { level: 3, blockId: 'subchapter' }, content: [{ type: 'text', text: 'Subchapter' }] },
  { type: 'paragraph', attrs: { blockId: 'tail' }, content: [{ type: 'text', text: 'Tail' }] },
  { type: 'heading', attrs: { level: 2, blockId: 'next' }, content: [{ type: 'text', text: 'Next chapter' }] },
 ] }
 const source = new Editor({ extensions: noteContentExtensions(), content }), destination = new Editor({ extensions: noteContentExtensions(), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Destination' }] }] } })
 callbacks.push(() => source.destroy(), () => destination.destroy())
 useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, documents: { [sourceKey]: { path: 'source.note.md', content: serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'source', content }) }, [destinationKey]: { path: 'destination.note.md', content: serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: 'destination', content: destination.getJSON() }) } } })
 callbacks.push(retainNoteDraftEditor(sourceKey, source), retainNoteDraftEditor(destinationKey, destination))
 let changes = 0
 callbacks.push(observeNotePendingSource(sourceKey, 'source', source, () => { changes++ }))
 const initialChanges = changes
 const copy = copyNoteBlock(source, 0, { ...workspace, workspaceId: workspace.id, workspacePath: workspace.path, path: 'source.note.md', noteId: 'source' }, {} as never)
 const attrs = stageNoteShare(destinationKey, copy)
 return { source, destination, attrs, initialChanges, changes: () => changes, decorations: () => notePendingSourceDecorations(sourceKey, 'source', source.state.doc) }
}
it('projects one entire heading section and removes it on target Undo without a save or new entity', () => {
 const f = fixture()
 expect(f.decorations()).toEqual([])
 f.destination.commands.insertContentAt(f.destination.state.doc.content.size, { type: 'noteInclude', attrs: f.attrs })
 expect(f.decorations()).toHaveLength(4)
 expect(f.decorations().map(value => value.attrs['data-note-shared-edge'])).toEqual(['first', 'inside', 'inside', 'last'])
 expect(f.decorations().at(-1)!.to).toBe(f.source.state.doc.child(0).nodeSize + f.source.state.doc.child(1).nodeSize + f.source.state.doc.child(2).nodeSize + f.source.state.doc.child(3).nodeSize)
 expect(f.changes()).toBe(f.initialChanges + 1)
 f.destination.view.dispatch(f.destination.state.tr.insertText('Typing ', 1).setMeta('addToHistory', false))
 expect(f.changes()).toBe(f.initialChanges + 1)
 f.destination.commands.undo()
 expect(f.decorations()).toHaveLength(0)
 expect(f.changes()).toBe(f.initialChanges + 2)
 expect(Object.keys(useAppStore.getState().documents)).toHaveLength(2)
})
it('checks an unanchored original locator, clears on final promotion, and rejects wrong note identity', () => {
 const f = fixture(true)
 f.destination.commands.insertContentAt(f.destination.state.doc.content.size, { type: 'noteInclude', attrs: f.attrs })
 expect(f.decorations()).toHaveLength(4)
 expect(notePendingSourceDecorations(sourceKey, 'different-note', f.source.state.doc)).toEqual([])
 f.source.commands.insertContentAt(1, 'Changed ')
 expect(f.decorations()).toHaveLength(0)
 f.source.commands.undo()
 expect(f.decorations()).toHaveLength(4)
 clearPendingNoteShares(destinationKey, [f.attrs.referenceId])
 expect(f.decorations()).toEqual([])
})

it('removes just the undone source range when another pending use of the same source survives', () => {
 const f = fixture()
 f.destination.commands.insertContentAt(f.destination.state.doc.content.size, { type: 'noteInclude', attrs: f.attrs })
 const position = f.source.state.doc.content.size - f.source.state.doc.lastChild!.nodeSize
 const copy = copyNoteBlock(f.source, position, { hostId: 'local', workspaceId: 'notes', workspacePath: fixtureRoot, path: 'source.note.md', noteId: 'source' }, {} as never)
 const attrs = stageNoteShare(destinationKey, copy)
 f.destination.chain().command(({ tr }) => { closeHistory(tr); return true }).insertContentAt(f.destination.state.doc.content.size, { type: 'noteInclude', attrs }).run()
 expect(f.decorations()).toHaveLength(5)
 const changes = f.changes()
 f.destination.commands.undo()
 expect(f.changes()).toBe(changes + 1)
 expect(f.decorations()).toHaveLength(4)
})

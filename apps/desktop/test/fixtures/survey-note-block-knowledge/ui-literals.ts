import type { ComponentProps } from 'react'
import { NOTE_SCHEMA, type NoteDocument } from '../../../src/shared/note-document'
import { NoteBlockEditor } from '../../../src/renderer/src/components/NoteBlockEditor'
import { NoteFileView } from '../../../src/renderer/src/components/NoteFileView'
import { NoteFileSurfaceView } from '../../../src/renderer/src/components/NoteFileSurfaceView'
import { noteKnowledge, loadedNoteFiles, resolveNoteBlock, noteBacklinks } from '../../../src/renderer/src/lib/note-knowledge'
const note = { schema: NOTE_SCHEMA, noteId: 'note-literal', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'block-literal' }, content: [{ type: 'text', text: 'Literal content' }] }] } } satisfies NoteDocument
const document = { path: 'literal.note.json', content: JSON.stringify(note), revision: 'confirmed-revision' }
const knowledge = noteKnowledge(loadedNoteFiles({ ['resource\0literal.note.json']: document }), 'partial')
const editor = { note, knowledge, onChange: (_raw: string) => {}, onSave: () => {}, onIssue: (_message: string | null) => {}, onOpen: (_source: typeof knowledge.sources[number], _blockId: string) => {} } satisfies ComponentProps<typeof NoteBlockEditor>
const view = { document, knowledge, onChange: editor.onChange, onSave: editor.onSave, onOpen: editor.onOpen, revealBlock: { noteId: note.noteId, blockId: 'block-literal' }, onRevealed: () => {} } satisfies ComponentProps<typeof NoteFileView>
const caller = { tabId: 'mixed-tab', surface: { kind: 'file', regionId: 'original-region', workspaceId: 'resource', path: document.path } } satisfies ComponentProps<typeof NoteFileSurfaceView>
export const nonemptyUILiterals = { editor, view, caller, resolution: resolveNoteBlock(knowledge, view.revealBlock), backlinks: noteBacklinks(knowledge, view.revealBlock) }

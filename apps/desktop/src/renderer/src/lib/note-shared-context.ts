import type { NoteKnowledge } from './note-knowledge'
import { createContext, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import type { NoteInclude } from '../../../shared/note-document'
export type NoteEditorAttachments = { importFiles(files: readonly File[], editor: Editor): void; pending: boolean }
/** Presentation operations; canonical bytes and writes stay with the original File document. */
export const NoteSharedContext = createContext<{
  knowledge: NoteKnowledge
  occurrence: string
  focusIncludedBlock(include: NoteInclude, blockId: string, focus: boolean, reveal: boolean): boolean
  fileKey: string
  focusedEditor: Editor | null
  focusedAttachments?: NoteEditorAttachments | undefined
  focusEditor(editor: Editor, attachments?: NoteEditorAttachments): void
  renderInclude(include: NoteInclude, remove: () => void, readOnly?: boolean): ReactNode
  copyBlock(editor: Editor, position: number): Promise<void>
  paste(editor: Editor, event: ClipboardEvent): boolean
} | null>(null)

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { NOTE_SCHEMA, readNoteDocument } from '../src/shared/note-document'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'

it('retains unsupported mark source through the actual rich view without a silent rewrite',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const marker='KEEP_UNKNOWN_MARK_SOURCE',raw=JSON.stringify({schema:NOTE_SCHEMA,noteId:'original-note',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'original-block'},content:[{type:'text',text:'Original text',marks:[{type:'bold',unknownSource:marker}]}]}]}})
  const document={path:'original.note.json',content:raw,revision:'original'},host=window.document.createElement('div'),root=createRoot(host),change=vi.fn(),parsed=readNoteDocument(raw)
  window.document.body.append(host)
  try {
    await act(async()=>root.render(<NoteFileView document={document} knowledge={noteKnowledge([{location:{workspaceId:'r',path:document.path},document}])} onChange={change} onSave={()=>{}} onOpen={()=>{}}/>))
    const content=host.querySelector<HTMLElement & {editor:Editor}>('.note-block-content')
    if(content){await act(async()=>content.editor.commands.insertContentAt(1,'Edited '));expect(change).toHaveBeenCalled();expect(change.mock.lastCall![0]).toContain(marker)}
    else{expect(parsed.status).toBe('invalid');expect(change).not.toHaveBeenCalled();expect(host.textContent).toContain('original source is preserved')}
    expect(document.content).toBe(raw)
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()}
})

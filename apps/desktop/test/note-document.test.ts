import { describe, expect, it } from 'vitest'
import { type NoteDocument, newNoteDocument, readNoteDocument, serializeNoteDocument, NOTE_SCHEMA } from '../src/shared/note-document'
describe('canonical Note content schema', () => {
  it('keeps one body identity independent of its name and represents draft line breaks',()=>{
    const note=newNoteDocument('one\ntwo','note-id','block-id')
    expect(note).toEqual({schema:NOTE_SCHEMA,noteId:'note-id',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'block-id'},content:[{type:'text',text:'one'},{type:'hardBreak'},{type:'text',text:'two'}]}]}})
    expect(readNoteDocument(serializeNoteDocument(note))).toEqual({status:'valid',note,unanchoredBlockCount:0})
  })
  it('reads typed reference occurrences and external unanchored blocks, but rejects duplicate IDs without altering raw',()=>{
    const note:NoteDocument={schema:NOTE_SCHEMA,noteId:'a',content:{type:'doc',content:[{type:'blockReference',attrs:{blockId:'b',referenceId:'ref-1',target:{noteId:'target-note',blockId:'target-block'},mode:'embed'}}]}}
    expect(readNoteDocument(serializeNoteDocument(note))).toEqual({status:'valid',note,unanchoredBlockCount:0})
    const header='---\nschema: agentmux.note.md.v1\nnote-id: a\n---\n\n'
    expect(readNoteDocument(header+'External paragraph\n')).toMatchObject({status:'valid',unanchoredBlockCount:1})
    const raw=header+'First ^duplicate\n\nSecond ^duplicate\n', result=readNoteDocument(raw)
    expect(result.status).toBe('invalid');if(result.status==='invalid')expect(result.raw).toBe(raw)
  })
  it.each([
    { type: 'unknownKind', attrs: { blockId: 'b' } },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 42 }] },
    { type: 'paragraph', attrs: { blockId: 'b', unknown: 'keep me' } },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'a', marks: [{ type: 'unknownMark' }] }] },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'a', marks: [{ type: 'bold', unknownSource: 'preserve me' }] }] },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'heading', attrs: { blockId: 'c' } }] }
  ])('refuses to serialize unsupported editor content without repairing it: %j', node => {
    const note={schema:NOTE_SCHEMA,noteId:'n',content:{type:'doc',content:[node]}},original=JSON.stringify(note)
    expect(()=>serializeNoteDocument(note as never)).toThrow()
    expect(JSON.stringify(note)).toBe(original)
  })
})

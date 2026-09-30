import { describe, expect, it } from 'vitest'
import { newNoteDocument, readNoteDocument, NOTE_SCHEMA } from '../src/shared/note-document'
describe('canonical Note content schema', () => {
  it('keeps one body identity independent of its name and represents draft line breaks',()=>{
    const note=newNoteDocument('one\ntwo','note-id','block-id')
    expect(note).toEqual({schema:NOTE_SCHEMA,noteId:'note-id',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'block-id'},content:[{type:'text',text:'one'},{type:'hardBreak'},{type:'text',text:'two'}]}]}})
    expect(readNoteDocument(JSON.stringify(note))).toEqual({status:'valid',note})
  })
  it('reads typed reference occurrence and rejects duplicate or missing IDs without altering raw',()=>{
    const note={schema:NOTE_SCHEMA,noteId:'a',content:{type:'doc',content:[{type:'blockReference',attrs:{blockId:'b',referenceId:'ref-1',target:{noteId:'target-note',blockId:'target-block'},mode:'embed'}}]}}
    expect(readNoteDocument(JSON.stringify(note))).toEqual({status:'valid',note})
    for(const content of [[{type:'paragraph'}],[{type:'paragraph',attrs:{blockId:'b'}},{type:'paragraph',attrs:{blockId:'b'}}]]){
      const raw=JSON.stringify({...note,content:{type:'doc',content}}), result=readNoteDocument(raw)
      expect(result.status).toBe('invalid');if(result.status==='invalid')expect(result.raw).toBe(raw)
    }
  })
  it.each([
    { type: 'unknownKind', attrs: { blockId: 'b' } },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 42 }] },
    { type: 'paragraph', attrs: { blockId: 'b', unknown: 'keep me' } },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'a', marks: [{ type: 'unknownMark' }] }] },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: 'a', marks: [{ type: 'bold', unknownSource: 'preserve me' }] }] },
    { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'heading', attrs: { blockId: 'c' } }] }
  ])('retains raw unsupported editor content without repairing it: %j', node => {
    const raw = JSON.stringify({ schema: NOTE_SCHEMA, noteId: 'n', content: { type: 'doc', content: [node] } })
    const result = readNoteDocument(raw)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') { expect(result.raw).toBe(raw); expect(result.message.length).toBeGreaterThan(0) }
  })
})

import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { describe, expect, it } from 'vitest'
import { readNoteMarkdownHeader, rewriteNoteMarkdownTitle } from '../src/note-format.js'
import { noteTitleEventId, noteTitleIntentFingerprint, parseNoteFileTitle, parseNoteTitleIntent, parseNoteTitleOperation, parseNoteTitleProjection } from '../src/note-title.js'
import { parseFileWriteResult } from '../src/public-rpc-files.js'
import { noteHistoryRevision } from '../src/note-history.js'

const resource = { hostId:'host',workspaceId:'notes',workspacePath:_historyFixturePath("private/notes"),path:'original.note.md' }
const intent = { operationId:'rename-B',noteId:'note',resource,title:'B',actor:{kind:'agent' as const,id:'agent'} }
const revision = noteHistoryRevision('original body')
describe('original file title contracts',()=>{
  it('keeps every original body character and Note identity through a header-only edit, including BOM/CRLF and unanchored content',()=>{
    for(const newline of ['\n','\r\n']) for(const bom of ['', '\uFEFF']){
      const body=newline+'# No ID heading'+newline+'Paragraph [[Editable target]] without an anchor.  '+newline+'<custom untouched="yes">'+newline
      const raw=bom+'---'+newline+'schema: agentmux.note.md.v1'+newline+'note-id: "note"'+newline+'title: A'+newline+'---'+newline+body
      const next=rewriteNoteMarkdownTitle(raw,'新标题: B'),parsed=readNoteMarkdownHeader(next)
      expect(parsed.status).toBe('valid')
      if(parsed.status==='valid'){expect(parsed.body).toBe(body);expect(parsed.noteId).toBe('note');expect(parsed.title).toBe('新标题: B')}
      expect(next.startsWith(bom+'---'+newline)).toBe(true)
      expect(next).not.toContain('^')
    }
    expect(()=>rewriteNoteMarkdownTitle('not a Note','B')).toThrow()
    expect(()=>rewriteNoteMarkdownTitle('---\nschema: agentmux.note.md.v1\nnote-id: note\n---\nbody','\nB')).toThrow()
  })
  it('isolates title event identity/fingerprint and freezes caller-owned intent before awaits',()=>{
    const original=structuredClone(intent),parsed=parseNoteTitleIntent(original)
    original.title='later';original.resource.path='later.note.md'
    expect(parsed).toEqual(intent);expect(noteTitleEventId('rename-B')).not.toBe('rename-B')
    expect(noteTitleIntentFingerprint(intent)).not.toBe(noteTitleIntentFingerprint({...intent,title:'C'}))
    expect(noteTitleEventId('rename-B')).toBe(noteTitleEventId('rename-B'))
  })
  it('rejects array/object/boolean enum lookalikes, invalid digests and mutually exclusive receipt fields',()=>{
    const read={status:'read',noteId:'note',resource,title:'B',revision}
    const record={status:'recorded',intent,resource,revision,history:{status:'committed',eventId:noteTitleEventId(intent.operationId),batchId:'batch'}}
    for(const value of [['agent'],{toString:()=> 'agent'},true])expect(()=>parseNoteTitleIntent({...intent,actor:{...intent.actor,kind:value}})).toThrow()
    for(const status of [['unknown'],['read'],true])expect(()=>parseNoteFileTitle({...read,status})).toThrow()
    for(const status of [['committed'],['prepared'],true])expect(()=>parseNoteTitleOperation({...record,history:{...record.history,status}},intent.operationId)).toThrow()
    for(const code of [['host-unavailable'],{},true])expect(()=>parseNoteTitleProjection({status:'unconfirmed',noteId:'note',resource,code,message:'unavailable'})).toThrow()
    expect(()=>parseNoteFileTitle({...read,revision:'nonempty-but-not-digest'})).toThrow()
    expect(()=>parseNoteTitleOperation({...record,revision:'wrong'},intent.operationId)).toThrow()
    expect(()=>parseNoteTitleOperation({...record,history:{...record.history,reason:'cannot be committed and unknown'}},intent.operationId)).toThrow()
    expect(()=>parseNoteTitleOperation({...record,history:{...record.history,status:'prepared',replayed:true}},intent.operationId)).toThrow()
    expect(()=>parseNoteFileTitle({...read,reason:'cannot be both read and unknown'})).toThrow()
    expect(parseNoteTitleOperation(record,intent.operationId)).toEqual(record)
  })
})

it('binds written title projections to the canonical Note and exact original resource while keeping their revision independent',()=>{
  const file={...resource,zoneId:'zone',zonePath:resource.workspacePath},content='---\nschema: agentmux.note.md.v1\nnote-id: note\ntitle: B\n---\nBody\n'
  const params={zoneId:'zone',path:resource.path,expectedResource:file,content,expectedRevision:revision}
  const projection={status:'projected',noteId:'note',resource,title:'C',revision:noteHistoryRevision('later C'),catalogRevision:3}
  const result={status:'written',revision:noteHistoryRevision(content),content,noteTitleProjection:projection}
  expect(parseFileWriteResult({resource:file,result},params)).toEqual({resource:file,result})
  expect(()=>parseFileWriteResult({resource:file,result:{...result,noteTitleProjection:{...projection,noteId:'other-note'}}},params)).toThrow('Note identity')
  expect(()=>parseFileWriteResult({resource:file,result:{...result,noteTitleProjection:{...projection,resource:{...resource,path:'other.note.md'}}}},params)).toThrow('file write')

})

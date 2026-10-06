// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import type { ExecutionHost } from '@agentmux/core'
import { readLegacyNoteDocument } from '@agentmux/client-ui/note/note-legacy-document'
import { newNoteDocument, readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { parseNoteContentObservation, parseNotebookGraph } from '@agentmux/core/notebook-observation'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { workspaceFileFormat } from '../src/shared/workspace-file-format'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const canonical = (note: NoteDocument) => {
  const content = noteContentSchema.nodeFromJSON(note.content).toJSON()
  const visit = (node: typeof content) => { if(node.attrs) delete node.attrs.provenance; node.content?.forEach(visit) }; visit(content)
  return content
}
async function originalFiles() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-md-original-')))
  const workspace = { id:'md-workspace',hostId:'local',path,name:'Original Markdown',kind:'folder' as const }
  const files = new WorkspaceFiles(() => ({ id:'local',kind:'local' } as ExecutionHost)), state = emptyNotebookState()
  state.notebooks.book = { notebookId:'book',name:'Original book',createdAt:_newTailFixtureEpoch(0, 0, 1) }
  const owner = new NotebookObservationOwner({ workspace: id => id===workspace.id?workspace:undefined,files })
  const writer = new NoteFileWriter(files,{ state: async()=>state,owner })
  const register = (noteId:string,title:string,file:string) => {
    const page:NotebookPage = {noteId,title,notebookId:'book',parentNoteId:null,resource:{hostId:'local',workspaceId:workspace.id,workspacePath:path,path:file},sources:[],topics:[],createdAt:_newTailFixtureEpoch(0, 0, 1),updatedAt:_newTailFixtureEpoch(0, 0, 1)}
    state.pages[noteId]=page
  }
  return {path,workspace,files,state,owner,writer,register,async dispose(){await files.dispose();await rm(path,{recursive:true,force:true})}}
}
it('roundtrips the complete original legacy schema through readable Markdown and the original rich Reader', async()=>{
  const old = readLegacyNoteDocument(await readFile(join(process.cwd(),'apps/desktop/test/fixtures/note-markdown-rich-legacy.json'),'utf8'))
  expect(old.status).toBe('valid'); if(old.status!=='valid')throw Error(old.message)
  const source = serializeNoteDocument(old.note), read = readNoteDocument(source)
  expect(source).toContain('schema: agentmux.note.md.v1');expect(source).toContain('::note-embed');expect(source).not.toContain('"content":');expect(source).not.toContain('original-person')
  expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
  expect(read.note.noteId).toBe(old.note.noteId);expect(read.unanchoredBlockCount).toBe(0);expect(canonical(read.note)).toEqual(canonical(old.note))
  expect(readNoteDocument(JSON.stringify(old.note)).status).toBe('invalid')
  const target = newNoteDocument('Actual referenced target ', 'original-target', 'target block/#%--中文')
  target.content.content![0]!.content!.push({type:'text',text:'rich content',marks:[{type:'bold'}]})
  await dom.render(<NoteReader content={source} path="rich.note.md" workspaceId="workspace" revision="saved-md" documents={[{location:{workspaceId:'workspace',path:'target.note.md'},document:{path:'target.note.md',revision:'target-revision',content:serializeNoteDocument(target)}}]} />)
  expect(dom.container.textContent).toContain('Actual referenced target rich content')
  expect(dom.container.querySelector('ol')?.getAttribute('start')).toBe('7')
  expect(dom.container.querySelector('[data-block-id="ordered-first--paragraph"]')?.textContent).toContain('first paragraph')
  expect(dom.container.querySelector('u')?.textContent).toBe('underline < & >')
  expect(dom.container.querySelector('a.original-class')?.getAttribute('target')).toBe('_self')
  expect(workspaceFileFormat('rich.note.md')).toMatchObject({sourcePreview:'note',language:'markdown',mime:'text/markdown'})
  expect(workspaceFileFormat('ordinary.md').sourcePreview).toBe('markdown')
})
it('reads unanchored external Markdown as partial, never borrows an ancestor identity, and allocates stable IDs only in the original CAS write', async()=>{
  const f=await originalFiles()
  try {
    const raw='---\nschema: agentmux.note.md.v1\nnote-id: source\n---\n\n> Newly added [[Target]]\n\n^parent\n\n## Same\n\n## Same ^anchored\n'
    await writeFile(join(f.path,'source.note.md'),raw)
    await writeFile(join(f.path,'target.note.md'),serializeNoteDocument(newNoteDocument('Original target','target','target-block')))
    f.register('source','Source','source.note.md');f.register('target','Target','target.note.md')
    const original=await f.files.read(f.workspace,'source.note.md');expect(original.status).toBe('read');if(original.status!=='read')throw Error('Original not read')
    const read=readNoteDocument(raw);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
    expect(read.unanchoredBlockCount).toBe(2)
    const graph=await f.owner.graph(f.state,{})
    expect(graph.completeness).toBe('partial');expect(graph.references).toEqual([])
    expect(parseNotebookGraph(graph,{})).toBe(graph)
    expect(()=>parseNotebookGraph({...graph,completeness:'complete'},{})).toThrow()
    const observation=await f.owner.content(f.state,'source');expect(observation).toMatchObject({status:'read',unanchoredBlockCount:2})
    expect(parseNoteContentObservation(observation)).toEqual(observation)
    const byHeading=await f.owner.resolve(f.state,{mode:'resolve',text:'Source #Same'})
    expect(byHeading.mode==='resolve'&&byHeading.result.status).toBe('unknown')
    const exact=await f.owner.resolve(f.state,{mode:'resolve',text:'Source #^anchored'})
    expect(exact.mode==='resolve'&&exact.result).toMatchObject({status:'resolved',target:{noteId:'source',blockId:'anchored'}})
    expect(await readFile(join(f.path,'source.note.md'),'utf8')).toBe(raw)
    const saved=await f.writer.write(f.workspace,{path:'source.note.md',content:raw,expectedRevision:original.document.revision},{actor:{kind:'agent',id:'test-author'}})
    expect(saved.status).toBe('written');if(saved.status!=='written')throw Error('Not written')
    const bytes=await readFile(join(f.path,'source.note.md'),'utf8'), after=readNoteDocument(bytes)
    expect(after.status).toBe('valid');if(after.status!=='valid')throw Error(after.message)
    expect(after.unanchoredBlockCount).toBe(0);expect(bytes).toBe(saved.content??raw)
    const again=await f.owner.graph(f.state,{})
    expect(again.references).toEqual([expect.objectContaining({source:expect.objectContaining({noteId:'source'}),target:{kind:'page',noteId:'target'},mode:'link',resolution:'resolved'})])
    expect(again.references[0]!.source.blockId).not.toBe('parent')
    const second=await f.writer.write(f.workspace,{path:'source.note.md',content:bytes,expectedRevision:saved.revision},{actor:{kind:'user',id:'person'}})
    expect(second.status).toBe('written');expect(await readFile(join(f.path,'source.note.md'),'utf8')).toBe(bytes)
    const conflict=await f.writer.write(f.workspace,{path:'source.note.md',content:raw+'Later\n',expectedRevision:original.document.revision})
    expect(conflict.status).toBe('conflict')
  } finally { await f.dispose() }
})
it('mounts an unanchored original editor without minting or dirtying and writes later rich input as canonical Markdown',async()=>{
  const f=await originalFiles()
  try {
    const raw='---\nschema: agentmux.note.md.v1\nnote-id: editor\n---\n\nExternal plain paragraph [[Target]]\n'
    await writeFile(join(f.path,'editor.note.md'),raw)
    const read=readNoteDocument(raw);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
    const onChange=vi.fn(),issue=vi.fn()
    await dom.render(<NoteBlockEditor note={read.note} knowledge={noteKnowledge([])} onChange={onChange} onIssue={issue} onSave={()=>{}} onOpen={()=>{}} />)
    await act(async()=>{})
    const editor=(dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor
    expect(onChange).not.toHaveBeenCalled();expect(editor.getJSON().content?.[0]?.attrs?.blockId).toBeNull()
    expect(editor.getJSON().content?.[0]?.content).toEqual([{type:'text',text:'External plain paragraph [[Target]]'}])
    await act(async()=>editor.commands.insertContentAt(1,'Changed '))
    expect(onChange).toHaveBeenCalled()
    const edited=onChange.mock.lastCall?.[0] as string
    expect(edited).toContain('schema: agentmux.note.md.v1');expect(edited).toContain('Changed External plain paragraph')
    const original=await f.files.read(f.workspace,'editor.note.md');if(original.status!=='read')throw Error('Not read')
    const result=await f.writer.write(f.workspace,{path:'editor.note.md',content:edited,expectedRevision:original.document.revision})
    expect(result.status).toBe('written')
    const bytes=await readFile(join(f.path,'editor.note.md'),'utf8'), confirmed=readNoteDocument(bytes)
    expect(confirmed.status).toBe('valid');if(confirmed.status!=='valid')throw Error(confirmed.message)
    expect(confirmed.unanchoredBlockCount).toBe(0);expect(confirmed.note.content.content![0]!.attrs?.blockId).toEqual(expect.any(String))
    expect(await readFile(join(f.path,'editor.note.md'),'utf8')).not.toContain('"content":')
  }finally{await f.dispose()}
})
it('preserves original bytes and refuses guessed identities for duplicate markers, unsupported Markdown and orphan occurrence markers',()=>{
  const header='---\nschema: agentmux.note.md.v1\nnote-id: exact\n---\n\n'
  for(const body of ['First ^duplicate\n\nSecond ^duplicate','![image](https://example.test/image.png)','<!--amux-ref:orphan-->','^orphan']) {
    const raw=header+body, read=readNoteDocument(raw);expect(read).toMatchObject({status:'invalid',raw})
  }
})

it('assigns a new occurrence identity on author paste without changing the original block or target',async()=>{
  const note=newNoteDocument('Original ', 'paste', 'retained-block'), onChange=vi.fn(), issue=vi.fn()
  await dom.render(<NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={onChange} onIssue={issue} onSave={()=>{}} onOpen={()=>{}} />)
  const editor=(dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor
  expect(onChange).not.toHaveBeenCalled()
  await expect(act(async()=>{editor.commands.insertContentAt(10,{type:'noteLink',attrs:{referenceId:null,text:'Original target',target:{noteId:'target',blockId:'exact'}}})})).resolves.toBeUndefined()
  expect(onChange).toHaveBeenCalled()
  const read=readNoteDocument(onChange.mock.lastCall![0]);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
  expect(read.note.content.content![0]!.attrs?.blockId).toBe('retained-block')
  expect(read.note.content.content![0]!.content!.find(node=>node.type==='noteLink')).toMatchObject({attrs:{referenceId:expect.any(String),target:{noteId:'target',blockId:'exact'}}})
  expect(issue).toHaveBeenLastCalledWith(null)
})

it.each(['  leading and trailing  ', 'soft newline  \n  stays text', ' ', 'bold whitespace', 'query'])('preserves exact whitespace and inline query characters (%s)',text=>{
 const note=newNoteDocument(text,'characters','exact-block')
 if(text==='bold whitespace')note.content.content![0]!.content=[{type:'text',text:' marked ',marks:[{type:'bold'},{type:'italic'}]}]
 if(text==='query')note.content.content![0]!.content=[{type:'noteLink',attrs:{referenceId:'query-id',text:'Page \\# literal *stars*',target:null}}]
 const bytes=serializeNoteDocument(note),read=readNoteDocument(bytes)
 expect(read.status,bytes+(read.status==='invalid'?read.message:'')).toBe('valid');if(read.status!=='valid')throw Error(read.message)
 expect(canonical(read.note)).toEqual(canonical(note))
})
it('preserves nondefault scalar fields without hiding a content tree',()=>{
 const note=newNoteDocument('Rare values','fields','field-block')
 note.content.content!.push({type:'heading',attrs:{blockId:'level7',level:7},content:[{type:'text',text:'Seven'}]}, {type:'codeBlock',attrs:{blockId:'language',language:'custom language\n'},content:[{type:'text',text:'a\n\n'}]}, {type:'orderedList',attrs:{start:-2,type:''},content:[{type:'listItem',attrs:{blockId:'item'},content:[{type:'paragraph',attrs:{blockId:'item-para'}}]}]})
 const bytes=serializeNoteDocument(note),read=readNoteDocument(bytes)
 expect(read.status,bytes+(read.status==='invalid'?read.message:'')).toBe('valid');if(read.status!=='valid')throw Error(read.message)
 expect(canonical(read.note)).toEqual(canonical(note))
})

it.each([['blank line','one\n\ntwo'],['leading LF','\nleading'],['trailing LF','trailing\n'],['CRLF','one\r\ntwo']])('preserves original text line characters and its single block identity (%s)',(_label,text)=>{
 for(const marks of [undefined,[{type:'code'}]]) {
  const note=newNoteDocument('Base','lines','same-original-block')
  note.content.content![0]!.content=[{type:'text',text,...marks?{marks}:{}}]
  const bytes=serializeNoteDocument(note),read=readNoteDocument(bytes)
  expect(read.status,bytes+(read.status==='invalid'?read.message:'')).toBe('valid');if(read.status!=='valid')throw Error(read.message)
  expect(canonical(read.note)).toEqual(canonical(note));expect(read.unanchoredBlockCount).toBe(0)
 }
})

it('keeps explicitly escaped Markdown wiki text literal while observing its unescaped neighbor',()=>{
 const raw='---\nschema: agentmux.note.md.v1\nnote-id: literal\n---\n\n\\[[Target]] and [[Target]] ^block\n'
 const read=readNoteDocument(raw);expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
 const knowledge=noteKnowledge([{location:{workspaceId:'workspace',path:'literal.note.md'},document:{path:'literal.note.md',content:raw,revision:'original-revision'}}])
 expect(knowledge.references).toHaveLength(1)
 expect(read.note.content.content![0]!.content![0]).toMatchObject({type:'text',text:'[[Target]]',marks:[{type:'noteWikiLiteral'}]})
 const again=readNoteDocument(serializeNoteDocument(read.note));expect(again.status).toBe('valid');if(again.status!=='valid')throw Error(again.message)
 expect(canonical(again.note)).toEqual(canonical(read.note))
})

it('creates a new Note through the original Store intent and original file writer as Markdown with the retained IDs',async()=>{
 const f=await originalFiles(), before=useAppStore.getState(), launchers=useLauncherState.getState()
 try {
  const tab=createWorkbenchTab('md-launcher',{regionId:'md-region',kind:'launcher',workspaceId:f.workspace.id})
  useLauncherState.setState({drafts:{}})
  useAppStore.setState({config:{...composerConfig,workspaces:[f.workspace]},mainSurface:'workbench',activeWorkspaceId:f.workspace.id,tabs:{[tab.id]:tab},layouts:{[f.workspace.id]:createWorkspaceLayout('md-group',[tab.id])},documents:{},spaceZoneBindings:{},workspaceFileRevisions:{},openFile:async()=>true})
  vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>f.writer.write(f.workspace,input))
  const receipt=await useAppStore.getState().createNote('md-group',{tabId:tab.id,regionId:'md-region'},'A new original note')
  expect(receipt.status).toBe('written');expect(receipt.path).toMatch(/\.note\.md$/)
  const bytes=await readFile(join(f.path,receipt.path),'utf8'),read=readNoteDocument(bytes)
  expect(read.status).toBe('valid');if(read.status!=='valid')throw Error(read.message)
  expect(bytes).toContain('A new original note');expect(read.note.noteId).toBe(receipt.noteId);expect(read.note.content.content![0]!.attrs?.blockId).toBe(receipt.blockIds[0])
 }finally {useAppStore.setState(before,true);useLauncherState.setState(launchers,true);await f.dispose()}
})
it('keeps shared rich input and undo alive when actual pasted reference cannot be serialized',async()=>{
  const content=serializeNoteDocument(newNoteDocument('Original shared text','shared-paste','shared-block')),draft=vi.fn(),save=vi.fn()
  await dom.render(<NoteReader content={content} path="shared.note.md" workspaceId="workspace" revision="shared-original" editing={{onDraft:draft,save,readCurrent:vi.fn()}} />)
  await act(async()=> [...dom.container.querySelectorAll('button')].find(button=>button.textContent==='编辑原笔记')!.click())
  draft.mockClear()
  const editor=(dom.container.querySelector('.mobile-note-body[contenteditable="true"]') as HTMLElement&{editor:Editor}).editor
  const original=editor.getJSON(),transfer=new DataTransfer()
  transfer.setData('text/html','<div data-note-block-reference="" data-note-target="broken-json" data-note-reference-mode="reference"></div>')
  transfer.setData('text/plain','Unconfirmed reference')
  await expect(act(async()=>{editor.view.focus();editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.view.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}))})).resolves.toBeUndefined()
  expect(dom.container.querySelector('.mobile-note-body[contenteditable="true"]')).not.toBeNull()
  expect(dom.container.textContent).toContain('本次输入尚未保存');expect(dom.container.textContent).toContain('引用目标尚未确认')
  expect(draft).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
  await act(async()=>editor.commands.undo())
  expect(editor.getJSON()).toEqual(original);expect(dom.container.textContent).not.toContain('本次输入尚未保存')
  await act(async()=>editor.commands.insertContent('Continuing '))
  expect(draft).toHaveBeenCalled();const next=readNoteDocument(draft.mock.lastCall![0].draft)
  expect(next.status).toBe('valid');expect(editor.state.doc.textContent).toContain('Continuing ')
})

it('keeps the current middle unanchored caret when the original writer allocates its durable ID',async()=>{
  const f=await originalFiles()
  try {
    const note=newNoteDocument('First original','middle-caret','first-block')
    note.content.content!.push({type:'paragraph',attrs:{blockId:null},content:[{type:'text',text:'New middle'}]},{type:'paragraph',attrs:{blockId:'last-block'},content:[{type:'text',text:'Last original'}]})
    const content=serializeNoteDocument(note)
    await writeFile(join(f.path,'caret.note.md'),content)
    const callbacks={knowledge:noteKnowledge([]),onChange:vi.fn(),onSave:vi.fn(),onOpen:vi.fn(),onIssue:vi.fn()}
    await dom.render(<NoteBlockEditor {...callbacks} note={note} />)
    const editor=(dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor
    let middle=0;editor.state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&node.attrs.blockId===null)middle=pos})
    await act(async()=>{editor.view.focus();editor.commands.setTextSelection(middle+4)})
    expect(editor.state.selection.$from.parentOffset).toBe(3)
    const read=await f.files.read(f.workspace,'caret.note.md');if(read.status!=='read')throw Error('Original not read')
    const saved=await f.writer.write(f.workspace,{path:'caret.note.md',content,expectedRevision:read.document.revision})
    expect(saved.status).toBe('written');if(saved.status!=='written')throw Error('Writer did not save')
    const canonical=readNoteDocument(saved.content??content);if(canonical.status!=='valid')throw Error(canonical.message)
    const middleId=canonical.note.content.content![1]!.attrs!.blockId;expect(middleId).toEqual(expect.any(String))
    await dom.render(<NoteBlockEditor {...callbacks} note={canonical.note} />)
    expect((dom.container.querySelector('.note-block-content') as HTMLElement&{editor:Editor}).editor).toBe(editor)
    expect(editor.state.selection.$from.parent.attrs.blockId).toBe(middleId);expect(editor.state.selection.$from.parentOffset).toBe(3)
    await act(async()=>editor.commands.insertContent(' continuing '))
    expect(editor.state.selection.$from.parent.textContent).toBe('New continuing  middle')
    expect(editor.state.selection.$from.parent.attrs.blockId).toBe(middleId)
  } finally {await f.dispose()}
})

// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch, fixturePath as _newTailFixturePath } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { fileUploadRevision } from '@agentmux/core/files'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const revision=(content:string)=>fileUploadRevision(new TextEncoder().encode(content))
it('consumes recorded authorship from the actual shared editor canonical save receipt without a refresh',async()=>{
 const content=serializeNoteDocument(newNoteDocument('Original body','review-shared','review-block'))
 const resource={hostId:'local',workspaceId:'workspace',workspacePath:_newTailFixturePath("original"),path:'shared.note.md'}
 const old={actor:{kind:'agent' as const,id:'old-agent'},at:_newTailFixtureEpoch(0, 0, 1)},fresh={actor:{kind:'agent' as const,id:'fresh-agent'},at:_newTailFixtureEpoch(0, 0, 2)}
 const noteProvenance={status:'recorded' as const,noteId:'review-shared',resource,revision:revision(content),blocks:{'review-block':{created:old,lastEdited:old}}}
 let latest=content
 const save=vi.fn(async(sent:string)=>({status:'written' as const,revision:revision(sent),content:sent,noteProvenance:{...noteProvenance,revision:revision(sent),blocks:{'review-block':{created:old,lastEdited:fresh}}}}))
 await dom.render(<NoteReader content={content} path={resource.path} workspaceId={resource.workspaceId} revision={revision(content)} noteProvenance={noteProvenance} editing={{onDraft:value=>{latest=value.draft},save,readCurrent:vi.fn()}} />)
 await act(async()=>[...dom.container.querySelectorAll('button')].find(b=>b.textContent==='编辑原笔记')!.click())
 const editor=(dom.container.querySelector('.mobile-note-body[contenteditable="true"]') as HTMLElement&{editor:Editor}).editor
 await act(async()=>{editor.view.focus();editor.commands.insertContent('Changed ')})
 expect(latest).not.toBe(content)
 await act(async()=>{[...dom.container.querySelectorAll('button')].find(b=>b.textContent==='保存原笔记')!.click();await new Promise(r=>setTimeout(r,0))})
 expect(save).toHaveBeenCalledOnce()
 expect([...dom.container.querySelectorAll('[title]')].map(el=>el.getAttribute('title')).join('\n')).toContain('Last edited: Agent fresh-agent')
})

it('keeps later draft bytes and leaves their latest author unknown after an earlier save is acknowledged',async()=>{
 const content=serializeNoteDocument(newNoteDocument('Original body','review-later','review-block'))
 const resource={hostId:'local',workspaceId:'workspace',workspacePath:_newTailFixturePath("original"),path:'shared.note.md'}
 const old={actor:{kind:'agent' as const,id:'old-agent'},at:_newTailFixtureEpoch(0, 0, 1)},fresh={actor:{kind:'agent' as const,id:'saved-agent'},at:_newTailFixtureEpoch(0, 0, 2)}
 const noteProvenance={status:'recorded' as const,noteId:'review-later',resource,revision:revision(content),blocks:{'review-block':{created:old,lastEdited:old}}}
 let latest=content,sent='',release!:()=>void
 const save=vi.fn((value:string)=>{sent=value;return new Promise<any>(resolve=>{release=()=>resolve({status:'written',content:value,revision:revision(value),noteProvenance:{...noteProvenance,revision:revision(value),blocks:{'review-block':{created:old,lastEdited:fresh}}}})})})
 await dom.render(<NoteReader content={content} path={resource.path} workspaceId={resource.workspaceId} revision={revision(content)} noteProvenance={noteProvenance} editing={{onDraft:value=>{latest=value.draft},save,readCurrent:vi.fn()}} />)
 await act(async()=>[...dom.container.querySelectorAll('button')].find(b=>b.textContent==='编辑原笔记')!.click())
 const editor=(dom.container.querySelector('.mobile-note-body[contenteditable="true"]') as HTMLElement&{editor:Editor}).editor
 await act(async()=>{editor.view.focus();editor.commands.insertContent('Saved edit ');[...dom.container.querySelectorAll('button')].find(b=>b.textContent==='保存原笔记')!.click()})
 expect(save).toHaveBeenCalledOnce()
 await act(async()=>{editor.commands.insertContent('LATER UNSAVED ')});const later=latest
 expect(later).not.toBe(sent)
 await act(async()=>{release();await Promise.resolve()})
 expect(latest).toBe(later);expect(dom.container.textContent).toContain('LATER UNSAVED')
 const titles=[...dom.container.querySelectorAll('[title]')].map(el=>el.getAttribute('title')).join('\n')
 expect(titles).toContain('Created: Agent old-agent');expect(titles).toContain('Last edited: Unknown');expect(titles).not.toContain('Last edited: Agent saved-agent')
})

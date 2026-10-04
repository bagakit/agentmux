// @vitest-environment happy-dom
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult, AgentSessionHistoryPage } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { ConversationView } from '../src/components/ConversationView'
import { ConversationResourceImage } from '../src/components/ConversationResourceImage'
import { ConversationImage } from '../src/components/ConversationImage'
import { AgentMarkdown } from '../src/components/AgentMarkdown'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
const mounts:{host:HTMLElement,root:Root}[]=[]
const platform:ClientUiPlatform={copyText:async()=>true,overlayContainer:()=>document.body,bindComposerFocus:()=>()=>{},renderMessageAvatar:()=>null,renderProjectIcon:()=>null,renderProjectLabel:()=>null,renderIcon:()=>null}
async function render(content:ReactNode){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);mounts.push({host,root});await act(async()=>root.render(<ClientUiProvider platform={platform}>{content}</ClientUiProvider>));return{host,root}}
afterEach(async()=>{for(const {host,root} of mounts.splice(0)){await act(async()=>root.unmount());host.remove()}window.getSelection()?.removeAllRanges()})
const source={providerId:'codex' as const,nativeSessionId:'native'}
const path=fixturePath("native/device/clipboard.png")
const request:AgentSessionHistoryResourceRequest={source,turnId:'turn',recordId:'record',partIndex:1,expectedReference:path}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg=='
function response(input:AgentSessionHistoryResourceRequest):AgentSessionHistoryResourceReadResult{return{agentSessionId:'session',source:input.source,...(input.turnId?{turnId:input.turnId}:{}),recordId:input.recordId,partIndex:input.partIndex,reference:input.expectedReference,result:{status:'read',mimeType:'image/png',dataBase64:png,byteLength:70}}}
function page(reference=path):AgentSessionHistoryPage{return{agentSessionId:'session',source,nextCursor:null,items:[{id:'record',turnId:'turn',kind:'user-message',contentParts:[{kind:'text',text:'Original **selected** message'},{kind:'resource',resourceType:'image',reference,label:'Screenshot'},{kind:'resource',resourceType:'file',reference:fixturePath("document/report.txt")}]}]}}
it('the actual native ConversationView calls the recorded source/turn/record/part seam and displays the reusable image',async()=>{
 const read=vi.fn(async(input:AgentSessionHistoryResourceRequest)=>response(input));const {host}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={read}/>)
 expect(read).toHaveBeenCalledExactlyOnceWith(request);expect(host.querySelector('.md-conversation-image__thumb')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
 expect(host.textContent).toContain('Original selected message');expect(host.textContent).toContain(fixturePath("document/report.txt"))
 expect(host.querySelectorAll('.md-conversation-image__thumb')).toHaveLength(1)
})
it('the same image enlarges in the existing accessible overlay and closes without another read',async()=>{
 const read=vi.fn(async(input:AgentSessionHistoryResourceRequest)=>response(input));const {host}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={read}/>)
 const trigger=host.querySelector<HTMLButtonElement>('.md-conversation-image');expect(trigger).not.toBeNull()
 await act(async()=>trigger!.click())
 expect(document.querySelector('[role="dialog"] .md-conversation-image__full')).not.toBeNull()
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(document.querySelector('[role="dialog"]')).toBeNull();expect(read).toHaveBeenCalledTimes(1)
})
it('an unavailable or wrong-target resource preserves the exact reference and visible reason',async()=>{
 const unavailable=async(input:AgentSessionHistoryResourceRequest):Promise<AgentSessionHistoryResourceReadResult>=>({...response(input),result:{status:'unavailable',code:'MISSING',message:'Recorded image no longer exists on its source device.'}})
 const {host}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={unavailable}/>)
 expect(host.querySelector('img')).toBeNull();expect(host.textContent).toContain(path);expect(host.querySelector('[role="status"]')?.textContent).toContain('source device')
 const wrong=async(input:AgentSessionHistoryResourceRequest)=>({...response(input),recordId:'another-record'})
 const {host:other}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={wrong}/>)
 expect(other.querySelector('img')).toBeNull();expect(other.textContent).toContain('another recorded resource')
})
it('a late prior source response cannot attach bytes to the current resource',async()=>{
 let resolve!:(value:AgentSessionHistoryResourceReadResult)=>void
 const read=vi.fn((input:AgentSessionHistoryResourceRequest)=>input.source.nativeSessionId==='native'?new Promise<AgentSessionHistoryResourceReadResult>(done=>{resolve=done}):Promise.resolve({...response(input),result:{status:'unavailable' as const,code:'MISSING',message:'Current source has no image.'}}))
 const draw=(nativeSessionId:string)=><ConversationResourceImage part={{kind:'resource',resourceType:'image',reference:path}} partIndex={1} record={{source:{...source,nativeSessionId},recordId:'record',turnId:'turn'}} readResource={read}/>
 const {host,root}=await render(draw('native'));await act(async()=>root.render(<ClientUiProvider platform={platform}>{draw('new-source')}</ClientUiProvider>))
 await act(async()=>resolve(response(request)))
 expect(read).toHaveBeenCalledTimes(2);expect(host.querySelector('img')).toBeNull();expect(host.textContent).toContain('Current source has no image.')
})
it('decode failure retains selected original prose and its DOM, then exposes the resource error',async()=>{
 const read=async(input:AgentSessionHistoryResourceRequest)=>response(input);const {host}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={read}/>)
 const selected=host.querySelector('strong')!,range=document.createRange();range.selectNodeContents(selected);window.getSelection()!.addRange(range)
 const image=host.querySelector('img');expect(image).not.toBeNull()
 await act(async()=>image!.dispatchEvent(new Event('error')))
 expect(host.querySelector('strong')).toBe(selected);expect(window.getSelection()!.toString()).toBe('selected');expect(host.textContent).toContain(path);expect(host.textContent).toContain('could not be decoded')
})
it('pasted markdown references still use their confined reader and the same image face',async()=>{
 const pasted=fixturePath("home/.agentmux/pasted/screenshot.png"),read=vi.fn(async()=>({dataUrl:`data:image/png;base64,${png}`}))
 const {host}=await render(<AgentMarkdown content={`Look @${pasted}`} readPastedImage={read}/>)
 expect(read).toHaveBeenCalledExactlyOnceWith(pasted);expect(host.querySelector('.md-conversation-image__thumb')).not.toBeNull()
})
it('reader replacement immediately removes previous bytes and ignores its late decode event',async()=>{
 const first=async()=>({dataUrl:'data:image/png;base64,first'});let done!:(image:{dataUrl:string})=>void
 const next=()=>new Promise<{dataUrl:string}>(resolve=>{done=resolve});const {host,root}=await render(<ConversationImage text={path} path={path} readImage={first}/>)
 const old=host.querySelector('img')!;expect(old).not.toBeNull()
 await act(async()=>root.render(<ClientUiProvider platform={platform}><ConversationImage text={path} path={path} readImage={next}/></ClientUiProvider>))
 expect(host.querySelector('img')).toBeNull();await act(async()=>old.dispatchEvent(new Event('error')))
 await act(async()=>done({dataUrl:'data:image/png;base64,current'}));expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,current')
})

it('the same recorded image can retry a temporary failure without refreshing or replacing message prose',async()=>{
 let unavailable=true
 const read=vi.fn(async(input:AgentSessionHistoryResourceRequest)=>unavailable?{...response(input),result:{status:'unavailable' as const,code:'OFFLINE',message:'Source is temporarily unavailable.'}}:response(input))
 const {host}=await render(<ConversationView page={page()} sessionId="session" readHistoryResource={read}/>)
 const body=host.querySelector('strong')!,retry=host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]');expect(retry).not.toBeNull()
 unavailable=false;await act(async()=>retry!.click())
 expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls[1]![0]).toEqual(request);expect(host.querySelector('img')).not.toBeNull();expect(host.querySelector('strong')).toBe(body);expect(host.querySelector('[role="status"]')).toBeNull()
})

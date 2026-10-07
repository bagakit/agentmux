import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
const long = 'Original requirement with useful details.\n\n'.repeat(40)
const copy = vi.fn(async () => true), open = vi.fn()
const platform: ClientUiPlatform = {copyText:copy,overlayContainer:()=>document.body,bindComposerFocus:()=>()=>{},renderMessageAvatar:()=>null,renderProjectIcon:()=>null,renderProjectLabel:()=>null,renderIcon:()=>null}
let element: HTMLDivElement, root: Root
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);element=document.createElement('div');document.body.append(element);root=createRoot(element);copy.mockClear();open.mockClear()})
afterEach(async()=>{await act(async()=>root.unmount());element.remove();window.getSelection()?.removeAllRanges();vi.unstubAllGlobals()})
async function render(props: Partial<ConversationMessageProps>={}){await act(async()=>root.render(<ClientUiProvider platform={platform}><ConversationMessage messageId="record-a" speaker={{role:'human',id:'human'}} content={long} openHttpLink={open} {...props}/></ClientUiProvider>))}
function details(){const d=element.querySelector<HTMLDetailsElement>('.message-disclosure');expect(d).not.toBeNull();return d!}
async function toggle(value: boolean){await act(async()=>{const d=details();d.open=value;d.dispatchEvent(new Event('toggle'))})}
it('only folds confirmed human long content, excluding unknown displayed as You',async()=>{
 for(const speaker of [{role:'unknown',id:'unknown'},{role:'agent',id:'agent'},{role:'system',id:'system'}] as const){await render({speaker});expect(element.querySelector('.message-disclosure')).toBeNull()}
 await render({content:'Short original'});expect(element.querySelector('.message-disclosure')).toBeNull()
 await render();expect(details().open).toBe(false);expect(element.querySelector('.log-turn__body')).toBeNull();expect(details().textContent).toContain('Show full message')
 await act(async()=>element.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());expect(copy).toHaveBeenCalledExactlyOnceWith(long,expect.any(Function))
})
it('mounts the same original reader on demand and keeps Range and links on unrelated updates',async()=>{
 const content=long+'[Original source](https://example.test/original)'
 await render({content});expect(element.querySelector('.md-link')).toBeNull();await toggle(true)
 const p=element.querySelector('.md-input p')!, text=p.firstChild!, selection=window.getSelection()!, range=document.createRange();range.setStart(text,0);range.setEnd(text,8);selection.addRange(range)
 await render({content,status:'streaming'});expect(details().open).toBe(true);expect(element.querySelector('.md-input p')).toBe(p);expect(selection.toString()).toBe('Original');expect(selection.anchorNode).toBe(text)
 await act(async()=>element.querySelector<HTMLButtonElement>('.md-link')!.click());expect(open).toHaveBeenCalledWith('https://example.test/original',expect.any(Object))
 await toggle(false);expect(element.querySelector('.log-turn__body')).toBeNull();expect(element.querySelector('.md-link')).toBeNull()
})
it('isolates original record/content including A-B-A and reveals exact located content',async()=>{
 await render();await toggle(true);await render({content:long+' changed'});expect(details().open).toBe(false)
 await render();expect(details().open).toBe(false);await toggle(true);await render({messageId:'record-b'});expect(details().open).toBe(false)
 await render();expect(details().open).toBe(false);await render({located:true});expect(details().open).toBe(true);expect(element.querySelector('.log-turn__body')!.textContent).toBe(long.replaceAll('\n\n',''))
 await render({located:false});expect(details().open).toBe(true)
 await render({conversationSessionId:'another-session'});expect(details().open).toBe(false)
})

it('reveals the original resource reference with the full message and removes hidden descendants when collapsed',async()=>{
 await render({content:[{kind:'text',text:long},{kind:'resource',resourceType:'image',reference:'attachment:original',label:'Original image'}]});expect(element.querySelector('.log-turn__resource')).toBeNull();await toggle(true);expect(element.querySelector('.log-turn__resource code')!.textContent).toBe('attachment:original');await toggle(false);expect(element.querySelector('.log-turn__resource')).toBeNull()
})

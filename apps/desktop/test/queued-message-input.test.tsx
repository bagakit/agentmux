// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {ComposerQueuedMessageEditor} from '../src/renderer/src/components/ComposerQueuedMessageEditor'
import type {ComposerQueuedMessage} from '../src/renderer/src/components/ComposerOutbox'
const entry:ComposerQueuedMessage={id:'original-operation',text:'Original queued text',status:'queued',deliverable:true,editable:true}
let host:HTMLDivElement,root:ReturnType<typeof createRoot>
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()})
const field=()=>host.querySelector<HTMLTextAreaElement>('textarea')!
const save=()=>host.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!
const setDom=(value:string)=>Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field(),value)
const type=async(value:string)=>act(async()=>{setDom(value);field().dispatchEvent(new Event('input',{bubbles:true}))})
const render=async(onSave:Parameters<typeof ComposerQueuedMessageEditor>[0]['onSave'],onCancel=vi.fn(),editable=true)=>act(async()=>root.render(<ComposerQueuedMessageEditor entry={{...entry,editable}} onSave={onSave} onCancel={onCancel}/>))
it('keeps composition preview and IME Escape through unrelated queue eligibility updates',async()=>{
 const write=vi.fn(async()=>{}),cancel=vi.fn();await render(write,cancel);const node=field()
 await act(async()=>{setDom('候选');node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))})
 await render(write,cancel,false);expect(field()).toBe(node);expect(node.value).toBe('候选');expect(save().disabled).toBe(true)
 await act(async()=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true})));expect(cancel).not.toHaveBeenCalled()
 await act(async()=>{setDom('最后的编辑稿');node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))})
 await render(write,cancel);await act(async()=>save().click());expect(write).toHaveBeenCalledExactlyOnceWith(entry.id,entry.text,'最后的编辑稿');expect(cancel).toHaveBeenCalledOnce()
})
it('retains exact draft and refocuses after the original save rejects; a retry keeps expected original text',async()=>{
 let reject!:(error:Error)=>void;const write=vi.fn(()=>new Promise<void>((_,fail)=>{reject=fail})),cancel=vi.fn();await render(write,cancel)
 await type('  Exact edited text\n保留空格  ');await act(async()=>save().click());expect(field().readOnly).toBe(true);expect(save().disabled).toBe(true)
 await act(async()=>reject(new Error('Original operation changed; edit kept.')));expect(field().value).toBe('  Exact edited text\n保留空格  ');expect(field().readOnly).toBe(false);expect(document.activeElement).toBe(field());expect(host.textContent).toContain('Original operation changed');expect(cancel).not.toHaveBeenCalled()
 await act(async()=>save().click());expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);await act(async()=>reject(new Error('Still unconfirmed')))
})

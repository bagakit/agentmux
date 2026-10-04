import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../../../packages/client-ui/src/platform'
import { ConversationMessage } from '../../../packages/client-ui/src/components/ConversationMessage'
import { ConversationMessageAvatar } from '../src/renderer/src/components/ConversationMessageAvatar'
vi.mock('../src/renderer/src/store', () => ({useAppStore:(select: (s:unknown)=>unknown)=>select({config:{profile:{avatar:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><text>User profile</text></svg>'}}})}))
vi.mock('../src/renderer/src/components/ProjectIcon',()=>({ProjectIcon:()=> <span data-project-avatar/>}))
vi.mock('../src/renderer/src/components/SpaceObjectIcon',()=>({SpaceObjectIcon:()=> <span data-mote-avatar/>}))
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
const mounted:{host:HTMLElement,root:Root}[]=[]
const copy=vi.fn(async()=>true)
const platform:ClientUiPlatform={copyText:copy,overlayContainer:()=>document.body,bindComposerFocus:()=>()=>{},
 renderMessageAvatar:input=><ConversationMessageAvatar {...input}/>,renderProjectIcon:()=>null,renderProjectLabel:()=>null,renderIcon:()=>null}
async function render(content:ReactNode){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);mounted.push({host,root});await act(async()=>root.render(<ClientUiProvider platform={platform}>{content}</ClientUiProvider>));return {host,root}}
afterEach(async()=>{for(const {host,root} of mounted.splice(0)){await act(async()=>root.unmount());host.remove()}window.getSelection()?.removeAllRanges();copy.mockClear()})
const unknown={role:'unknown' as const,id:'unknown'}
it('an unverified process declaration uses the real neutral Desktop avatar and preserves recorded identity',async()=>{
 const {host}=await render(<ConversationMessage messageId="process" speaker={unknown} inputSource={{kind:'captured',submissionId:'receipt',channel:'cli',device:{deviceId:'local',name:'本机 Mac'}}} content={'[Message from unverified local process]\nOriginal request'}/>)
 expect(host.querySelector('.log-turn__who')?.textContent).toBe('Message from unverified local process')
 expect(host.querySelector('.conversation-avatar')?.getAttribute('data-speaker-id')).toBe('unknown')
 expect(host.querySelector('.conversation-avatar--unknown')).not.toBeNull()
 expect(host.querySelector('.conversation-avatar img')).toBeNull()
 expect(host.querySelector('.conversation-avatar')?.getAttribute('aria-label')).toBe('unverified local process')
 expect(host.textContent).toContain('CLI · 本机 Mac')
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
 expect(host.textContent).toContain('Not recorded · source declared in message')
 expect(host.textContent).not.toContain('shown as You')
})
it('a textual Agent declaration also remains neutral until Core supplies an authenticated author',async()=>{
 const {host}=await render(<ConversationMessage speaker={unknown} content={'[Message from Agent sender]\nSame request'}/>)
 expect(host.querySelector('.conversation-avatar--unknown')).not.toBeNull()
 expect(host.querySelector('.conversation-avatar--agent')).toBeNull()
 expect(host.querySelector('.conversation-avatar--human')).toBeNull()
 expect(host.querySelector('.log-turn__sender-kind')?.textContent).toBe('Declared source')
})
it('ordinary unknown and verified human still use the local user profile, without parsing code or incomplete declarations',async()=>{
 for(const content of ['Ordinary input','[Message from Agent sender]','```text\n[Message from Agent sender]\nExample\n```','<amux from="amux">Complete context</amux>\n\nActual user input']){
  const {host}=await render(<ConversationMessage speaker={unknown} content={content}/>)
  expect(host.querySelector('.conversation-avatar--human img')).not.toBeNull()
 }
 const {host}=await render(<ConversationMessage speaker={{role:'human',id:'human'}} content={'[Message from Agent sender]\nUser-authored example'}/>)
 expect(host.querySelector('.conversation-avatar--human img')).not.toBeNull()
})
it('a verified peer Agent keeps its own project/Agent identity despite a different declared sender',async()=>{
 const {host}=await render(<ConversationMessage speaker={{role:'agent',id:'verified'}} conversationSessionId="recipient" content={'[Message from Agent other]\nVerified message'} describeSpeaker={()=>({name:'Verified agent',providerId:'codex',project:{workspaceId:'project',name:'Project',path:_hygiene_fixturePath("project")}})}/>)
 expect(host.querySelector('.conversation-avatar--agent')).not.toBeNull()
 expect(host.querySelector('[data-project-avatar]')).not.toBeNull()
 expect(host.querySelector('.conversation-avatar img')).toBeNull()
 expect(host.querySelector('.conversation-avatar')?.getAttribute('data-speaker-id')).toBe('verified')
 expect(host.querySelector('.log-turn__who')?.textContent).toBe('Verified agent')
})
it('status updates retain the original body, selection and full raw Copy for a declared input',async()=>{
 const raw='[Message from unverified local process]\n**Selected text** remains exact.'
 const draw=(status:'complete'|'failed')=><ConversationMessage messageId="same-record" speaker={unknown} content={raw} status={status}/>
 const {host,root}=await render(draw('complete'));const selected=host.querySelector('strong')!,range=document.createRange();range.selectNodeContents(selected);window.getSelection()!.addRange(range)
 await act(async()=>root.render(<ClientUiProvider platform={platform}>{draw('failed')}</ClientUiProvider>))
 expect(host.querySelector('strong')).toBe(selected);expect(window.getSelection()!.toString()).toBe('Selected text')
 await act(async()=>host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
 expect(copy).toHaveBeenCalledWith(raw,expect.any(Function))
})

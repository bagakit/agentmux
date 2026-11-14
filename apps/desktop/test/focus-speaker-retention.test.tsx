// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture } from './helpers/agent-card-conversation-fixture'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
const settle = () => new Promise(done => setTimeout(done, 30))
it('the mounted Focus reader releases an older unrelated Session array while preserving the pinned input', async () => {
 expect(globalThis.gc,'The private test fork must expose GC at startup').toBeTypeOf('function')
 const stackTraceLimit = Error.stackTraceLimit; Error.stackTraceLimit = 0
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now)
 const reader={...composerSession('memory-reader'),createdAt:now-60_000},sender={...composerSession('memory-sender'),label:'Memory speaker',createdAt:now-60_000}
 const timeline={agentSessionId:reader.id,revision:1,items:[{id:'original-input',agentSessionId:reader.id,kind:'user_message' as const,source:'user' as const,status:'complete' as const,createdAt:now-1000,updatedAt:now-1000,title:'Original input',content:'Keep this original pinned input',authorAgentSessionId:sender.id}]}
 vi.spyOn(api.sessions,'historySources').mockResolvedValue({sources:[],warnings:[]})
 vi.spyOn(api.sessions,'timeline').mockResolvedValue(timeline)
 const initial=useAppStore.getState(),observed={collected:false},registry=new FinalizationRegistry(()=>{observed.collected=true})
 let first:object|undefined=[reader,sender,composerSession('unrelated-0')]
 useAppStore.setState({config:composerConfig,sessions:first as never,timelines:{[reader.id]:timeline},agentNames:{},tabs:{},layouts:{},scratchTopicSnapshots:{},spaceObjectIcons:{},agentComposerDrafts:{[reader.id]:'Keep unsent draft'},agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}}})
 vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>({agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'memory-'+control.agentSessionId},items:[],nextCursor:null}))
 vi.spyOn(api.sessions,'observeHistory').mockImplementation(async control=>({agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'memory-'+control.agentSessionId},dispose(){}}))
 await agentCardConversationFixture(control=>({providerId:'codex',nativeSessionId:'memory-'+control.agentSessionId}))
 const contexts=createFocusProjectionSelector()(useAppStore.getState()).contexts
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<RecentFocusTimeline entries={[]} contexts={contexts} currentSessionId={reader.id} onSelect={()=>{}}/>))
  await vi.waitFor(()=>expect(container.querySelector('.recent-focus__message[data-message-author="agent"]')).not.toBeNull(),{timeout:2000})
  await act(async()=>container.querySelector<HTMLElement>('.recent-focus__message[data-message-author="agent"]')!.click())
  await vi.waitFor(()=>expect(document.querySelector('.recent-focus__message-body')).not.toBeNull(),{timeout:2000})
  const body=document.querySelector<HTMLElement>('.recent-focus__message-body')!
  expect(body.textContent).toContain('Keep this original pinned input')
  const text=body.querySelector('p')!.firstChild!,range=document.createRange(),selection=window.getSelection()!
  range.setStart(text,0);range.setEnd(text,4);selection.removeAllRanges();selection.addRange(range)
  registry.register(first!,1);first=undefined
  for(let n=1;n<=4;n++)await act(async()=>useAppStore.setState({sessions:[reader,sender,composerSession(`unrelated-${n}`)]}))
  for(let n=0;n<40&&!observed.collected;n++){globalThis.gc?.();await settle()}
  expect(observed.collected,'Mounted Focus resolver must release an older unrelated Session array').toBe(true)
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(selection.toString()).toBe('Keep')
  await act(async()=>useAppStore.setState({sessions:[reader,{...sender,label:'Updated original speaker'},composerSession('unrelated-final')]}))
  await vi.waitFor(()=>expect(document.querySelector('[data-speaker-id="memory-sender"]')?.getAttribute('aria-label')).toBe('Updated original speaker'))
  expect(document.querySelector('.recent-focus__message-body')).toBe(body)
  expect(selection.toString()).toBe('Keep')
  await act(async()=>document.querySelector<HTMLElement>('.recent-focus__message-body [aria-label="Message details"]')!.click())
  expect(document.querySelector('.conversation-input-details__sender')?.textContent).toContain('Updated original speaker')
  expect(document.querySelector('.conversation-input-details__sender')?.textContent).toContain(sender.id)
  expect(useAppStore.getState().agentComposerDrafts[reader.id]).toBe('Keep unsent draft')
 }finally{await act(async()=>root.unmount());container.remove();window.getSelection()?.removeAllRanges();document.getElementById('agentmux-window-overlay-host')?.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals();Error.stackTraceLimit=stackTraceLimit}
})

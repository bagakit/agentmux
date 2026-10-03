import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionHistoryObservation, AgentTimelineItem } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const initial=useAppStore.getState(),A='hover-a',B='hover-b',C='hover-c',response='Agent reply: original work and selection preserved.'
let root:Root,container:HTMLDivElement,input:HTMLInputElement
let notify:(observation:AgentSessionHistoryObservation)=>void
const card=(id=A)=>{const node=container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`);expect(node).not.toBeNull();return node!}
const panel=()=>document.querySelector<HTMLElement>('.focus-context-hover')
const inputs=()=>[...panel()!.querySelectorAll<HTMLElement>('[data-hover-input-id]')]
const captured=(id:string,content:string,time:number,author:Partial<AgentTimelineItem>={}):AgentTimelineItem=>({id,agentSessionId:A,kind:'user_message',title:'Input',status:'complete',source:'user',content,createdAt:time,updatedAt:time,...author})
const page=(id=A,items:AgentSessionHistoryPage['items']=[]):AgentSessionHistoryPage=>({agentSessionId:id,source:{providerId:'claude',nativeSessionId:'hover-'+id},items,nextCursor:null})
const native=(id:string,text:string,at?:number):AgentSessionHistoryPage['items'][number]=>({id,kind:'user-message',contentParts:[{kind:'text',text}],...(at===undefined?{}:{startedAt:at})})
async function pointer(node:Element,type:'pointerover'|'pointerout',relatedTarget:Element|null=null){await act(async()=>node.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'mouse',relatedTarget})))}
async function open(id=A){await pointer(card(id),'pointerover');await act(async()=>new Promise<void>(resolve=>setTimeout(resolve,200)));await act(async()=>vi.waitFor(()=>expect(panel()).not.toBeNull()))}
async function close(){await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(panel()).toBeNull()}
async function setInputs(items:AgentTimelineItem[]){await act(async()=>useAppStore.setState({timelines:{[A]:{agentSessionId:A,revision:items.length+1,items:[...items,{id:'reply',agentSessionId:A,kind:'assistant_message',title:'Reply',source:'native-hook',status:'complete',content:response,createdAt:50,updatedAt:50}]}}}))}
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const config=await api.config.get(),snapshot=await api.sessions.snapshot(),base=snapshot.sessions.find(s=>s.kind==='agent')!
 const sessions=[A,B,C].map(id=>({...base,id,hostId:'local',workspacePath:_hygiene_fixturePath("hover/repo"),status:{state:'running' as const,source:'run-process' as const,observedAt:Date.now()},control:{...base.control,hostId:'local',agentSessionId:id,run:{runId:id+'-run'}}}))
 useAppStore.setState({...initial,loading:false,config:{...config,workspaces:[{id:'hover-project',hostId:'local',kind:'folder',path:_hygiene_fixturePath("hover/repo"),name:'Hover project'}]},sessions,agentNames:{[A]:'Same name',[B]:'Same name',[C]:'Review Agent'},scratchTopicSnapshots:{},tabs:{},layouts:{},mainSurface:'agents',agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{[A]:'Original draft'},timelines:{}},true)
 vi.spyOn(api.sessions,'observeHistory').mockImplementation(async (control,observer)=>{notify=observer;return {agentSessionId:control.agentSessionId,source:{providerId:'claude',nativeSessionId:'hover-'+control.agentSessionId},dispose:vi.fn()}})
 vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>page(control.agentSessionId))
 container=document.createElement('div');input=document.createElement('input');input.value='Original editable input';document.body.append(container,input);root=createRoot(container)
 await setInputs([]);await act(async()=>root.render(createElement(GlobalFocusSurface)));input.focus();input.setSelectionRange(2,8)
})
afterEach(async()=>{await act(async()=>root.unmount());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));container.remove();input.remove();document.getElementById('agentmux-window-overlay-host')?.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()})
it('reads only after intent and shows the latest three native/captured inputs beside the original reply',async()=>{
 await setInputs([captured('old','Older request',5),captured('human','Manual user request',30,{authorHuman:true}),captured('peer','Agent incoming request',40,{authorAgentSessionId:C})])
 vi.mocked(api.sessions.historyPage).mockImplementation(async control=>page(control.agentSessionId,[native('old-native','Old terminal request',10),native('latest-native','Terminal user request',20)]))
 const original=useAppStore.getState();await pointer(card(),'pointerover');await act(async()=>new Promise(resolve=>setTimeout(resolve,150)));expect(panel()).toBeNull();expect(api.sessions.historyPage).not.toHaveBeenCalled()
 await act(async()=>new Promise(resolve=>setTimeout(resolve,60)));await act(async()=>vi.waitFor(()=>expect(inputs()).toHaveLength(3)))
 expect(inputs().map(n=>n.dataset.hoverInputId)).toEqual(['native:claude:hover-hover-a:latest-native','captured:human','captured:peer'])
 expect(inputs().map(n=>n.dataset.inputAuthor)).toEqual(['unknown','human','agent']);expect(inputs()[2]!.textContent).toContain('Review Agent');expect(inputs()[0]!.textContent).toContain('Native record');expect(inputs()[1]!.textContent).toContain('Submission record')
 expect(panel()!.textContent).toContain(response);expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(original.sessions[0]!.control,{limit:30});expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([2,8]);expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
 const count=vi.mocked(api.sessions.historyPage).mock.calls.length
 await act(async()=>root.render(<GlobalFocusSurface visible={false} />));expect(panel()).toBeNull()
 await act(async()=>notify({kind:'invalidated',agentSessionId:A,source:{providerId:'claude',nativeSessionId:'hover-'+A}}));await act(async()=>new Promise(resolve=>setTimeout(resolve,120)));expect(api.sessions.historyPage).toHaveBeenCalledTimes(count)
 await act(async()=>root.render(<GlobalFocusSurface visible={true} />));expect(panel()).toBeNull();await open();await act(async()=>vi.waitFor(()=>expect(inputs()).toHaveLength(3)));await close()
 const closedCount=vi.mocked(api.sessions.historyPage).mock.calls.length;await act(async()=>new Promise(resolve=>setTimeout(resolve,200)));expect(api.sessions.historyPage).toHaveBeenCalledTimes(closedCount)
})
it('preserves different IDs with identical text and marks missing record time without guessing global order',async()=>{
 await setInputs([captured('same','Same input',90,{authorHuman:true})]);vi.mocked(api.sessions.historyPage).mockResolvedValue(page(A,[native('a','Same input'),native('b','Same input',10)]));await open()
 await act(async()=>vi.waitFor(()=>expect(inputs()).toHaveLength(3)))
 expect(new Set(inputs().map(n=>n.dataset.hoverInputId)).size).toBe(3);expect(inputs().every(n=>n.querySelector('p')!.textContent==='Same input')).toBe(true);expect(inputs()[0]!.dataset.inputAuthor).toBe('unknown');expect(panel()!.textContent).toContain('Order unavailable');expect(panel()!.textContent).toContain('Time unknown');expect(panel()!.textContent).toContain('Current reading window')
})
it('drops a closed reader and isolates a late response from a same-name neighbor and a new Run',async()=>{
 let resolveOld!:(value:AgentSessionHistoryPage)=>void
 vi.mocked(api.sessions.historyPage).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve})).mockImplementation(async control=>page(control.agentSessionId,[native('current','Current '+control.agentSessionId,100)]))
 await open(A);expect(api.sessions.historyPage).toHaveBeenCalledTimes(1);await open(B);await act(async()=>vi.waitFor(()=>expect(panel()!.textContent).toContain('Current '+B)))
 await act(async()=>resolveOld(page(A,[native('late','Old late body',100)])));expect(panel()!.textContent).not.toContain('Old late body');expect(panel()!.textContent).not.toContain('Current '+A);expect(api.sessions.historyPage).not.toHaveBeenCalledWith(expect.objectContaining({agentSessionId:C}),expect.anything())
 await close();await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===A&&session.kind==='agent'?{...session,control:{...session.control,run:{runId:'new-run'}}}:session)})));await open(A)
 await act(async()=>vi.waitFor(()=>expect(api.sessions.historyPage).toHaveBeenLastCalledWith(expect.objectContaining({agentSessionId:A,hostId:'local',run:{runId:'new-run'}}),{limit:30})));expect(panel()!.textContent).not.toContain('Old late body')
 const count=vi.mocked(api.sessions.historyPage).mock.calls.length;await close()
 for(const mismatch of [{hostId:'other-host',agentSessionId:A},{hostId:'local',agentSessionId:B}]){
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===A&&session.kind==='agent'?{...session,control:{...session.control,...mismatch}}:session)})))
  await open(A);expect(panel()!.textContent).toContain('Recent message reading unavailable');expect(api.sessions.historyPage).toHaveBeenCalledTimes(count);expect(card(A).disabled).toBe(false);await close()
 }
})
it('keeps captured requests and the Agent reply readable when native observation and reading fail',async()=>{
 await setInputs([captured('held','Held user request',30,{authorHuman:true})]);vi.mocked(api.sessions.observeHistory).mockRejectedValue(new Error('Observation denied'));vi.mocked(api.sessions.historyPage).mockRejectedValue(new Error('History denied'))
 const stop=vi.spyOn(api.sessions,'stop'),select=useAppStore.getState().agentFocus;await open();await act(async()=>vi.waitFor(()=>expect(panel()!.textContent).toContain('Recent message reading unavailable')))
 expect(panel()!.textContent).toContain('Held user request');expect(panel()!.textContent).toContain(response);expect(panel()!.textContent).toContain('Open the Agent to read History');expect(stop).not.toHaveBeenCalled();expect(useAppStore.getState().agentFocus).toBe(select);expect(card().disabled).toBe(false)
})
it('keeps reply DOM and Range through input arrival and unrelated output without extra reads or focus changes',async()=>{
 vi.mocked(api.sessions.historyPage).mockResolvedValue(page(A,[native('held-native','Original terminal input',10)]))
 const before=useAppStore.getState(),row=card();await open();await act(async()=>vi.waitFor(()=>expect(inputs()).toHaveLength(1)));const reply=panel()!.querySelector('.focus-context-hover__recap p')!,range=document.createRange();range.selectNodeContents(reply);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range)
 const count=vi.mocked(api.sessions.historyPage).mock.calls.length
 for(let i=0;i<50;i++)await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(s=>s.id===C?{...s,latestOutputBytes:s.latestOutputBytes+1}:s)})))
 expect(card()).toBe(row);expect(panel()!.querySelector('.focus-context-hover__recap p')).toBe(reply);expect(window.getSelection()!.toString()).toBe(response);expect(api.sessions.historyPage).toHaveBeenCalledTimes(count);expect(document.activeElement).toBe(input);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 vi.mocked(api.sessions.historyPage).mockResolvedValue(page(A,[native('new-native','New terminal input',20)]))
 await act(async()=>notify({kind:'invalidated',agentSessionId:A,source:{providerId:'claude',nativeSessionId:'hover-'+A}}))
 await act(async()=>vi.waitFor(()=>expect(panel()!.textContent).toContain('New terminal input')))
 expect(panel()!.textContent).toContain('Reading window incomplete');expect(inputs()).toHaveLength(2)
 expect(panel()!.querySelector('.focus-context-hover__recap p')).toBe(reply);expect(window.getSelection()!.toString()).toBe(response);expect(api.sessions.historyPage).toHaveBeenCalledTimes(count+1);expect(document.activeElement).toBe(input)
 await pointer(card(),'pointerout',panel());await pointer(panel()!,'pointerover',card());await act(async()=>new Promise(resolve=>setTimeout(resolve,180)));expect(panel()).not.toBeNull()
 await act(async()=>panel()!.dispatchEvent(new Event('scroll')));expect(panel()).not.toBeNull()
})
it('shows fewer available messages honestly and bounds long/non-text excerpts without reading older pages to fill three',async()=>{
 vi.mocked(api.sessions.historyPage).mockResolvedValue({...page(A,[native('long','🙂'.repeat(800),20),{id:'resource',kind:'user-message',contentParts:[{kind:'resource',resourceType:'image',reference:_hygiene_fixturePath("recorded/image.png")}],startedAt:30}]),nextCursor:'earlier-real-cursor'})
 await open();await act(async()=>vi.waitFor(()=>expect(inputs()).toHaveLength(2)));expect(inputs()[0]!.querySelector('p')!.textContent!.length).toBeLessThanOrEqual(360);expect(inputs()[0]!.querySelector('p')!.textContent).toMatch(/…$/);expect(inputs()[1]!.textContent).toContain('Non-text input');expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

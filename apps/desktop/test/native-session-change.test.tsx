import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import type { SessionSnapshot, AgentSessionControl, AppConfig } from '../src/shared/contracts'
import { nativeBindingKey, projectNativeSourceFacts } from '../src/shared/agent-native-source'
import { reduceRuntimeEvent, runtimeDiagnosticNotice, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
vi.mock('../src/renderer/src/store', async () => ({ useAppStore: (await import('zustand')).create(() => ({})) }))
vi.mock('../src/renderer/src/components/RegionContextMenu', () => ({ useRegionMenuEntries: () => [], RegionMenuEntryView: () => null }))
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'same-session', run: { runId: 'same-run' } }
const old = { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'original-native', transcriptPath: _hygiene_fixturePath("private/old.jsonl") }
const candidate = { ...old, sessionId: 'candidate-native', transcriptPath: _hygiene_fixturePath("private/new.jsonl") }
const observation = { state: 'changed' as const, run: control.run, observedAt: 100, reason: 'Unique current main native record differs.' }
const confirmation = { operationId: 'confirmed-operation', run: control.run, previousNativeHandle: old, nativeHandle: candidate, observedAt: 200, candidateObservedAt: 100 }
function session(extra = {}): Extract<SessionSnapshot, {kind:'agent'}> { return { id: control.agentSessionId, kind:'agent', providerId:'codex', executorId:'private', hostId:'local', workspacePath:_hygiene_fixturePath("private"), label:'Private Agent', createdAt:1, updatedAt:50, agentSessionUpdatedAt:50, capabilities:{}, nativeHandle:old, nativeSessionId:old.sessionId, control, processState:'running', latestOutputBytes:0, status:{state:'running',source:'run-process',observedAt:1}, ...extra } as any }
function core(extra = {}): AgentMuxAgentSession { return { kind:'agent', agentSessionId:control.agentSessionId, providerId:'codex', executorId:'private', hostId:'local', workspacePath:_hygiene_fixturePath("private"), run:control.run, retiredRuns:[], createdAt:1, updatedAt:101, nativeHandle:old, ...extra } as any }
function project(before: ReturnType<typeof session>, incoming: AgentMuxAgentSession) { return reduceRuntimeEvent({ sessions:[before],timelines:{} } as SessionProjectionState, { type:'core',hostId:'local',event:{ type:'agent-session', session:incoming } }).sessions[0] as ReturnType<typeof session> }
const page = (id = old.sessionId, cursor: string | null = 'original-cursor'): AgentSessionHistoryPage => ({ agentSessionId:control.agentSessionId, source:{providerId:'codex',nativeSessionId:id}, items:[{id:`${id}-item`,kind:'user-message',contentParts:[{kind:'text',text:`History ${id}`}]}],nextCursor:cursor })
let root:Root, host:HTMLDivElement
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true; host=document.createElement('div');document.body.append(host);root=createRoot(host); useAppStore.setState({sessions:[session()],timelines:{},refreshSession:vi.fn().mockResolvedValue(session())},true); vi.spyOn(api.sessions,'historyPage').mockImplementation(async()=>page()); vi.spyOn(api.sessions,'observeHistory').mockImplementation(async()=>({source:page((useAppStore.getState().sessions[0] as any).nativeHandle.sessionId).source,dispose:vi.fn()}) as any) })
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
async function render(element: any) { await act(async()=>root.render(element)) }
async function click(text:string) { const element=[...document.querySelectorAll<HTMLElement>('[role=menuitem],button')].find(one=>one.textContent?.trim()===text);expect(element,`Missing ${text}`).toBeTruthy();await act(async()=>element!.click()) }
async function menu(value: ReturnType<typeof session>) { await render(createElement(AgentRegionHeader,{name:'Private Agent',executorLabel:'Private',sessionId:value.id,sessionKind:'agent',executionHost:{label:'This Mac',id:'local',cwd:_hygiene_fixturePath("private"),configured:true},regionId:'original-region',readOnly:false,onHistory:undefined,nativeSession:value}));const trigger=document.querySelector<HTMLButtonElement>('.agent-region-header__more')!;await act(async()=>{trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))}) }
it('mirrors exact changed/unknown facts and clears candidate and confirmation on authoritative removal',()=>{
 const changed=project(session(),core({observedNativeHandle:candidate,nativeSourceObservation:observation}));expect(changed.observedNativeHandle).toEqual(candidate);expect(changed.nativeSourceObservation).toEqual(observation)
 const unknown=project(changed,core({updatedAt:102,nativeSourceObservation:{...observation,state:'unknown'}}));expect(unknown.nativeSourceObservation?.state).toBe('unknown');expect(unknown.observedNativeHandle).toBeUndefined();expect(unknown.nativeHandle).toEqual(old)
 const quiet=project(unknown,core({updatedAt:103}));expect(quiet.nativeSourceObservation).toBeUndefined();expect(quiet.nativeHandle).toEqual(old)
 expect(projectNativeSourceFacts(core({nativeConfirmation:confirmation})).nativeConfirmation).toEqual(confirmation)
})
it('accepts same-Run confirmed source with cleared semantic revision, preserves disconnected and rejects stale authority',()=>{
 const previous=session({semanticStatus:{state:'waiting',source:'native-hook',observedAt:40,currentActivityRevision:19},status:{state:'waiting',source:'native-hook',observedAt:40}})
 const incoming=core({nativeHandle:candidate,nativeConfirmation:confirmation,updatedAt:200})
 const next=project(previous,incoming);expect(next.nativeHandle).toEqual(candidate);expect(next.nativeConfirmation).toEqual(confirmation);expect(next.semanticStatus).toBeUndefined();expect(next.status.state).toBe('running');expect(next.control).toEqual(control)
 expect(project({...previous,status:{state:'disconnected',source:'run-process',observedAt:45}},incoming).status.state).toBe('disconnected')
 expect(project(next,core({updatedAt:199}))).toBe(next)
 expect(project(previous,core({semanticStatus:{state:'done',source:'native-hook',observedAt:100,currentActivityRevision:1}}))).toBe(previous)
 expect(nativeBindingKey(session({nativeHandle:old,nativeConfirmation:{...confirmation,operationId:'second'}}))).not.toBe(nativeBindingKey(previous))
})
it('routes only exact persisted native observations to the Region service window, retaining other diagnostics',()=>{
 const diagnostic=(code:string,run=control.run)=>({type:'core' as const,hostId:'local',event:{type:'agent-error' as const,agentSessionId:control.agentSessionId,code,message:'Original diagnostic',evidence:{source:'agentmux' as const,run,observedAt:101}}})
 for(const state of ['changed','unknown','ambiguous'] as const)for(const code of ['AGENT_NATIVE_SOURCE_UNCONFIRMED','AGENT_NATIVE_IDENTITY_UNCONFIRMED'])expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:{...observation,state}})]},diagnostic(code))).toBeNull()
 expect(runtimeDiagnosticNotice({sessions:[session()]},diagnostic('AGENT_NATIVE_SOURCE_UNCONFIRMED'))?.message).toContain('Original diagnostic')
 expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:{...observation,run:{runId:'old-run'}}})]},diagnostic('AGENT_NATIVE_SOURCE_UNCONFIRMED'))?.message).toContain('Original diagnostic')
 for(const code of ['PRIVATE_ACK_LOST','AGENT_NATIVE_IDENTITY_PERSIST_FAILED'])expect(runtimeDiagnosticNotice({sessions:[session({nativeSourceObservation:observation})]},diagnostic(code))?.message).toContain('Original diagnostic')
})
it('shows a corner label and exact two-step confirmation; cancellation writes nothing',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeHandle:candidate}),confirmation,persisted:true,current:true})
 await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));expect(document.querySelector('[data-native-source-marker]')?.textContent).toBe('Source changed');expect(confirm).not.toHaveBeenCalled();await click('Review source change…');expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(old.sessionId);expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId);await click('Cancel source change');expect(confirm).not.toHaveBeenCalled();await click('Review source change…');await click('Confirm this native source');expect(confirm).toHaveBeenCalledOnce();expect(confirm.mock.calls[0]?.[0]).toEqual(control);expect(confirm.mock.calls[0]?.[1]).toMatchObject({agentSessionId:control.agentSessionId,expectedRun:control.run,expectedNativeHandle:old,candidateNativeHandle:candidate,expectedObservationAt:100});expect(confirm.mock.calls[0]?.[1].operationId).toBeTruthy()
})
it('unknown cannot invent a candidate and rechecks the true source even if history reading fails',async()=>{
 vi.mocked(api.sessions.historyPage).mockRejectedValueOnce(new Error('Reader unavailable after discovery'))
 await menu(session({nativeSourceObservation:{...observation,state:'unknown'}}));expect(document.querySelector('[data-native-source-marker]')?.textContent).toBe('Source unknown');expect(document.body.textContent).not.toContain('Review source change…');await click('Check native source');expect(api.sessions.historyPage).toHaveBeenCalledWith(control,{refreshNativeSource:true,limit:1});expect(useAppStore.getState().refreshSession).toHaveBeenCalledWith(control.agentSessionId);expect(document.body.textContent).toContain('Reader unavailable after discovery')
})
it.each([undefined,old])('offers real discovery without guessing a changed source for %j',async handle=>{ await menu(session({nativeHandle:handle}));expect(document.querySelector('[data-native-source-marker]')).toBeNull();expect(document.body.textContent).toContain('Check native source');await click('Check native source');expect(api.sessions.historyPage).toHaveBeenCalledWith(control,{refreshNativeSource:true,limit:1}) })
it('keeps a stale reviewed payload exact and reports Core CAS refusal without adopting it',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockRejectedValue(new Error('Observation changed; review the current candidate'))
 await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));await click('Review source change…');await render(createElement(AgentRegionHeader,{name:'Private Agent',executorLabel:'Private',sessionId:control.agentSessionId,sessionKind:'agent',executionHost:{label:'This Mac',id:'local',cwd:_hygiene_fixturePath("private"),configured:true},regionId:'original-region',readOnly:false,onHistory:undefined,nativeSession:session({observedNativeHandle:{...candidate,sessionId:'newer-candidate'},nativeSourceObservation:{...observation,observedAt:101}})}));await click('Confirm this native source');expect(confirm.mock.calls[0]?.[1].candidateNativeHandle).toEqual(candidate);expect(document.body.textContent).toContain('Observation changed');expect(useAppStore.getState().sessions[0].nativeHandle).toEqual(old)
})
it('retains a reviewed operation and uncertain confirmation when the menu closes, then retries the same identity',async()=>{
 const confirm=vi.spyOn(api.sessions,'confirmNativeSession').mockRejectedValueOnce(new Error('Confirmation receipt unavailable')).mockResolvedValueOnce({session:core({nativeHandle:candidate}),confirmation,persisted:true,current:true})
 const source=session({observedNativeHandle:candidate,nativeSourceObservation:observation})
 await menu(source);await click('Review source change…');await click('Confirm this native source')
 const first=confirm.mock.calls[0]?.[1]
 expect(document.body.textContent).toContain('Confirmation receipt unavailable')
 await act(async()=>document.querySelector('[role=menu]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(document.querySelector('[role=menu]')).toBeNull()
 await menu(source)
 expect(document.body.textContent).toContain('Confirmation receipt unavailable')
 expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId)
 await click('Confirm this native source');expect(confirm.mock.calls[1]?.[1]).toEqual(first)
})
it('reports a historical repeat without claiming the current binding was changed',async()=>{
 vi.spyOn(api.sessions,'confirmNativeSession').mockResolvedValue({session:core({nativeHandle:{...candidate,sessionId:'today'}}),confirmation,persisted:true,current:false});await menu(session({observedNativeHandle:candidate,nativeSourceObservation:observation}));await click('Review source change…');await click('Confirm this native source');expect(document.body.textContent).toContain('earlier confirmation is retained');expect(document.body.textContent).not.toContain('Native source confirmed.')
})
function history(facts: any) { return createElement(SessionHistoryView,{control,readingKey:control.run.runId,nativeSourceFacts:facts,label:'Private Agent',visible:true,themeId:'graphite',fontSize:13,workspaceRoot:_hygiene_fixturePath("private"),openWorkspaceFile:async()=>{},openHttpLink:()=>{}}) }
it('keeps the original reader through confirmation and explicitly pages previous, never passes its old cursor to the current source',async()=>{
 await render(history(session()));expect(host.textContent).toContain('History original-native');await render(history(session({nativeHandle:candidate,nativeConfirmation:confirmation})));expect(host.textContent).toContain('History original-native');await act(async()=>host.querySelector('.session-history__viewport')!.dispatchEvent(new WheelEvent('wheel',{deltaY:-10,bubbles:true})));expect(api.sessions.historyPage).toHaveBeenLastCalledWith(control,{cursor:'original-cursor',nativeSource:'previous'});await click('Current source');expect(api.sessions.historyPage).toHaveBeenLastCalledWith(control,{});vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page(old.sessionId));await click('Previous source');expect(api.sessions.historyPage).toHaveBeenLastCalledWith(control,{nativeSource:'previous'})
})
it('refuses a wrong native page while retaining the original reader',async()=>{
 await render(history(session()));vi.mocked(api.sessions.historyPage).mockResolvedValueOnce(page(candidate.sessionId));await click('Latest');expect(host.textContent).toContain('History original-native');expect(host.textContent).toContain('another source');expect(host.textContent).not.toContain('History candidate-native')
})
it('isolates shared history cache and late callbacks on a same-Run native binding change',async()=>{
 let resolve!:(value:AgentSessionHistoryPage)=>void
 vi.mocked(api.sessions.historyPage).mockImplementationOnce(()=>new Promise(done=>{resolve=done})).mockResolvedValue(page(candidate.sessionId,null))
 function Consumer(){const value=useSessionUserMessages(control);return createElement('div',{'data-source':value.nativeHistoryPage?.source.nativeSessionId},value.nativeHistoryPage?.source.nativeSessionId??'loading')}
 await render(createElement(Consumer));expect(api.sessions.historyPage).toHaveBeenCalledOnce();await act(async()=>useAppStore.setState({sessions:[session({nativeHandle:candidate,nativeConfirmation:confirmation})]}));expect(api.sessions.historyPage).toHaveBeenCalledTimes(2);expect(host.textContent).toBe(candidate.sessionId);await act(async()=>resolve(page(old.sessionId)));expect(host.textContent).toBe(candidate.sessionId)
})
function mainOwner(){
 const controller=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),async()=>{throw new Error('Unexpected host creation')})
 const client={connect:vi.fn().mockResolvedValue(undefined),sessionHistorySources:vi.fn().mockResolvedValue([{agentSessionId:control.agentSessionId,history:{providerId:'codex',executorId:'private',workspacePath:_hygiene_fixturePath("private")}}]),sessionHistoryPage:vi.fn().mockResolvedValue(page()),confirmAgentNativeSession:vi.fn().mockResolvedValue({session:core(),confirmation,persisted:true,current:false})}
 ;(controller as any).hosts.set('local',{client,historyObservationDisposers:new Set()})
 const config={executors:{private:{providerId:'codex',command:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}}}} as AppConfig
 return{controller,client,config}
}
it('Main forwards only page/source options with its trusted executor and never connects a Run to read',async()=>{
 const f=mainOwner();await f.controller.sessionHistoryPage(control,{refreshNativeSource:true,limit:1,commandOverride:_hygiene_fixturePath("evil"),env:{SECRET:'evil'}} as any,f.config);expect(f.client.sessionHistoryPage).toHaveBeenLastCalledWith(control.agentSessionId,{refreshNativeSource:true,limit:1,commandOverride:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}});await f.controller.sessionHistoryPage(control,{nativeSource:'previous',cursor:'old-source-cursor'},f.config);expect(f.client.sessionHistoryPage).toHaveBeenLastCalledWith(control.agentSessionId,{nativeSource:'previous',cursor:'old-source-cursor',commandOverride:_hygiene_fixturePath("trusted/native"),args:['--trusted'],env:{PRIVATE:'trusted'}});expect(f.client.connect).not.toHaveBeenCalled()
})
it('Main confirms only the exact Session/Run and preserves Core current:false receipt semantics',async()=>{
 const f=mainOwner(),input={agentSessionId:control.agentSessionId,expectedRun:control.run,expectedNativeHandle:old,candidateNativeHandle:candidate,expectedObservationAt:100,operationId:'manual-exact'}
 await expect(f.controller.confirmNativeSession(control,input)).resolves.toMatchObject({current:false,persisted:true});expect(f.client.confirmAgentNativeSession).toHaveBeenCalledExactlyOnceWith(input);await expect(f.controller.confirmNativeSession({...control,agentSessionId:'foreign'},input)).rejects.toThrow('exact Session');await expect(f.controller.confirmNativeSession({...control,run:{runId:'foreign'}},input)).rejects.toThrow('exact Session');expect(f.client.confirmAgentNativeSession).toHaveBeenCalledOnce()
})

import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import {act,createElement} from 'react'
import type {Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createClientUiRoot as createRoot} from './helpers/client-ui-render'
import {seedMoteWorkface,moteAgent,moteConfig,moteTopics,moteTopic,scratchWorkspace} from './fixtures/mote-workface'
import {createWorkspaceLayout} from '@agentmux/layout'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {createWorkbenchTab} from '../src/renderer/src/lib/workbench-tabs'
import {scratchTopicsScope} from '../src/renderer/src/lib/scratch-topic-snapshots'
import {focusProjectKey} from '../src/renderer/src/lib/focus-project-lanes'
import {groupFocusContexts,createFocusProjectionSelector} from '../src/renderer/src/lib/focus-context'
import type {WorkbenchProjectionSelection} from '../src/renderer/src/lib/workbench-projection'
import {GlobalFocusSurface} from '../src/renderer/src/components/GlobalFocusSurface'
import {WorkspaceAgentsTool} from '../src/renderer/src/components/SurfaceToolDock'
import {chooseFocusFilter} from './fixtures/focus-filter-menu'
// Keep Global, Store, projector, Lanes, grouping, row and the filter real.
// The separate history timeline and PTY paint do not prove this derived header.
vi.mock('../src/renderer/src/components/RecentFocusTimeline',()=>({RecentFocusTimeline:()=>null}))
vi.mock('../src/renderer/src/components/SessionPane',()=>({SessionPane:()=>null}))
const initial=useAppStore.getState()
let root:Root,container:HTMLDivElement,input:HTMLInputElement
const refs:Record<string,WorkbenchProjectionSelection>={}
const currentRows=()=>[...container.querySelectorAll<HTMLElement>('.focus-project-lanes__row[data-focus-current="true"]')]
const ids=(bucket='working')=>[...container.querySelectorAll<HTMLElement>(`.focus-project-lanes__groups [data-bucket="${bucket}"] .focus-context`)].map(n=>n.dataset.sessionId)
const render=(ref:WorkbenchProjectionSelection|null)=>act(async()=>root.render(<GlobalFocusSurface currentReference={ref} workspaceOpen={false}/>))
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);seedMoteWorkface()
 const topics=[...moteTopics,moteTopic('launcher:second','Second ordinary Topic',false)]
 const workspaces=[...moteConfig.workspaces,{id:'checkout',name:'Project',hostId:'local',path:_hygiene_fixturePath("checkout"),repoPath:_hygiene_fixturePath("project"),branch:'branch',kind:'folder' as const},
  {id:'remote-project',name:'Project',hostId:'remote',path:_hygiene_fixturePath("project"),kind:'folder' as const}]
 const identities=[['home','project',_hygiene_fixturePath("project"),'local',null],['checkout','checkout',_hygiene_fixturePath("checkout"),'local',null],
  ['remote','remote-project',_hygiene_fixturePath("project"),'remote',null],['topic-a',scratchWorkspace.id,topics[3]!.directoryPath,'local',topics[3]!.id],
  ['topic-b',scratchWorkspace.id,topics[4]!.directoryPath,'local',topics[4]!.id]] as const
 const sessions=identities.map(([id,,workspacePath,hostId])=>({...moteAgent(id,null),workspacePath,hostId,control:{...moteAgent(id,null).control,hostId}}))
 const tabs=Object.fromEntries(identities.map(([id,workspaceId,,,topicId])=>{const tab=createWorkbenchTab(id+'-tab',{kind:'agent',phase:'attached',workspaceId,regionId:id+'-region',sessionId:id});refs[id]={displayWorkspaceId:workspaceId,groupId:'group-'+workspaceId,tabId:tab.id,regionId:tab.layout.activeRegionId};return[tab.id,{...tab,...(topicId?{topicId}:{})}]}))
 const file=createWorkbenchTab('file-tab',{kind:'file',workspaceId:'checkout',regionId:'file-region',path:'notes.md'})
 tabs[file.id]=file;refs.file={displayWorkspaceId:'remote-project',groupId:'foreign-group',tabId:file.id,regionId:'file-region'}
 useAppStore.setState({loading:false,config:{...moteConfig,workspaces},sessions,tabs,layouts:Object.fromEntries(workspaces.map(w=>[w.id,createWorkspaceLayout('group-'+w.id,Object.values(tabs).filter(t=>t.workspaceId===w.id).map(t=>t.id))])),timelines:{},mainSurface:'agents',agentNames:{},agentFocus:{execution:{sessionId:'remote',history:[]},pmo:{sessionId:null}},scratchTopicSnapshots:{[scratchWorkspace.id]:{scope:scratchTopicsScope(scratchWorkspace),revision:0,topics,error:null,reading:false}}})
 vi.spyOn(api.workspaces,'listBranches').mockImplementation(async(workspaceId:string)=>({kind:'not-a-git-repository' as const,hostId:'local',workspacePath:workspaces.find(w=>w.id===workspaceId)?.path??_hygiene_fixturePath("unconfirmed")}))
 vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
 vi.spyOn(api.scratch,'listTopics').mockResolvedValue(topics)
 container=document.createElement('div');input=document.createElement('input');input.value='Original input and selection';document.body.append(container,input);input.focus();input.setSelectionRange(2,8);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();input.remove();document.getElementById('agentmux-window-overlay-host')?.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()})
it('marks only the exact worktree/Host/Topic row and keeps the project filter independent',async()=>{
 const before=useAppStore.getState();await render(refs.checkout!);expect(currentRows()).toHaveLength(1)
 const marked=currentRows()[0]!,button=marked.querySelector('button')!
 expect(marked.querySelector('[data-session-id="checkout"]')).not.toBeNull();expect(button.getAttribute('aria-current')).toBe('location');expect(button.getAttribute('aria-pressed')).toBe('false')
 expect(container.querySelectorAll('.focus-project-lanes__row')).toHaveLength(5)
 for(const id of ['home','remote','topic-a','topic-b']){await render(refs[id]!);expect(currentRows()).toHaveLength(1);expect(currentRows()[0]!.querySelector(`[data-session-id="${id}"]`)).not.toBeNull()}
 expect(useAppStore.getState().agentFocus).toBe(before.agentFocus);expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([2,8])
 await chooseFocusFilter(container,'project',focusProjectKey('local','project'));expect(container.querySelectorAll('.focus-project-lanes__row')).toHaveLength(2);expect(currentRows()).toHaveLength(0)
 await render(refs.checkout!);expect(currentRows()).toHaveLength(1);expect(currentRows()[0]!.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
})
it('uses the confirmed resource for a foreign File; missing Region and unknown resource never borrow MRU',async()=>{
 await render(refs.file!);expect(currentRows()).toHaveLength(1);expect(currentRows()[0]!.querySelector('[data-session-id="checkout"]')).not.toBeNull()
 await render({...refs.home!,regionId:'gone'});expect(currentRows()).toHaveLength(0)
 await render(null);expect(currentRows()).toHaveLength(0)
 // A retained Agent Tab's resource id cannot confirm its unregistered execution workspace.
 const lost={...moteAgent('unknown',null),workspacePath:_hygiene_fixturePath("unregistered")}
 const retained=createWorkbenchTab('unknown-tab',{kind:'agent',phase:'attached',workspaceId:'checkout',regionId:'unknown-region',sessionId:lost.id})
 await act(async()=>useAppStore.setState(s=>({sessions:[lost],tabs:{...s.tabs,[retained.id]:retained}})))
 await render(refs.file!);expect(container.querySelector('.focus-project-lanes__row[data-recovery="unknown"]')).not.toBeNull();expect(currentRows()).toHaveLength(0)
})
it('keeps entry order and original DOM when same-group task activity changes',async()=>{
 const base={...moteAgent('older',null),status:{state:'working' as const,source:'native-hook' as const,observedAt:Date.now()}},now=Date.now()-10000
 const sessions=['unknown','older','newer','tie'].map(id=>({...base,id,...(id==='unknown'?{}:{semanticStatus:{...base.status,stateEnteredAt:now+(id==='older'?0:1000)}}),control:{...base.control,agentSessionId:id,run:{runId:'original-'+id}}}))
 const item=(id:string,time:number)=>({agentSessionId:id,revision:1,items:[{id:id+'-input',agentSessionId:id,kind:'user_message' as const,source:'native-hook' as const,status:'complete' as const,title:'Input',content:'Original '+id,createdAt:time,updatedAt:time}]})
 await act(async()=>useAppStore.setState({sessions,timelines:{older:item('older',now),newer:item('newer',now+1000),tie:item('tie',now+1000)}}));await render(null)
 expect(ids()).toEqual(['newer','tie','older','unknown']);const nodes=new Map([...container.querySelectorAll<HTMLElement>('.focus-context')].map(n=>[n.dataset.sessionId,n]))
 const before=useAppStore.getState();await act(async()=>useAppStore.setState(s=>({sessions:s.sessions.map(session=>({...session,latestOutputBytes:session.latestOutputBytes+10,status:{...session.status,observedAt:Date.now()}}))})))
 expect(ids()).toEqual(['newer','tie','older','unknown']);for(const[id,n]of nodes)expect(container.querySelector(`[data-session-id="${id}"]`)).toBe(n)
 await act(async()=>useAppStore.setState(s=>({timelines:{...s.timelines,older:item('older',now+2000)}})));expect(ids()).toEqual(['newer','tie','older','unknown'])
 expect(useAppStore.getState().agentFocus).toBe(before.agentFocus);expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 const contexts=createFocusProjectionSelector()(useAppStore.getState()).contexts,copy=[...contexts];groupFocusContexts(contexts);expect(contexts).toEqual(copy)
})
it('keeps unconfirmed initial entry order in the actual expanded Disconnected project',async()=>{
 const now=Date.now()-10000,sessions=['offline-old','offline-new'].map(id=>({...moteAgent(id,null),processState:'interrupted' as const,status:{state:'disconnected' as const,source:'native-hook' as const,observedAt:2}}))
 const timelines=Object.fromEntries(sessions.map((s,i)=>[s.id,{agentSessionId:s.id,revision:1,items:[{id:s.id+'-event',agentSessionId:s.id,kind:'assistant_message' as const,source:'native-hook' as const,status:'complete' as const,title:'Reply',content:'Retained reply',createdAt:now+i*1000,updatedAt:now+i*1000}]}]))
 await act(async()=>useAppStore.setState({sessions,timelines}));await render(null)
 const trigger=container.querySelector<HTMLButtonElement>('.focus-disconnected-projects__toggle')!;expect(trigger).not.toBeNull();await act(async()=>trigger.click())
 expect([...container.querySelectorAll<HTMLElement>('.focus-disconnected-projects__cards .focus-context')].map(n=>n.dataset.sessionId)).toEqual(['offline-old','offline-new'])
})
it('reuses grouped activity ordering in the actual Space Agents tool without a second comparator',async()=>{
 const now=Date.now()-10000,sessions=['older','newer'].map(id=>({...moteAgent(id,null),status:{state:'working' as const,source:'native-hook' as const,observedAt:Date.now()}}))
 const timelines=Object.fromEntries(sessions.map((s,i)=>[s.id,{agentSessionId:s.id,revision:1,items:[{id:s.id+'-event',agentSessionId:s.id,kind:'user_message' as const,source:'native-hook' as const,status:'complete' as const,title:'Input',content:'Original request',createdAt:now+i*1000,updatedAt:now+i*1000}]}]))
 await act(async()=>useAppStore.setState({sessions,timelines}));const onOpen=vi.fn(),before=useAppStore.getState()
 await act(async()=>root.render(<WorkspaceAgentsTool workspace={moteConfig.workspaces[1]!} sessions={sessions} onOpen={onOpen}/>))
 const rows=[...container.querySelectorAll<HTMLButtonElement>('.workspace-agent-row')];expect(rows.map(row=>row.dataset.sessionId)).toEqual(['newer','older'])
 await act(async()=>rows[0]!.click());expect(onOpen).toHaveBeenCalledWith('newer');expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
})

it('re-entry moves to the front; search, source-array order, same-group substate and rename retain entry order',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
 const session=(id:string,state:'working'|'starting'|'waiting',enteredAt:number)=>({...moteAgent(id,null),status:{state,source:'native-hook' as const,observedAt:now},semanticStatus:{state,source:'native-hook' as const,observedAt:now,stateEnteredAt:enteredAt}})
 await act(async()=>useAppStore.setState({sessions:[session('first','working',now-1000),session('second','working',now-2000)],timelines:{}}));await render(null)
 expect(ids()).toEqual(['first','second']);const first=container.querySelector('[data-session-id="first"]')!,second=container.querySelector('[data-session-id="second"]')!
 now+=100
 await act(async()=>useAppStore.setState(s=>({sessions:[session('second','starting',now),s.sessions[0]!],agentNames:{second:'Renamed second'}})))
 expect(ids()).toEqual(['first','second']);expect(container.querySelector('[data-session-id="first"]')).toBe(first);expect(container.querySelector('[data-session-id="second"]')).toBe(second)
 const search=container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
 const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
 await act(async()=>{set.call(search,'second');search.dispatchEvent(new Event('input',{bubbles:true}))});expect(ids()).toEqual(['second'])
 await act(async()=>{set.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}))});expect(ids()).toEqual(['first','second'])
 now+=100
 await act(async()=>useAppStore.setState({sessions:[session('first','working',now-1000),session('second','waiting',now)]}));expect(ids()).toEqual(['first']);expect(ids('attention')).toEqual(['second'])
 now+=100
 await act(async()=>useAppStore.setState({sessions:[session('first','working',now-1000),session('second','working',now)]}));expect(ids()).toEqual(['second','first'])
 expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([2,8])
})
it('pending Attention entry never borrows a Working timestamp; removing the request is a real re-entry',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
 const working={...moteAgent('pending',null),status:{state:'working' as const,source:'native-hook' as const,observedAt:now},semanticStatus:{state:'working' as const,source:'native-hook' as const,observedAt:now,stateEnteredAt:now-100}}
 const waiting={...moteAgent('waiting',null,'waiting'),status:{state:'waiting' as const,source:'native-hook' as const,observedAt:now},semanticStatus:{state:'waiting' as const,source:'native-hook' as const,observedAt:now,stateEnteredAt:now-1000}}
 await act(async()=>useAppStore.setState({sessions:[{...working,pendingInteraction:{id:'request',kind:'permission',title:'Allow editing?',operation:'edit'} as never},waiting],timelines:{}}));await render(null)
 expect(ids('attention')).toEqual(['waiting','pending'])
 now+=100
 await act(async()=>useAppStore.setState({sessions:[working,waiting]}));expect(ids()).toEqual(['pending'])
 now+=100
 await act(async()=>useAppStore.setState({sessions:[{...working,pendingInteraction:{id:'request',kind:'permission',title:'Allow editing?',operation:'edit'} as never},waiting]}));expect(ids('attention')).toEqual(['pending','waiting'])
})
it('new Run or execution workspace is a new entry, while initial unknown order stays stable',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
 const a={...moteAgent('a',null),status:{state:'working' as const,source:'native-hook' as const,observedAt:now}},b={...moteAgent('b',null),status:{state:'working' as const,source:'native-hook' as const,observedAt:now}}
 await act(async()=>useAppStore.setState({sessions:[a,b],timelines:{}}));await render(null);expect(ids()).toEqual(['a','b'])
 now+=100
 await act(async()=>useAppStore.setState({sessions:[{...b,control:{...b.control,run:{runId:'new-run-b'}}},a]}));expect(ids()).toEqual(['b','a'])
 now+=100
 const changed={...a,workspacePath:_hygiene_fixturePath("checkout")}
 await act(async()=>useAppStore.setState(s=>({config:{...s.config!,workspaces:[...s.config!.workspaces,{id:'new-home',hostId:'local',path:_hygiene_fixturePath("checkout"),name:'Checkout',kind:'folder'}]},sessions:[changed,s.sessions[0]!]})))
 const select=createFocusProjectionSelector(),one=select(useAppStore.getState());expect(one.contexts).toHaveLength(2)
 // The same mounted projection has retained both exact identities and original Runs.
 expect(container.querySelectorAll('[data-session-id="a"]')).toHaveLength(1);expect(container.querySelectorAll('[data-session-id="b"]')).toHaveLength(1)
 expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe(a.control.run.runId)
})

it('late first discovery seeds its confirmed entry time or stable unknown order, not arrival time',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
 const session=(id:string,enteredAt?:number)=>({...moteAgent(id,null),status:{state:'working' as const,source:'native-hook' as const,observedAt:now},...(enteredAt===undefined?{}:{semanticStatus:{state:'working' as const,source:'native-hook' as const,observedAt:now,stateEnteredAt:enteredAt}})})
 const first=session('first',now-1000),second=session('second',now-2000)
 await act(async()=>useAppStore.setState({sessions:[first,second],timelines:{}}));await render(null)
 const nodes=new Map([...container.querySelectorAll<HTMLElement>('.focus-context')].map(n=>[n.dataset.sessionId,n]))
 now+=100
 const late=session('late',now-3000),unknown=session('unknown')
 await act(async()=>useAppStore.setState({sessions:[unknown,late,first,second]}))
 expect(ids()).toEqual(['first','second','late','unknown'])
 now+=100
 await act(async()=>useAppStore.setState(s=>({sessions:[...s.sessions].reverse(),timelines:{late:{agentSessionId:'late',revision:1,items:[{id:'latest-reply',agentSessionId:'late',kind:'assistant_message',source:'native-hook',status:'complete',title:'Reply',content:'Late discovered old conversation with a new reply',createdAt:now,updatedAt:now}]}}})))
 expect(ids()).toEqual(['first','second','late','unknown'])
 for(const[id,node]of nodes)expect(container.querySelector(`[data-session-id="${id}"]`)).toBe(node)
 expect(document.activeElement).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual([2,8])
})

// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useMoteMainEntry } from '../src/renderer/src/lib/mote-main-entry'
import { MoteDialogueViewProvider } from '../src/renderer/src/lib/mote-dialogue-view'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface, installNativePopover } from './fixtures/mote-workface'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import type { MoteDialoguePage, MoteDialogueRecoveryRequest } from '@agentmux/core/mote-dialogue'
import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id:string } }) => <div data-terminal-session={session.id} /> }))
const baseline=useAppStore.getState(),closes:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllGlobals();useAppStore.setState(baseline,true);localStorage.clear()})
const scope={topic:moteTopics[0]!,workspace:scratchWorkspace,rootPath:moteTopics[0]!.directoryPath}
const reference={hostId:'local',sessionId:defaultAgent.id,displayWorkspaceId:scratchWorkspace.id,groupId:'mote-group',tabId:defaultTab.id,regionId:defaultTab.layout.activeRegionId}
function page(target:MoteDialoguePage['main']['target']):MoteDialoguePage{return{main:{target,identity:{hostId:'local',moteId:moteTopics[0]!.id},status:'ready',resource:null,documentRevision:'original-file',roleRevision:'original-role',current:reference,issue:null},links:[],incarnation:'original-links',throughSequence:0,next:null,coverage:'linked-sources-only',sourceStatus:'read',sourceIssue:null}}
function operation(request:MoteDialogueRecoveryRequest):AgentMuxContinuityOperation{return{operationId:request.operationId,agentSessionId:request.reference.sessionId,trigger:'manual',previousRun:request.expectedRun,policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},admittedAt:1,observedAt:1,rechecks:0,kind:'pending',reason:'operation-unconfirmed',evidence:{kind:'run-unknown',observedAt:1,message:'Original Start ACK lost'},moteMainEntry:{target:request.target,expectedRoleRevision:request.expectedRoleRevision,reference:request.reference}}}
function setup(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto)
 vi.stubGlobal('IntersectionObserver',class{constructor(private notify:IntersectionObserverCallback){} observe(target:Element){queueMicrotask(()=>this.notify([{target,isIntersecting:true} as IntersectionObserverEntry],this as unknown as IntersectionObserver))}unobserve(){}disconnect(){}})
 localStorage.clear();seedMoteWorkface();closes.push(installNativePopover())
 useAppStore.setState(current=>({loading:false,initialize:async()=>()=>{},prewarmTerminal:vi.fn(),detectExecutors:vi.fn(async()=>{}),sessions:current.sessions.map(item=>item.id===defaultAgent.id?{...defaultAgent,processState:'exited' as const}:item),viewModes:{[defaultAgent.id]:'activity'}}))
 vi.spyOn(api.scratch,'listTopics').mockResolvedValue(moteTopics);vi.spyOn(api.scratch,'readTopic').mockImplementation(async(_workspace,id)=>moteTopics.find(topic=>topic.id===id)??null)
 vi.spyOn(api.files,'readDirectory').mockResolvedValue([]);vi.spyOn(api.demands,'list').mockResolvedValue([])
 return vi.spyOn(api.moteDialogue,'read').mockImplementation(async({target})=>page(target))
}
async function root(){const container=document.createElement('div');document.body.append(container);const root=createClientUiRoot(container);closes.push(async()=>{await act(async()=>root.unmount());container.remove()});return{container,root}}
function Probe({active,token}:{active:boolean;token?:string|undefined}){const state=useMoteMainEntry({scope,entryToken:token,active});return <output data-entry-status={state.status}>{state.issue}<button onClick={state.inspect}>Inspect original</button></output>}
function Entry({active=true,token}:{active?:boolean;token?:string|undefined}){return <MoteDialogueViewProvider scope={scope} active={active}><Probe active={active} token={token}/></MoteDialogueViewProvider>}

it('actual App reads an exited original Mote conversation and visibly loads outside folded tools without revoking its composer',async()=>{
 setup();useAppStore.setState({activeWorkspaceId:scratchWorkspace.id,mainSurface:'workbench'})
 useAppStore.getState().activateTab(scratchWorkspace.id,'mote-group',defaultTab.id)
 let reject!: (error:Error)=>void
 const native=vi.spyOn(api.conversation,'readAgentConversation').mockRejectedValue(new Error('Original first window failed'))
   .mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no}))
 vi.spyOn(api.conversation,'observeConversation').mockImplementation(async input=>{const closed=new AbortController();return{...input,sourceHostId:input.hostId,scope:{sources:[]},coverage:[],closed:closed.signal,dispose(){closed.abort()}}})
 const ensure=vi.spyOn(api.moteDialogue,'ensureRecovery'),inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockResolvedValue({operation:null})
 const launch=vi.spyOn(useAppStore.getState(),'launchAgent'),stop=vi.spyOn(useAppStore.getState(),'stopSession'),send=vi.spyOn(useAppStore.getState(),'send')
 const {root:r,container}=await root(),draft=useAppStore.getState().agentComposerDrafts
 await act(async()=>r.render(<App/>))
 await vi.waitFor(()=>expect(native).toHaveBeenCalled())
 const reader=container.querySelector('.activity-feed[data-mote-conversation="true"]')!
 expect(reader).not.toBeNull()
 const loading=reader.querySelector('.activity-feed__empty-reading.full-page-loading--loading')!
 expect(loading,reader.textContent??'').not.toBeNull();expect(loading.closest('details')).toBeNull()
 const composer=container.querySelector('[aria-label="Message Agent"]')!
 expect(composer).not.toBeNull();expect(composer.closest('[hidden],[inert]')).toBeNull()
 await act(async()=>reject(new Error('Original first window failed')))
 await vi.waitFor(()=>expect(reader.querySelector('.activity-feed__empty-reading.full-page-loading--loading')).toBeNull())
 expect(container.querySelector('[aria-label="Message Agent"]')).toBe(composer)
 expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
 expect(ensure).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled()
})

it('entry hook ignores background and missing explicit tokens, then inspects and admits only one original operation',async()=>{
 setup();const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockResolvedValue({operation:null}),ensure=vi.spyOn(api.moteDialogue,'ensureRecovery').mockImplementation(async request=>({operation:operation(request)}))
 const {root:r,container}=await root()
 await act(async()=>r.render(<Entry active={false}/>));expect(inspect).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled()
 await act(async()=>r.render(<Entry token={undefined}/>));expect(inspect).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled()
 await act(async()=>r.render(<Entry token="explicit-open"/>));await vi.waitFor(()=>expect(ensure).toHaveBeenCalledTimes(1))
 expect(inspect).toHaveBeenCalledTimes(1);expect(ensure.mock.calls[0]![0]).toMatchObject({reference,expectedRun:defaultAgent.control.run,expectedRoleRevision:'original-role'})
 expect(ensure.mock.calls[0]![0].operationId).toMatch(/^mote-entry-[a-f0-9]{64}$/u)
 await act(async()=>r.render(<Entry token="explicit-open"/>));expect(ensure).toHaveBeenCalledTimes(1)
 await vi.waitFor(()=>expect(container.textContent).toContain('尚未确认'))
})

it('entry hook preserves the original durable key after a lost ACK, remount and another explicit open',async()=>{
 setup();const retained=new Map<string,AgentMuxContinuityOperation>()
 const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockImplementation(async request=>({operation:retained.get(request.operationId)??null}))
 const ensure=vi.spyOn(api.moteDialogue,'ensureRecovery').mockImplementation(async request=>{retained.set(request.operationId,operation(request));throw new Error('Original ACK lost')})
 const first=await root();await act(async()=>first.root.render(<Entry token="explicit-open"/>));await vi.waitFor(()=>expect(ensure).toHaveBeenCalledTimes(1))
 await act(async()=>first.root.render(<div/>))
 const second=await root();await act(async()=>second.root.render(<Entry token="another-explicit-open"/>))
 await vi.waitFor(()=>expect(inspect).toHaveBeenCalledTimes(2));expect(ensure).toHaveBeenCalledTimes(1)
 expect(inspect.mock.calls[1]![0].operationId).toBe(ensure.mock.calls[0]![0].operationId)
 await vi.waitFor(()=>expect(second.container.textContent).toContain('尚未确认'))
})

it.each(['pointerdown','keydown','input','close'] as const)('entry hook cancels first admission when %s follows a pending original role read',async event=>{
 const read=setup();let release!: (value:MoteDialoguePage)=>void;let target!:MoteDialoguePage['main']['target']
 read.mockImplementation(({target:t})=>{target=t;return new Promise(resolve=>{release=resolve})})
 const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockResolvedValue({operation:null}),ensure=vi.spyOn(api.moteDialogue,'ensureRecovery')
 const {root:r}=await root();await act(async()=>r.render(<Entry token="explicit-open"/>));await vi.waitFor(()=>expect(read).toHaveBeenCalled())
 if(event==='close')await act(async()=>r.render(<Entry active={false}/>));else await act(async()=>document.dispatchEvent(new Event(event,{bubbles:true})))
 await act(async()=>release(page(target)))
 await new Promise<void>(resolve=>queueMicrotask(resolve))
 expect(inspect).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled()
})

it.each(['pointerdown','close'] as const)('entry hook cannot turn a late absent inspect into first ensure after %s',async event=>{
 setup();let release!:(value:{operation:null})=>void
 const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockImplementation(()=>new Promise(resolve=>{release=resolve})),ensure=vi.spyOn(api.moteDialogue,'ensureRecovery')
 const {root:r}=await root();await act(async()=>r.render(<Entry token="pending-inspect"/>));await vi.waitFor(()=>expect(inspect).toHaveBeenCalledTimes(1))
 if(event==='close')await act(async()=>r.render(<Entry active={false}/>));else await act(async()=>document.dispatchEvent(new Event(event,{bubbles:true})))
 await act(async()=>release({operation:null}));expect(ensure).not.toHaveBeenCalled()
})

it('entry hook does not ensure when inspection is unavailable and retains the exact key for explicit inspection',async()=>{
 setup();const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockRejectedValue(new Error('Original inspection unavailable')),ensure=vi.spyOn(api.moteDialogue,'ensureRecovery')
 const {root:r,container}=await root();await act(async()=>r.render(<Entry token="inspect-unavailable"/>))
 await vi.waitFor(()=>expect(container.textContent).toContain('Original inspection unavailable'))
 await act(async()=>r.render(<Entry token="inspect-unavailable"/>));expect(inspect).toHaveBeenCalledTimes(1);expect(ensure).not.toHaveBeenCalled()
 await act(async()=>container.querySelector<HTMLButtonElement>('button')!.click())
 await vi.waitFor(()=>expect(inspect).toHaveBeenCalledTimes(2));expect(inspect.mock.calls[1]![0]).toEqual(inspect.mock.calls[0]![0]);expect(ensure).not.toHaveBeenCalled()
})

it('entry hook settles the initial role-read failure without an infinite loading phase or recovery admission',async()=>{
 const read=setup();read.mockRejectedValue(new Error('Original role source unavailable'))
 const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery'),ensure=vi.spyOn(api.moteDialogue,'ensureRecovery')
 const {root:r,container}=await root();await act(async()=>r.render(<Entry token="role-failure"/>))
 await vi.waitFor(()=>expect(container.querySelector('output')?.getAttribute('data-entry-status')).toBe('unconfirmed'))
 expect(container.textContent).toContain('Original role source unavailable');expect(inspect).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled()
})

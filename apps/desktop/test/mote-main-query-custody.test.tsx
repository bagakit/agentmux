// @vitest-environment happy-dom
import {act} from 'react'
import {webcrypto,createHash} from 'node:crypto'
import {dirname} from 'node:path'
import {access,appendFile} from 'node:fs/promises'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createMoteConversationStartFixture} from '../../host/test/helpers/mote-conversation-start-fixture'
import {ScratchTopics} from '../../host/src/mote-resources'
import {moteQuickBaseline} from '@agentmux/core/mote-preferences'
import {moteMainBindingInput,pendingMoteMainCreation,spatialAgentOpenRecord} from '@agentmux/core/spatial-graph'
import {pendingMoteMainStarts} from '@agentmux/core/mote-dialogue'
import {scratchTopicLogicalPath,scratchTopicDirectoryName} from '@agentmux/host/mote-model'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore,retainMoteMainCreationReference} from '../src/renderer/src/store'
import {useLauncherState} from '../src/renderer/src/lib/launcher-state'
import {desktopWorkbenchFromSpatial} from '../src/renderer/src/lib/desktop-spatial-state'
import {scratchTopicsScope} from '../src/renderer/src/lib/scratch-topic-snapshots'
import {moteEntryDraftKey} from '../src/renderer/src/lib/mote-entry-hold'
import {createMoteApp,settleMoteApp,type MoteAppFixture} from './fixtures/mote-app'
import {moteAgent} from './fixtures/mote-workface'
import {MoteMainActions} from '../src/renderer/src/components/MoteMainActions'
import {MoteDialogueViewProvider} from '../src/renderer/src/lib/mote-dialogue-view'

const closes:Array<()=>void|Promise<void>>=[]
let app:MoteAppFixture|undefined
beforeEach(async()=>{
  vi.stubGlobal('crypto',webcrypto)
  const stop=await useAppStore.getState().initialize();stop()
  app=createMoteApp()
  useLauncherState.setState({drafts:{},persistenceIssue:null})
})
afterEach(async()=>{
  await app?.dispose();app=undefined
  for(const close of closes.splice(0).reverse())await close()
  vi.restoreAllMocks();vi.unstubAllGlobals()
})
const wait=async(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check()},{timeout:10000})
const facts=async(value:unknown)=>{if(process.env.MOTE_QUERY_CUSTODY_FACTS)await appendFile(process.env.MOTE_QUERY_CUSTODY_FACTS,JSON.stringify(value)+'\n')}
const button=(scope:ParentNode,label:string)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>!b.closest('[hidden],[inert]')&&(b.textContent===label||b.getAttribute('aria-label')===label))
async function click(scope:ParentNode,label:string){await wait(()=>expect(button(scope,label),label).toBeDefined());await act(async()=>button(scope,label)!.click())}

async function originalBoundQuery(){
  const f=await createMoteConversationStartFixture({providerId:'claude'}),root=f.h.root
  closes.push(async()=>{await f.close();await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});await facts({kind:'private-owner-closed',root,absent:true})})
  const oldId='original-bound-start',oldPrompt='Original first question with an unknown outcome'
  await f.start(oldId,oldPrompt)
  let record=spatialAgentOpenRecord((await f.spatial.read())!.graph,oldId)!
  const preferences=await f.rpc.call('space.mote.preferences.read',{kind:'quick',target:f.target}),baseline=moteQuickBaseline(preferences)!
  const binding=moteMainBindingInput(record,baseline)
  const saved=await f.rpc.call('space.mote.preferences.save',binding)
  expect(saved.status).toBe('saved')
  record=spatialAgentOpenRecord((await f.spatial.read())!.graph,oldId)!
  expect(record.moteMainFollowUps?.bindingReceipt?.status).toBe('saved')
  expect(record.moteMainFollowUps?.deferredInputObserved).toBeUndefined()
  const observation=await f.setup(oldId,false)
  expect(observation.creation).toBe('unconfirmed');expect(observation.binding).toBe('confirmed')
  expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)).toBeNull()
  expect(pendingMoteMainStarts((await f.spatial.read())!.graph,f.target).map(x=>x.requestId)).toContain(oldId)
  const workspace={id:f.target.expectedResource.workspaceId,hostId:f.target.expectedResource.hostId,path:f.target.expectedResource.workspacePath,name:'Original Mote fixture',kind:'folder' as const}
  const topics=new ScratchTopics(),found=await topics.readForDirectory(workspace,dirname(f.path)),topic=(await topics.read(workspace,found!.id))!
  const scope={workspace,topic,rootPath:scratchTopicLogicalPath(workspace,topic)??scratchTopicDirectoryName(topic.id)}
  const project=async()=>{
    const graph=(await f.spatial.read())!.graph,projected=desktopWorkbenchFromSpatial(graph)
    const currentTopic=(await topics.read(workspace,topic.id))!
    const sessions=f.h.client.agentSessions().map(native=>({...moteAgent(native.agentSessionId,null,'waiting'),providerId:'claude',executorId:'saved',workspacePath:native.workspacePath,
      control:{kind:'agent' as const,hostId:'local',agentSessionId:native.agentSessionId,run:native.run}}))
    useAppStore.setState({tabs:projected.tabs as never,layouts:projected.layouts,sessions,
      scratchTopicSnapshots:{[workspace.id]:{scope:scratchTopicsScope(workspace),revision:0,topics:[currentTopic],error:null,reading:false}}})
    return currentTopic
  }
  const state=useAppStore.getState()
  useAppStore.setState({config:{...state.config!,workspaces:[workspace],executors:{saved:{label:'Saved',providerId:'claude',command:'claude',args:[],env:{},injectAgentMuxGuide:false}}},
    moteMainCreationReferences:{},dirtyDocuments:{},documentIssues:{},spaceZoneBindings:{[f.target.zoneId]:{spaceId:f.target.spaceId,workspaceId:workspace.id,topicId:topic.id,contentKind:'mote'}},
    activeWorkspaceId:workspace.id,mainSurface:'workbench',refreshScratchTopics:vi.fn(async()=>{await project()})})
  vi.mocked(api.scratch.listTopics).mockImplementation(async()=>[(await topics.read(workspace,topic.id))!])
  vi.mocked(api.scratch.readTopic).mockImplementation(async()=>topics.read(workspace,topic.id))
  vi.spyOn(api.motePreferences,'read').mockImplementation(input=>f.rpc.call('space.mote.preferences.read',input))
  vi.spyOn(api.moteDialogue,'read').mockImplementation(input=>f.rpc.call('space.mote.dialogue.read',input))
  const inspect=vi.spyOn(api.moteDialogue,'inspectSetup').mockImplementation(input=>f.rpc.call('space.mote.dialogue.setup.inspect',input))
  const advance=vi.spyOn(api.moteDialogue,'advanceSetup').mockImplementation(input=>f.rpc.call('space.mote.dialogue.setup.advance',input))
  vi.spyOn(api.spatial,'read').mockImplementation(()=>f.spatial.read())
  const open=vi.spyOn(api.spatial,'openAgent').mockImplementation(input=>f.rpc.call('agent.open',input))
  vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue()
  await project()
  const current=(await f.rpc.call('space.mote.dialogue.read',{target:f.target})).main.current!
  expect(useAppStore.getState().selectMainRegion(current)).toBe(true)
  await retainMoteMainCreationReference({target:f.target,operationId:oldId,deferredInput:{operationId:oldId+'_query',prompt:oldPrompt}},null)
  return{...f,scope,oldId,oldPrompt,original:structuredClone(record),current,inspect,advance,open,key:moteEntryDraftKey(scope),project}
}

it('actual App admits an independent new Query when old creation observation is unknown but its original binding is saved',async()=>{
  const f=await originalBoundQuery()
  await app!.mount();await settleMoteApp();await click(app!.container,'Discussion')
  await click(app!.container,'主 Agent');await click(document.body,'开始新一轮对话')
  const prompt='A separately new question for a separately new Main'
  await act(async()=>useLauncherState.getState().setDraft(f.key,'prompt',prompt))
  await wait(()=>expect(button(app!.container,'Send')?.disabled,app!.container.textContent??'').toBe(false))
  await click(app!.container,'Send')
  await wait(()=>expect(f.open).toHaveBeenCalledOnce())
  const request=f.open.mock.calls[0]![0]
  expect(request.operationId).not.toBe(f.oldId)
  expect(request.moteMain?.deferredInput?.prompt).toBe(prompt)
  expect(request.moteMain?.deferredInput?.operationId).not.toBe(f.oldId+'_query')
  await wait(()=>expect(f.advance).toHaveBeenCalled())
  const result=await f.advance.mock.results[0]!.value
  expect(f.advance).toHaveBeenCalledOnce()
  expect(result.record?.agentSessionId).not.toBe(f.current.sessionId)
  expect(result.record?.requestId).toBe(request.operationId)
  const old=spatialAgentOpenRecord((await f.spatial.read())!.graph,f.oldId)!
  expect(old).toEqual(f.original)
  expect(old.moteMain?.deferredInput).toEqual({operationId:f.oldId+'_query',prompt:f.oldPrompt})
  expect(result.record?.moteMain?.deferredInput).toMatchObject({prompt,operationId:request.moteMain!.deferredInput!.operationId})
  expect(result.reference?.sessionId).not.toBe(f.current.sessionId)
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  await facts({kind:'actual-new-query-admission',oldCreationId:f.oldId,oldInputOperationId:f.oldId+'_query',oldCreationObservation:'unconfirmed',oldBinding:'confirmed',
    oldInputObservation:old.moteMainFollowUps?.deferredInputObserved??null,oldInputKey:old.moteMainFollowUps?.deferredInputKey??null,
    oldRecordBefore:digest(f.original),oldRecordAfter:digest(old),newCreationId:request.operationId,newQueryOperationId:request.moteMain!.deferredInput!.operationId,
    newAgentSessionId:result.record!.agentSessionId,oldAgentSessionId:f.current.sessionId,newQueryStored:result.record?.moteMain?.deferredInput?.prompt===prompt,
    originalAdvanceCalls:f.advance.mock.calls.length,nativeCompletion:'not-claimed'})
},45000)

it('the shared creation projection excludes old bound input custody while keeping its original inspection',async()=>{
  const f=await originalBoundQuery(),readings:Array<{ready:boolean;pending:string[]}> = [],creations:string[][]=[]
  await app!.mount(<MoteDialogueViewProvider scope={f.scope} active><MoteMainActions scope={f.scope} active onConfigure={()=>{}}
    onPendingCreation={ids=>creations.push(ids)} renderStart={state=>{readings.push({ready:state.ready,pending:state.pending});return null}} /></MoteDialogueViewProvider>)
  await wait(()=>expect(readings.at(-1)?.pending).toContain(f.oldId))
  await wait(()=>expect(creations.at(-1)).toEqual([]))
  expect(readings.at(-1)?.ready).toBe(true)
  expect(readings.at(-1)?.pending).toContain(f.oldId)
  expect(f.inspect.mock.calls.some(([input])=>input.creation.operationId===f.oldId)).toBe(true)
  expect(f.open).not.toHaveBeenCalled()
})

it('a genuinely pending Core creation keeps its original inspection and does not admit a second creation',async()=>{
  const f=await originalBoundQuery(),pending='original-unconfirmed-creation'
  await f.start(pending,undefined,true);await f.project()
  expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)?.requestId).toBe(pending)
  const starts=f.h.started.length,inputs=f.h.inner.kernel.input.mock.calls.length
  const readiness:Array<{ready:boolean;operation:string|null}>=[]
  await app!.mount(<MoteDialogueViewProvider scope={f.scope} active><MoteMainActions scope={f.scope} active onConfigure={()=>{}}
    renderStart={state=>{readiness.push({ready:state.ready,operation:state.reading?.pendingOperationId??null});return null}} /></MoteDialogueViewProvider>)
  await wait(()=>expect(readiness.at(-1)?.operation).toBe(pending))
  expect(readiness.at(-1)?.ready).toBe(false)
  await click(app!.container,'Discussion');await click(app!.container,'主 Agent');await click(document.body,'开始新一轮对话')
  await act(async()=>useLauncherState.getState().setDraft(f.key,'prompt','Independent draft remains unsent while creation is unknown'))
  await wait(()=>expect(app!.container.querySelector('[data-main-original-request]')).not.toBeNull())
  expect(button(app!.container,'Send')?.disabled).toBe(true)
  await wait(()=>expect([...app!.container.querySelectorAll('code')].some(e=>e.textContent===pending)).toBe(true))
  const code=[...app!.container.querySelectorAll('code')].find(e=>e.textContent===pending)!,row=code.closest('div')!
  const detail=row.closest('details')!;await act(async()=>detail.querySelector('summary')!.click())
  const before=f.inspect.mock.calls.filter(([input])=>input.creation.operationId===pending).length
  await click(row,'核对原开始请求')
  await wait(()=>expect(f.inspect.mock.calls.filter(([input])=>input.creation.operationId===pending).length).toBeGreaterThan(before))
  expect(f.open).not.toHaveBeenCalled();expect(f.h.started).toHaveLength(starts)
  expect(f.h.inner.kernel.input.mock.calls).toHaveLength(inputs)
  expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe('Independent draft remains unsent while creation is unknown')
})

it('an original local creation with no acknowledgement stays a creation gate even beside a bound old question',async()=>{
  const f=await originalBoundQuery(),pending='local-original-create-unknown'
  await retainMoteMainCreationReference({target:f.target,operationId:pending},f.oldId)
  const readiness:Array<{ready:boolean;binding:string|null}>=[]
  await app!.mount(<MoteDialogueViewProvider scope={f.scope} active><MoteMainActions scope={f.scope} active onConfigure={()=>{}}
    renderStart={state=>{readiness.push({ready:state.ready,binding:state.reading?.previousCreation?.binding??null});return null}} /></MoteDialogueViewProvider>)
  await wait(()=>expect(readiness.at(-1)?.binding).toBe('confirmed'))
  expect(readiness.at(-1)?.ready).toBe(false)
  await click(app!.container,'Discussion');await click(app!.container,'主 Agent');await click(document.body,'开始新一轮对话')
  await act(async()=>useLauncherState.getState().setDraft(f.key,'prompt','Later draft for the unknown original creation'))
  await wait(()=>expect(app!.container.querySelector('[data-main-original-request]')?.textContent).toContain('核对原开始请求'))
  expect(button(app!.container,'Send')?.disabled).toBe(true)
  expect(useAppStore.getState().moteMainCreationReferences[JSON.stringify(f.target)]?.operationId).toBe(pending)
  expect(f.open).not.toHaveBeenCalled();expect(f.advance).not.toHaveBeenCalled()
})

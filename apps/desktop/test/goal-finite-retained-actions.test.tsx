// @vitest-environment happy-dom
import {act} from 'react'
import {beforeEach,expect,it,vi} from 'vitest'
import type {DemandSpaceMemberReference} from '@agentmux/demand/relations'
import type {Demand} from '@agentmux/demand'
import type {AgentMuxDemand} from '@agentmux/core/control'
import type {DemandProjection} from '../src/renderer/src/lib/global-demand-board'
import {GoalFiniteStartControl} from '../src/renderer/src/components/GoalFiniteStartControl'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {AgentMuxError} from '../../../packages/core/src/errors'
import {composerConfig,composerDOM,composerSession} from './helpers/composer-dom-fixture'

const dom=composerDOM(),target:DemandSpaceMemberReference={kind:'space-member',source:{runtimeId:'original-B',spaceId:'original-Space',regionId:'original-Region',admission:{kind:'creation',operationId:'original-C'}},execution:{runtimeId:'original-D',agentSessionId:'same-SID'}}
const goal=():DemandProjection & Demand & AgentMuxDemand=>({id:'original-Goal',title:'Retained finite task',description:'Current Goal text is different from the original input',status:'todo',priority:'normal',projectId:null,projectName:null,sessionIds:[target],assigneeSessionIds:[target],supervisorSessionId:null,createdAt:1,updatedAt:2,source:'default-topic',sessions:[],workspacePath:null,executorId:null,participations:[],tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,decisions:[],activities:[]})
beforeEach(()=>{useAppStore.setState({config:composerConfig,sessions:[composerSession('same-SID')],timelines:{},agentNames:{},goalFiniteStartIntents:{},agentComposerDrafts:{'same-SID':'Keep the original local neighbor input'}});vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{});vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{});vi.spyOn(useAppStore.getState(),'refreshDemand').mockResolvedValue()})

it('only an explicit original Resume sends the same qualified OP/reference/access, and Check never reconstructs or submits the frozen input',async()=>{
 const base=goal(),original={goalId:base.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'old-B'}},accessDraft:{source:{hostId:'current-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const}
 const dispatch={operationId:original.operationId,target,runId:'frozen-original-Run',prompt:'Original frozen body',agentMuxNote:'Original frozen note',execution:'finite' as const,preparedAt:1,stage:'unknown' as const},current={...base,dispatches:[dispatch]}
 const execute=vi.spyOn(api.goals,'execute').mockImplementation(async request=>request.operation==='demand.start'?{operation:'demand.start',demand:current,receipt:{demandId:base.id,startedAt:1,agentReference:target,run:{runId:'frozen-original-Run'}}}:{operation:'demand.show',demand:current,goalContinuations:[]})
 const legacy=vi.spyOn(api.demands,'inspectDispatch'),reconcile=vi.spyOn(api.demands,'reconcileDispatch')
 useAppStore.setState({goalFiniteStartIntents:{[base.id]:original},demands:{[base.id]:current}})
 const drafts=useAppStore.getState().agentComposerDrafts
 await dom.render(<GoalFiniteStartControl demand={current}/>)
 await vi.waitFor(()=>expect(execute).toHaveBeenCalled())
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
 const inspect=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Inspect original Start')!
 await vi.waitFor(()=>expect(inspect.disabled).toBe(false));await act(async()=>inspect.click())
 await vi.waitFor(()=>expect(inspect.disabled).toBe(false))
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
 const resume=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Continue original Start')
 expect(resume).toBeDefined();await act(async()=>{resume!.click();resume!.click()})
 const starts=execute.mock.calls.map(([request])=>request).filter(request=>request.operation==='demand.start')
 expect(starts).toEqual([{schemaVersion:5,requestId:'original-OP',operation:'demand.start',demandId:base.id,agentReference:target,access:original.accessDraft,resumeOriginal:true}])
 expect(legacy).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled()
 expect(useAppStore.getState().goalFiniteStartIntents[base.id]).toEqual(original);expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('an unreadable newer private intent remains a visible service window and cannot silently become a fresh Start for a same-SID relation',async()=>{
 const current=goal(),opaque={kind:'future-Goal-input',version:9,operationId:'future-original-OP',private:{draft:'Original future content'}}
 useAppStore.setState({goalFiniteStartIntents:{[current.id]:opaque as never},demands:{[current.id]:current}})
 const bytes=JSON.stringify(opaque),execute=vi.spyOn(api.goals,'execute')
 await dom.render(<GoalFiniteStartControl demand={current}/>)
 expect(dom.container.textContent).toContain('Original Start input is retained but cannot be read')
 expect([...dom.container.querySelectorAll('button')].some(button=>button.textContent?.startsWith('Start with'))).toBe(false)
 expect(execute).not.toHaveBeenCalled();expect(JSON.stringify(useAppStore.getState().goalFiniteStartIntents[current.id])).toBe(bytes)
 expect(useAppStore.getState().sessions[0]?.control).toMatchObject({agentSessionId:'same-SID',hostId:'local',run:{runId:'run-same-SID'}})
})

it('an older confirmed Check cannot clear a newer same-operation access edit or an opaque replacement private input',async()=>{
 for(const opaque of[false,true]){
  const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'original-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const}
  let release!:(result:unknown)=>void
  const pending=new Promise<unknown>(resolve=>{release=resolve}),execute=vi.spyOn(api.goals,'execute').mockImplementation(()=>pending as never)
  useAppStore.setState({goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current}})
  await dom.render(<GoalFiniteStartControl demand={current}/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
  const newer=opaque?{kind:'future',version:8,operationId:original.operationId,input:'Retain this opaque input'}:{...original,accessDraft:{source:{hostId:'new-current-B'}}}
  await act(async()=>useAppStore.setState({goalFiniteStartIntents:{[current.id]:newer as never}}))
  await act(async()=>release({operation:'demand.show',demand:{...current,dispatches:[{operationId:original.operationId,target,runId:'frozen-Run',execution:'finite',prompt:'Original body',preparedAt:1,stage:'confirmed'}]}}))
  expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(newer)
  expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
  await dom.render(<></>);execute.mockRestore()
 }
})

it('switching to another Goal while an old Check is deferred does not let the old presentation flight swallow the new original Check',async()=>{
 const first=goal(),second={...goal(),id:'another-Goal'},entry=(value:DemandProjection)=>({goalId:value.id,operationId:'OP-'+value.id,agentReference:target,access:{source:{hostId:'original-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const})
 let release!:(result:unknown)=>void
 const pending=new Promise<unknown>(resolve=>{release=resolve}),execute=vi.spyOn(api.goals,'execute').mockImplementation(request=>request.operation==='demand.show'&&request.demandId===first.id?pending as never:Promise.resolve({operation:'demand.show',demand:second,goalContinuations:[]}))
 useAppStore.setState({goalFiniteStartIntents:{[first.id]:entry(first),[second.id]:entry(second)},demands:{[first.id]:first,[second.id]:second}})
 const originals=useAppStore.getState().goalFiniteStartIntents
 await dom.render(<GoalFiniteStartControl demand={first}/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
 await dom.render(<GoalFiniteStartControl demand={second}/>);await vi.waitFor(()=>expect(execute.mock.calls.some(([request])=>request.operation==='demand.show'&&request.demandId===second.id)).toBe(true))
 await act(async()=>release({operation:'demand.show',demand:first}))
 expect(useAppStore.getState().goalFiniteStartIntents).toBe(originals)
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
 expect(dom.container.querySelector('[data-goal-finite-start]')?.getAttribute('data-goal-finite-start')).toBe(second.id)
})

it('the actual retained workface checks with only an independent Coordinator and never treats that read access as Source input qualification',async()=>{
 const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'original-B'}},accessDraft:{coordinator:{hostId:'independent-original-D'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const}
 const execute=vi.spyOn(api.goals,'execute').mockResolvedValue({operation:'demand.show',demand:current,goalContinuations:[]}),legacy=vi.spyOn(api.demands,'inspectDispatch')
 useAppStore.setState({goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current}})
 await dom.render(<GoalFiniteStartControl demand={current}/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalled())
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show'&&request.dispatchOperationId===original.operationId&&JSON.stringify(request.access)===JSON.stringify(original.accessDraft))).toBe(true)
 const resume=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Continue original Start')!
 await vi.waitFor(()=>expect(resume.disabled).toBe(false));await act(async()=>resume.click())
 expect(dom.container.textContent).toContain('Choose current project access before continuing')
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true);expect(legacy).not.toHaveBeenCalled()
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(original)
})

it('a hidden original workface does not query or dispatch until active, and activation checks the same operation without sending',async()=>{
 const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'original-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const},execute=vi.spyOn(api.goals,'execute').mockResolvedValue({operation:'demand.show',demand:current,goalContinuations:[]})
 useAppStore.setState({goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current}})
 await dom.render(<GoalFiniteStartControl demand={current} active={false}/>);expect(execute).not.toHaveBeenCalled()
 await dom.render(<GoalFiniteStartControl demand={current} active/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
 expect(execute.mock.calls[0]![0]).toMatchObject({operation:'demand.show',dispatchOperationId:original.operationId,access:original.access})
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(original)
})

it('new current access remains usable while an old Check is deferred, and the old finally cannot unlock the newer reader',async()=>{
 const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'old-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const}
 let releaseOld!:(result:unknown)=>void,releaseNew!:(result:unknown)=>void
 const oldRead=new Promise<unknown>(resolve=>{releaseOld=resolve}),newRead=new Promise<unknown>(resolve=>{releaseNew=resolve})
 const execute=vi.spyOn(api.goals,'execute').mockImplementationOnce(()=>oldRead as never).mockImplementationOnce(()=>newRead as never)
 useAppStore.setState({goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current}})
 try{
  await dom.render(<GoalFiniteStartControl demand={current}/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
  const {chooseField}=await import('./helpers/selection-field')
  await chooseField([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===`Project connection for ${target.source.spaceId}`)!,JSON.stringify({hostId:'local'}))
  const newer=useAppStore.getState().goalFiniteStartIntents[current.id]
  expect(newer).toMatchObject({...original,accessDraft:{source:{hostId:'local'}}})
  const check=()=>{const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Inspect original Start'||button.textContent==='Checking…');expect(button).toBeDefined();return button!}
  expect(check().disabled).toBe(false);await act(async()=>check().click())
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2))
  expect(execute.mock.calls[1]![0]).toMatchObject({operation:'demand.show',dispatchOperationId:original.operationId,access:{source:{hostId:'local'}}})
  expect(check().disabled).toBe(true)
  await act(async()=>releaseOld({operation:'demand.show',demand:current,goalContinuations:[]}))
  expect(check().disabled).toBe(true);expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(newer)
  await act(async()=>releaseNew({operation:'demand.show',demand:current,goalContinuations:[]}))
  await vi.waitFor(()=>expect(check().disabled).toBe(false))
  expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
 }finally{releaseOld({operation:'demand.show',demand:current,goalContinuations:[]});releaseNew({operation:'demand.show',demand:current,goalContinuations:[]})}
})

it('association input fields retain independently selected Source and Coordinator without probing or borrowing the healthy local namesake',async()=>{
 const association={...target,source:{...target.source,admission:{kind:'association' as const,operationId:'original-L'}}},current={...goal(),sessionIds:[association],assigneeSessionIds:[association]}
 useAppStore.setState({config:{...composerConfig,hosts:[...composerConfig.hosts,{id:'B-project',kind:'ssh',hostname:'project.invalid',label:'Project device B'},{id:'D-coordinator',kind:'ssh',hostname:'coordinator.invalid',label:'Original Coordinator'}]},demands:{[current.id]:current}})
 const execute=vi.spyOn(api.goals,'execute'),routes=vi.spyOn(api.hostRoutes,'call'),choices=vi.spyOn(api.spaceMounts,'call'),history=vi.spyOn(api.sessions,'historySource'),drafts=useAppStore.getState().agentComposerDrafts
 await dom.render(<GoalFiniteStartControl demand={current}/>);
 const {chooseField}=await import('./helpers/selection-field'),field=(label:string)=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===label)!
 await chooseField(field(`Project connection for ${association.source.spaceId}`),JSON.stringify({hostId:'B-project'}))
 const first=useAppStore.getState().goalFiniteStartIntents[current.id] as {operationId:string}
 await chooseField(field(`Coordinator connection for ${association.execution.runtimeId}`),JSON.stringify({hostId:'D-coordinator'}))
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toMatchObject({goalId:current.id,operationId:first.operationId,agentReference:association,phase:'not-attempted',access:{source:{hostId:'B-project'}},accessDraft:{source:{hostId:'B-project'},coordinator:{hostId:'D-coordinator'}}})
 expect(execute).not.toHaveBeenCalled();expect(routes).not.toHaveBeenCalled();expect(choices).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('an explicitly unsent qualified selection can review the current Goal version or be discarded, without changing its OP or sending a task',async()=>{
 const before=goal(),original={goalId:before.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'original-B'}},expectedUpdatedAt:before.updatedAt,phase:'not-attempted' as const},current={...before,description:'New visible Goal body',updatedAt:before.updatedAt+1}
 useAppStore.setState({goalFiniteStartIntents:{[before.id]:original},demands:{[before.id]:current}})
 const execute=vi.spyOn(api.goals,'execute')
 await dom.render(<GoalFiniteStartControl demand={current}/>);
 expect(dom.container.textContent).toContain('The Goal changed after this task selection')
 const update=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Use current Goal version for this task')!
 await act(async()=>update.click())
 expect(useAppStore.getState().goalFiniteStartIntents[before.id]).toMatchObject({...original,expectedUpdatedAt:current.updatedAt});expect(execute).not.toHaveBeenCalled()
 const discard=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Discard unsent selection')!
 await vi.waitFor(()=>expect(discard.disabled).toBe(false));await act(async()=>discard.click())
 expect(useAppStore.getState().goalFiniteStartIntents[before.id]).toBeUndefined();expect(execute).not.toHaveBeenCalled()
})

it('a confirmed task keeps future connection editing inside its collapsed start-another preparation',async()=>{
 const base=goal(),current={...base,dispatches:[{operationId:'delivered-OP',target,runId:'original-Run',prompt:'Original input',preparedAt:1,execution:'finite' as const,stage:'confirmed' as const}]},execute=vi.spyOn(api.goals,'execute')
 useAppStore.setState({demands:{[current.id]:current},goalFiniteStartIntents:{}})
 await dom.render(<GoalFiniteStartControl demand={current}/>);
 const another=dom.container.querySelector<HTMLDetailsElement>('.goal-finite-start__another')!
 expect(another).toBeDefined();expect(another.open).toBe(false)
 const field=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===`Project connection for ${target.source.spaceId}`)!
 expect(field).toBeDefined();expect(field.closest('details')).toBe(another)
 await act(async()=>{another.open=true;another.dispatchEvent(new Event('toggle'))})
 expect(field.closest('details:not([open])')).toBeNull()
 expect(execute).not.toHaveBeenCalled();expect(useAppStore.getState().goalFiniteStartIntents).toEqual({})
})

it('a Source-only Goal never scans the unrelated global Session index on render or an unrelated Session snapshot',async()=>{
 const presentation=await import('../src/renderer/src/lib/session-presentation'),scan=vi.spyOn(presentation,'agentSessionPresentationIndex'),current=goal()
 const sessions=Array.from({length:500},(_,i)=>composerSession('unrelated-'+i))
 useAppStore.setState({sessions,demands:{[current.id]:current}});scan.mockClear()
 await dom.render(<GoalFiniteStartControl demand={current}/>);
 expect(scan.mock.calls.length).toBe(0)
 useAppStore.setState({sessions:[...sessions,composerSession('another-unrelated')]})
 expect(scan.mock.calls.length).toBe(0)
})

it.each(['source-occurrence','goal'] as const)('a confirmed same-OP read for another %s cannot acknowledge or clear this private qualified target',async kind=>{
 const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'original-B'}},expectedUpdatedAt:1,phase:'may-have-dispatched' as const}
 const other={...target,source:{...target.source,regionId:'another-original-Region',admission:{kind:'creation' as const,operationId:'another-original-C'}}}
 const observed={...current,id:kind==='goal'?'another-Goal':current.id,dispatches:[{operationId:original.operationId,target:kind==='goal'?target:other,runId:'other-Run',prompt:'Another original input',preparedAt:1,execution:'finite' as const,stage:'confirmed' as const}]}
 const execute=vi.spyOn(api.goals,'execute').mockResolvedValue({operation:'demand.show',demand:observed,goalContinuations:[]})
 useAppStore.setState({goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current}})
 await dom.render(<GoalFiniteStartControl demand={current}/>);await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
 await vi.waitFor(()=>expect(dom.container.textContent).not.toContain('Checking…'))
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(original)
 expect(dom.container.textContent).toContain(kind==='goal'?'does not identify the original Goal':'record names another Source member')
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
})

it.each(['same-request','other-operation','other-target','other-initial-access','other-version','opaque','observed-domain'] as const)('late RPC-local not_applied preserves every qualified OP and current access; only exact Domain rejection permits replacement: %s',async kind=>{
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined)
 vi.spyOn(api.config,'get').mockRejectedValueOnce(Error('Private startup observation unavailable'))
 const close=await useAppStore.getState().initialize()
 const current=goal(),original={goalId:current.id,operationId:'original-OP',agentReference:target,access:{source:{hostId:'old-B'}},expectedUpdatedAt:current.updatedAt,phase:'not-attempted' as const}
 let reject!:(error:unknown)=>void
 const pending=new Promise<never>((_,no)=>{reject=no}),execute=vi.spyOn(api.goals,'execute').mockImplementation(request=>request.operation==='demand.start'?pending:Promise.resolve({operation:'demand.show',demand:current,goalContinuations:[]}))
 useAppStore.setState({config:composerConfig,goalFiniteStartIntents:{[current.id]:original},demands:{[current.id]:current},sessions:[composerSession('same-SID')],agentComposerDrafts:{'same-SID':'Keep this healthy local input'}})
 const drafts=useAppStore.getState().agentComposerDrafts
 try{
  await dom.render(<GoalFiniteStartControl demand={current}/>);
  const start=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Submit retained task')!
  await act(async()=>start.click());await vi.waitFor(()=>expect(execute.mock.calls.filter(([request])=>request.operation==='demand.start')).toHaveLength(1))
  const {chooseField}=await import('./helpers/selection-field')
  await chooseField([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===`Project connection for ${target.source.spaceId}`)!,JSON.stringify({hostId:'local'}))
  const edited=useAppStore.getState().goalFiniteStartIntents[current.id]
  expect(edited).toMatchObject({...original,phase:'may-have-dispatched',accessDraft:{source:{hostId:'local'}}})
  const retained=kind==='other-operation'?{...(edited as object),operationId:'newer-OP'}
   :kind==='other-target'?{...(edited as object),agentReference:{...target,source:{...target.source,regionId:'another-Region'}}}
   :kind==='other-initial-access'?{...(edited as object),access:{source:{hostId:'different-initial-B'}}}
   :kind==='other-version'?{...(edited as object),expectedUpdatedAt:current.updatedAt+1}
   :kind==='opaque'?{kind:'future',operationId:original.operationId,input:'Original future private bytes'}:edited
  if(kind==='observed-domain')useAppStore.setState({demands:{[current.id]:{...current,dispatches:[{operationId:original.operationId,target,runId:'observed-original-Run',prompt:'Original recorded body',preparedAt:1,execution:'finite',stage:'unknown'}]}}})
  else if(kind!=='same-request')await act(async()=>useAppStore.setState({goalFiniteStartIntents:{[current.id]:retained}}))
  await act(async()=>reject(new AgentMuxError('The original owner refused this attempt before preparing a Goal dispatch.','RUNTIME_OWNER_MISMATCH',undefined,{disposition:'not_applied',confirmedInputBytes:0})))
  expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toBe(retained)
  if(kind==='same-request'){
   expect(retained).toMatchObject({...original,phase:'may-have-dispatched',accessDraft:{source:{hostId:'local'}}})
   expect([...dom.container.querySelectorAll('button')].some(button=>button.textContent==='Submit retained task')).toBe(false)
  }
  expect(execute.mock.calls.filter(([request])=>request.operation==='demand.start')).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
 }finally{reject(Error('Private test closed'));await dom.render(<></>);await close()}
})

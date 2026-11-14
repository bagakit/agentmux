import {afterEach,expect,test,vi} from 'vitest'
import {createSpaceSessionsFixture} from './helpers/space-session-fixture.js'
import {observeSpaceSessionStates} from '../src/space-session-stream.js'
import {parseSpaceSessionsObservation} from '../src/space-session-codec.js'
import type {SpaceSessionsObservation} from '../src/space-sessions.js'
import type {AdoptedHostRoute} from '../src/host-route.js'
const cleanups:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks()})
const identity=(runtimeId:string)=>({runtimeId,publicKey:runtimeId+'-key',fingerprint:runtimeId+'-fingerprint'})
const route=(edge:string):AdoptedHostRoute=>({source:identity('runtime-b'),hops:[{edgeId:edge,target:identity('runtime-c')},{edgeId:'original-D',target:identity('runtime-d')}]})

test('the public Space producer preserves exact per-Region adopted paths for a same-SID member at multiple positions',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),sid='same-original-sid'
 await f.b.put(sid);await f.d.put(sid)
 const local=await f.admit('local','runtime-b',sid,'original-B'),first=await f.admit('D-in-B','runtime-d',sid,'original-D-via-C',route('original-C')),
  second=await f.admit('D-in-B','runtime-d',sid,'original-D-via-other-C',route('another-C')),
  third=await f.admit('D-in-B','runtime-d',sid,'original-D-third-C',route('third-C'))
 const observed:SpaceSessionsObservation[]=[],reader=await observeSpaceSessionStates(f.b.rpc,{reference:f.reference},{onObservation:event=>observed.push(event)})
 cleanups.push(()=>reader.dispose())
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.member.runtimeId==='runtime-d'&&event.state.status==='unknown')).toBe(true))
 const remote=observed.find(event=>event.type==='member'&&event.member.runtimeId==='runtime-d'&&event.state.status==='unknown')!
 expect(remote).toMatchObject({type:'member',state:{status:'unknown',issue:{code:'SPACE_SESSION_ROUTE_AMBIGUOUS'}},occurrences:expect.arrayContaining([
  {regionId:first.address.regionId,creationOperationId:first.requestId,projectRuntimeId:'runtime-b',agentRuntimeId:'runtime-d',executionRoute:{kind:'adopted',route:route('original-C')}},
  {regionId:second.address.regionId,creationOperationId:second.requestId,projectRuntimeId:'runtime-b',agentRuntimeId:'runtime-d',executionRoute:{kind:'adopted',route:route('another-C')}},
  {regionId:third.address.regionId,creationOperationId:third.requestId,projectRuntimeId:'runtime-b',agentRuntimeId:'runtime-d',executionRoute:{kind:'adopted',route:route('third-C')}}])})
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.member.runtimeId==='runtime-b'&&event.state.status==='observed')).toBe(true))
 expect(observed).toContainEqual(expect.objectContaining({type:'member',member:{hostId:'local',runtimeId:'runtime-b',agentSessionId:sid},occurrences:[{
  regionId:local.address.regionId,creationOperationId:local.requestId,projectRuntimeId:'runtime-b',agentRuntimeId:'runtime-b',executionRoute:{kind:'same'}}]}))
 expect((await f.b.spatial.read())!.graph.regions).toHaveLength(4)
 expect(JSON.stringify(observed)).not.toMatch(/private-token|private-binding|"prompt"|"env"|resourceGrant/)
 for(const core of [f.b,f.d]){expect(core.inventory).not.toHaveBeenCalled();expect(core.runs).not.toHaveBeenCalled();expect(core.all).not.toHaveBeenCalled()}
})

test('a new occurrence refreshes the original scoped member presentation without changing its Session or Run',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),sid='kept-local';const original=await f.b.put(sid)
 await f.admit('local','runtime-b',sid,'first-placement')
 const observed:SpaceSessionsObservation[]=[],reader=await observeSpaceSessionStates(f.b.rpc,{reference:f.reference},{onObservation:event=>observed.push(event)})
 cleanups.push(()=>reader.dispose())
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.state.status==='observed'&&event.occurrences?.length===1)).toBe(true))
 const second=await f.admit('local','runtime-b',sid,'second-placement')
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.state.status==='observed'&&event.occurrences?.length===2&&event.occurrences.some(item=>item.regionId===second.address.regionId))).toBe(true))
 const calls=vi.spyOn(f.b.hosted,'call'),state=(await f.b.spatial.read())!
 await f.b.spatial.commit({expectedRevision:state.revision,graph:{...state.graph,regions:[...state.graph.regions].reverse()}})
 await f.b.spatial.mutateDisplayLabel({operationId:'original-label-change',target:{kind:'tab',id:state.graph.tabs[0]!.tabId},value:'Original display label updated',source:'manual',expectedNameRevision:0},
  {actor:{kind:'user',id:'isolated-fixture-user',verified:true},source:'private-consumer',entryPoint:'source-label',transport:'unix',location:{spaceId:f.reference.spaceId}})
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='membership-complete'&&event.revision>state.revision)).toBe(true))
 await new Promise(resolve=>setTimeout(resolve,30))
 expect(calls.mock.calls.filter(([method])=>method==='runtime.bootstrap')).toEqual([])
 expect((await f.b.core.readAgentSession(sid))!.run).toEqual(original.run)
 expect(f.b.inventory).not.toHaveBeenCalled();expect(f.b.runs).not.toHaveBeenCalled()
})

test('old admission gaps stay unconfirmed and strict path metadata cannot claim a different source or execution Runtime',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),old=await f.admit('D-in-B','runtime-d','legacy-original','old-operation',route('original-C'))
 const state=(await f.b.spatial.read())!
 await f.b.spatial.commit({expectedRevision:state.revision,graph:{...state.graph,regions:state.graph.regions.map(region=>{
  if(region.regionId!==old.address.regionId)return region
  const{creationOperationId,...kept}=region;return kept
 })}})
 const observed:SpaceSessionsObservation[]=[],reader=await observeSpaceSessionStates(f.b.rpc,{reference:f.reference},{onObservation:event=>observed.push(event)})
 cleanups.push(()=>reader.dispose())
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.state.status==='unknown')).toBe(true))
 const event=observed.find(event=>event.type==='member'&&event.state.status==='unknown')!
 expect(event).toMatchObject({occurrences:[{regionId:old.address.regionId,executionRoute:{kind:'unconfirmed'}}]})
 if(event.type!=='member')throw Error('Expected original member')
 const opening=reader.initial,valid={...event,occurrences:[{regionId:old.address.regionId,projectRuntimeId:'runtime-b',agentRuntimeId:'runtime-d',executionRoute:{kind:'adopted',route:route('original-C')}}]}
 expect(parseSpaceSessionsObservation(valid,opening)).toEqual(valid)
 expect(()=>parseSpaceSessionsObservation({...valid,occurrences:[{...valid.occurrences[0],projectRuntimeId:'observer-A'}]},opening)).toThrow()
 expect(()=>parseSpaceSessionsObservation({...valid,occurrences:[{...valid.occurrences[0],agentRuntimeId:'another-D'}]},opening)).toThrow()
 expect(()=>parseSpaceSessionsObservation({...valid,occurrences:[valid.occurrences[0],valid.occurrences[0]]},opening)).toThrow()
 const{occurrences,...legacy}=event;expect(parseSpaceSessionsObservation(legacy,opening)).toEqual(legacy)
})

test('another Region cannot borrow an original CID path merely by sharing its SID and Tab',async()=>{
 const f=await createSpaceSessionsFixture(cleanups),sid='original-member'
 await f.d.put(sid)
 const original=await f.admit('D-in-B','runtime-d',sid,'original-operation',route('original-C'))
 const state=(await f.b.spatial.read())!,region=state.graph.regions.find(item=>item.regionId===original.address.regionId)!,copiedId='another-original-region'
 await f.b.spatial.commit({expectedRevision:state.revision,graph:{...state.graph,
  tabLayouts:{...state.graph.tabLayouts,[region.tabId]:{root:{type:'split',direction:'horizontal',ratio:0.5,first:{type:'leaf',regionId:region.regionId},second:{type:'leaf',regionId:copiedId}},activeRegionId:region.regionId}},
  regions:[...state.graph.regions,{...region,regionId:copiedId}],tabs:state.graph.tabs.map(tab=>tab.tabId===region.tabId?{...tab,regionIds:[...tab.regionIds,copiedId]}:tab)}})
 const observed:SpaceSessionsObservation[]=[],reader=await observeSpaceSessionStates(f.b.rpc,{reference:f.reference},{onObservation:event=>observed.push(event)})
 cleanups.push(()=>reader.dispose())
 await vi.waitFor(()=>expect(observed.some(event=>event.type==='member'&&event.occurrences?.some(item=>item.regionId===copiedId))).toBe(true))
 const occurrence=observed.flatMap(event=>event.type==='member'?event.occurrences??[]:[]).find(item=>item.regionId===copiedId)
 expect(occurrence).toMatchObject({regionId:copiedId,creationOperationId:original.requestId,executionRoute:{kind:'unconfirmed'}})
 expect((await f.b.spatial.read())!.graph.regions).toHaveLength(2)
})

test('an admission read in flight cannot publish an old occurrence under the new membership cut', async () => {
  const f = await createSpaceSessionsFixture(cleanups), sid = 'same-member-during-cut'
  const original = await f.d.put(sid)
  await f.admit('D-in-B', 'runtime-d', sid, 'first-original-cut')
  const observed: SpaceSessionsObservation[] = []
  const reader = await observeSpaceSessionStates(f.b.rpc, { reference: f.reference }, { onObservation: event => observed.push(event) })
  cleanups.push(() => reader.dispose())
  await vi.waitFor(() => expect(observed.some(event => event.type === 'member' && event.state.status === 'observed')).toBe(true))
  const first = observed.find(event => event.type === 'member' && event.state.status === 'observed')!
  const readOriginal = f.b.spatial.readForLayout.bind(f.b.spatial)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sourceRead = vi.spyOn(f.b.spatial, 'readForLayout').mockImplementationOnce(async () => { await gate; return await readOriginal() })
  let second: Awaited<ReturnType<typeof f.admit>>
  try {
    second = await f.admit('D-in-B', 'runtime-d', sid, 'second-original-cut')
    await vi.waitFor(() => expect(sourceRead).toHaveBeenCalled())
    observed.length = 0
    await f.d.put(sid, 2)
    await vi.waitFor(() => expect(observed.some(event => event.type === 'member' && event.state.status === 'observed' && event.state.session.updatedAt === 2)).toBe(true))
    const during = observed.find(event => event.type === 'member' && event.state.status === 'observed' && event.state.session.updatedAt === 2)!
    if (process.env.T005_PROOF) {
      const { writeFile } = await import('node:fs/promises'), { join } = await import('node:path')
      await writeFile(join(process.env.T005_PROOF, 'cut-race-observation.json'), JSON.stringify({ first, secondRegion: second.address.regionId,
        currentSourceRevision: (await f.b.spatial.read())!.revision, during }, null, 2))
    }
    expect(during.revision, 'unresolved source IO cannot relabel the still healthy D reader as a new B cut').toBe(first.revision)
    if (during.type !== 'member' || first.type !== 'member') throw Error('Expected original member observations')
    expect(during.occurrences).toEqual(first.occurrences)
  } finally { release() }
  await vi.waitFor(() => expect(observed.some(event => event.type === 'member' && event.state.status === 'observed' && event.revision > first.revision &&
    event.occurrences?.length === 2 && event.occurrences.some(item => item.regionId === second.address.regionId))).toBe(true))
  expect((await f.d.core.readAgentSession(sid))!.run).toEqual(original.run)
  expect(f.d.inventory).not.toHaveBeenCalled(); expect(f.d.runs).not.toHaveBeenCalled()
})

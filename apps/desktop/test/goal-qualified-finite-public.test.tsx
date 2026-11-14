// @vitest-environment happy-dom
import {installGoalFinitePublicBridge} from './helpers/goal-finite-public-bridge'
import {act} from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {createGoalQualifiedPublicFixture} from './helpers/goal-qualified-public-fixture'
import {GoalFiniteStartControl} from '../src/renderer/src/components/GoalFiniteStartControl'
import type {DemandProjection} from '../src/renderer/src/lib/global-demand-board'
import {useAppStore} from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import {composerConfig,composerDOM,composerSession} from './helpers/composer-dom-fixture'
import {chooseField} from './helpers/selection-field'
import {readGoalFiniteStartIntent} from '../src/renderer/src/lib/goal-finite-start'

const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs()})
function Finite({goalId}:{goalId:string}){const goal=useAppStore(state=>state.demands[goalId]);return goal?<GoalFiniteStartControl demand={goal} primary/>:null}

it('fresh Source choice → actual finite component/Store → formal Preload/Main → Unix Goal/Core, read-only Check and explicit same-OP Resume keep one canonical input',async()=>{
 const f=await createGoalQualifiedPublicFixture(cleanup),bridge=installGoalFinitePublicBridge(f.rpc)
 const provider=f.d.core.providers.get('codex'),prepare=provider.prepareNativeInput!
 let release!:()=>void
 const held=new Promise<void>(resolve=>{release=resolve})
 provider.prepareNativeInput=async(...args)=>{await held;return await prepare(...args)}
 cleanup.push(()=>{release();provider.prepareNativeInput=prepare})
 vi.spyOn(api.goals,'execute').mockImplementation(bridge.api.goals.execute)
 vi.spyOn(api.demands,'list').mockImplementation(bridge.api.demands.list)
 vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{})
 vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{})
 // Browser user-document storage is used here. Its flush is not presented as
 // the actual App/native file-restart proof, which has a separate owner.
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined)
 // Open the original Store's persistence fence through its real hydration path.
 // The unrelated startup configuration observer is an explicit failing leaf;
 // it must not substitute for or disable the later exact Goal/Core operation.
 vi.spyOn(api.config,'get').mockRejectedValueOnce(Error('Private startup configuration observation unavailable'))
 cleanup.push(await useAppStore.getState().initialize())
 const goal:DemandProjection={...f.goal,source:'default-topic',sessions:[],workspacePath:null}
 useAppStore.setState({config:composerConfig,demands:{[goal.id]:goal},sessions:[composerSession(f.session.agentSessionId)],timelines:{},agentNames:{},goalFiniteStartIntents:{},agentComposerDrafts:{[f.session.agentSessionId]:'Keep the local namesake input'}})
 const drafts=useAppStore.getState().agentComposerDrafts
 await dom.render(<Finite goalId={goal.id}/>)
 const field=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')===`Project connection for ${f.reference.source.spaceId}`)!
 await chooseField(field,JSON.stringify({hostId:'local'}))
 const original=readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[goal.id],goal.id)!
 expect(original).toMatchObject({goalId:goal.id,agentReference:f.reference,access:f.access,phase:'not-attempted'})
 expect(f.send).not.toHaveBeenCalled();expect(bridge.requests.some(call=>call.channel==='goals:execute'&&(call.input as {operation?:string}).operation==='demand.start')).toBe(false)
 const submit=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Submit retained task')!
 expect(submit).toBeDefined();await act(async()=>{submit.click();submit.click()})
 const key={kind:'prompt' as const,agentSessionId:f.session.agentSessionId,expectedRun:f.session.run,submissionId:original.operationId}
 await expect.poll(async()=>(await f.goals.demands.inspectDispatch(goal.id,original.operationId))?.stage).toBe('unknown')
 await vi.waitFor(()=>expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].some(button=>button.textContent==='Inspect original Start'&&!button.disabled)).toBe(true))
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Inspect original Start')!.click())
 await vi.waitFor(()=>expect(bridge.requests.some(call=>call.channel==='goals:execute'&&(call.input as {operation?:string}).operation==='demand.show')).toBe(true))
 expect(f.send).not.toHaveBeenCalled()
 expect(bridge.requests.filter(call=>call.channel==='goals:execute'&&(call.input as {operation?:string}).operation==='demand.start')).toHaveLength(1)
 await vi.waitFor(()=>expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].some(button=>button.textContent==='Inspect original Start'&&!button.disabled)).toBe(true))
 release()
 try{await expect.poll(async()=>(await f.d.core.inspectAgentInput({key}))?.status).toBe('admitted')}
 catch(error){throw Error(JSON.stringify({ui:dom.container.textContent,requests:bridge.requests,original:useAppStore.getState().goalFiniteStartIntents[goal.id],dispatch:await f.goals.demands.inspectDispatch(goal.id,original.operationId),input:await f.d.core.inspectAgentInput({key})}),{cause:error})}
 await vi.waitFor(()=>expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].some(button=>button.textContent==='Continue original Start'&&!button.disabled)).toBe(true))
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Continue original Start')!.click())
 await expect.poll(async()=>(await f.goals.demands.inspectDispatch(goal.id,original.operationId))?.stage).toBe('confirmed')
 const starts=bridge.requests.filter(call=>call.channel==='goals:execute'&&(call.input as {operation?:string}).operation==='demand.start')
 expect(starts).toHaveLength(2);expect(starts[0]!.input).toMatchObject({requestId:original.operationId,agentReference:f.reference,access:f.access})
 expect(starts[1]!.input).toEqual({schemaVersion:5,requestId:original.operationId,operation:'demand.start',demandId:goal.id,agentReference:f.reference,access:f.access,resumeOriginal:true})
 expect(starts[0]!.input).not.toHaveProperty('sessionId')
 const saved=(await f.goals.demands.inspectDispatch(goal.id,original.operationId))!
 expect(saved).toMatchObject({target:f.reference,runId:f.session.run.runId,execution:'finite',prompt:goal.description,stage:'confirmed',receipt:{kind:'core-input',inputKey:key,outcome:'admitted'}})
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.raw).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
 expect(f.b.inventory).not.toHaveBeenCalled();expect(f.d.inventory).not.toHaveBeenCalled();expect(f.b.runs).not.toHaveBeenCalled();expect(f.d.runs).not.toHaveBeenCalled()
 expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
 expect((await f.d.core.readAgentSession(f.session.agentSessionId))?.run).toEqual(f.session.run)
})

it('the original healthy legacy local task still reaches the same Core through formal Preload/Main, with raw SID and original Run unchanged',async()=>{
 const f=await createGoalQualifiedPublicFixture(cleanup,true),bridge=installGoalFinitePublicBridge(f.rpc)
 vi.spyOn(api.goals,'execute').mockImplementation(bridge.api.goals.execute)
 vi.spyOn(api.demands,'list').mockImplementation(bridge.api.demands.list)
 vi.spyOn(api.demands,'inspectDispatch').mockImplementation(bridge.api.demands.inspectDispatch)
 vi.spyOn(api.demands,'reconcileDispatch').mockImplementation(bridge.api.demands.reconcileDispatch)
 vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{});vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{})
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined);vi.spyOn(api.config,'get').mockRejectedValueOnce(Error('Private startup configuration observation unavailable'))
 cleanup.push(await useAppStore.getState().initialize())
 const updated=await f.goals.demands.update(f.goal.id,{sessionIds:[f.session.agentSessionId],assigneeSessionIds:[f.session.agentSessionId]}),goal:DemandProjection={...updated.demand,source:'default-topic',sessions:[],workspacePath:null}
 useAppStore.setState({config:composerConfig,demands:{[goal.id]:goal},sessions:[composerSession(f.session.agentSessionId)],timelines:{},agentNames:{},goalFiniteStartIntents:{},agentComposerDrafts:{[f.session.agentSessionId]:'Keep the original legacy draft'}})
 const drafts=useAppStore.getState().agentComposerDrafts
 await dom.render(<Finite goalId={goal.id}/>);
 expect(dom.container.querySelector('[aria-label^="Project connection for"]')).toBeNull()
 const start=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.startsWith('Start with'))!
 expect(start).toBeDefined();await act(async()=>{start.click();start.click()})
 try{await expect.poll(async()=>(await f.goals.demands.get(goal.id))?.dispatches?.[0]?.stage).toBe('confirmed')}
 catch(error){throw Error(JSON.stringify({ui:dom.container.textContent,requests:bridge.requests,dispatches:(await f.goals.demands.get(goal.id))?.dispatches,intent:useAppStore.getState().goalFiniteStartIntents[goal.id],send:f.send.mock.calls.length}),{cause:error})}
 const original=(await f.goals.demands.get(goal.id))!.dispatches![0]!
 expect(original).toMatchObject({agentSessionId:f.session.agentSessionId,hostId:'local',runId:f.session.run.runId,execution:'finite'});expect(original).not.toHaveProperty('target')
 const requests=bridge.requests.filter(call=>call.channel==='goals:execute'&&(call.input as {operation?:string}).operation==='demand.start')
 expect(requests).toHaveLength(1);expect(requests[0]!.input).toMatchObject({sessionId:f.session.agentSessionId,requestId:original.operationId});expect(requests[0]!.input).not.toHaveProperty('agentReference');expect(requests[0]!.input).not.toHaveProperty('access')
 const writes=f.raw.mock.calls as unknown as Array<[string,{data:string}]>
 expect(f.send).not.toHaveBeenCalled();expect(writes).toHaveLength(2)
 expect(writes.every(([runId])=>runId===f.session.run.runId)).toBe(true)
 expect(writes.filter(([,input])=>input.data.includes(goal.description))).toHaveLength(1)
 expect((await f.d.core.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:f.session.agentSessionId,expectedRun:f.session.run,submissionId:original.operationId}))?.admission?.acknowledged).toBe(true)
 expect(f.stop).not.toHaveBeenCalled()
 expect((await f.d.core.readAgentSession(f.session.agentSessionId))?.run).toEqual(f.session.run)
 expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
 await vi.waitFor(()=>expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBeUndefined())
})

// @vitest-environment happy-dom
import { installGoalFinitePublicBridge } from './helpers/goal-finite-public-bridge'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createGoalQualifiedPublicFixture } from './helpers/goal-qualified-public-fixture'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'
import { readGoalFiniteStartIntent } from '../src/renderer/src/lib/goal-finite-start'
const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllEnvs()})
function Finite({id}:{id:string}){const goal=useAppStore(s=>s.demands[id]);return goal?<GoalFiniteStartControl demand={goal}/>:null}
async function setup(old=false){
 const f=await createGoalQualifiedPublicFixture(cleanup),bridge=installGoalFinitePublicBridge(f.rpc)
 await f.d.store.admitRecoveryInputCut({operationId:'private-fixture-restore',sourceSHA256:'a'.repeat(64)})
 await f.d.inner.registry.load('local')
 const epoch=await f.d.core.readAgentInputEpoch();expect(epoch).toBeTruthy()
 const read=vi.spyOn(api.demands,'inputEpoch').mockImplementation(bridge.api.demands.inputEpoch)
 vi.spyOn(api.goals,'execute').mockImplementation(bridge.api.goals.execute)
 vi.spyOn(api.demands,'list').mockImplementation(bridge.api.demands.list)
 vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{});vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{})
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined);vi.spyOn(api.config,'get').mockRejectedValueOnce(Error('Private startup configuration observer unavailable'))
 cleanup.push(await useAppStore.getState().initialize())
 const goal={...f.goal,source:'default-topic' as const,sessions:[],workspacePath:null}
 const original={goalId:goal.id,operationId:'old-frozen-start',agentReference:f.reference,access:f.access,expectedUpdatedAt:goal.updatedAt,phase:'not-attempted' as const}
 useAppStore.setState({config:composerConfig,demands:{[goal.id]:goal},sessions:[composerSession(f.session.agentSessionId)],goalFiniteStartIntents:old?{[goal.id]:original}:{},agentNames:{},timelines:{}})
 return{f,bridge,goal,epoch,read,original}
}
it('fresh qualified task freezes the real execution namespace before OP birth and reaches the same public Core input once',async()=>{
 const {f,bridge,goal,epoch,read}=await setup()
 await dom.render(<Finite id={goal.id}/>)
 const field=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')===`Project connection for ${f.reference.source.spaceId}`)!
 await chooseField(field,JSON.stringify({hostId:'local'}))
 const saved=readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[goal.id],goal.id)!
 expect(saved).toMatchObject({phase:'not-attempted',agentReference:f.reference,inputEpoch:epoch});expect(saved.operationId).toBeTruthy();expect(read).toHaveBeenCalledTimes(1);expect(f.send).not.toHaveBeenCalled()
 const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Submit retained task')!;expect(button).toBeDefined()
 await act(async()=>button.click())
 await expect.poll(async()=>(await f.d.core.inspectAgentInput({key:{kind:'prompt',agentSessionId:f.session.agentSessionId,expectedRun:f.session.run,submissionId:saved.operationId!}}))?.status).toBe('admitted')
 await vi.waitFor(()=>expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].some(b=>b.textContent==='Continue original Start'&&!b.disabled)).toBe(true))
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Continue original Start')!.click())
 await expect.poll(async()=>(await f.goals.demands.inspectDispatch(goal.id,saved.operationId!))?.stage).toBe('confirmed')
 expect(bridge.requests.find(x=>x.channel==='goals:execute'&&(x.input as {operation?:string}).operation==='demand.start')?.input).toMatchObject({inputEpoch:epoch,requestId:saved.operationId})
 expect(await f.goals.demands.inspectDispatch(goal.id,saved.operationId!)).toMatchObject({inputEpoch:epoch,stage:'confirmed'})
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.raw).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
})
it('an old qualified operation remains missing its cut and the real E1 owner rejects it without Native input',async()=>{
 const {f,goal,read,original}=await setup(true)
 await dom.render(<Finite id={goal.id}/>)
 const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Submit retained task')!;expect(button).toBeDefined()
 await act(async()=>button.click())
 await expect.poll(async()=>(await f.goals.demands.inspectDispatch(goal.id,original.operationId))?.stage).toBe('unknown')
 expect(read).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.raw).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
 expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toMatchObject({operationId:original.operationId});expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).not.toHaveProperty('inputEpoch')
})

// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useScheduleOperation } from '../src/renderer/src/lib/schedule-controller'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
const dom=composerDOM(),target={hostId:'local',agentSessionId:'recipient',providerId:'codex',workspacePath:'/fixture'}
const request={action:'create' as const,params:{target,everyMs:60_000,prompt:'original message',operationId:'original-create'}}
const receipt=(p:typeof request.params&{inputEpoch?:string})=>({executionScope:'connected-host' as const,diskDurability:'confirmed' as const,schedule:{everyMs:p.everyMs,prompt:p.prompt,...(p.inputEpoch===undefined?{}:{inputEpoch:p.inputEpoch}),...target,loopId:'original-loop',creationOperationId:p.operationId,futureIntentId:'original-intent',revision:1,status:'active' as const,intervalMs:60_000,nextCheckAt:60_000}})
beforeEach(()=>{useLauncherState.setState({drafts:{},persistenceIssue:null});vi.spyOn(api.schedule,'list').mockResolvedValue({executionScope:'connected-host',schedules:[]})})
it.each(['current',undefined])('first calendar gesture freezes %s exactly once, then retries the retained original pending without renewing it',async epoch=>{
 const reader=vi.spyOn(api.sessions,'readInputEpoch').mockImplementation(async()=>{if(epoch===undefined)throw Error('unconfirmed');return epoch})
 const saved=vi.spyOn(api.schedule,'create').mockRejectedValueOnce(Error('unknown receipt')).mockImplementation(async p=>receipt(p))
 let operation!:ReturnType<typeof useScheduleOperation>
 function Form(){operation=useScheduleOperation('test-original',()=>{});return <button onClick={()=>void operation.perform(request)}>Create</button>}
 await dom.render(<Form/>);await dom.click('button')
 await vi.waitFor(()=>expect(operation.busy).toBe(false))
 expect(reader).toHaveBeenCalledTimes(1);expect(reader).toHaveBeenCalledWith('local')
 const frozen=structuredClone(useLauncherState.getState().drafts['test-original']?.schedule?.pending)
 expect(frozen?.params).toEqual({...request.params,...(epoch===undefined?{}:{inputEpoch:epoch})})
 reader.mockResolvedValue('newer-cut')
 // Even a re-rendered caller offering another token for the same identity cannot replace custody.
 await act(async()=>{await operation.perform({...request,params:{...request.params,inputEpoch:'caller-newer'}})})
 expect(reader).toHaveBeenCalledTimes(1);expect(saved.mock.calls.map(([p])=>p)).toEqual([frozen!.params,frozen!.params])
 expect(useLauncherState.getState().drafts['test-original']?.schedule?.pending).toBeUndefined()
 expect(dom.draft()).toBe('Keep my draft')
})
it('retained pre-epoch calendar request is never freshened after reload',async()=>{
 useLauncherState.getState().setScheduleDraft('old-original',{pending:request})
 const reader=vi.spyOn(api.sessions,'readInputEpoch').mockResolvedValue('restored-now')
 const saved=vi.spyOn(api.schedule,'create').mockImplementation(async p=>receipt(p))
 let operation!:ReturnType<typeof useScheduleOperation>
 function Form(){operation=useScheduleOperation('old-original',()=>{});return <button/>}
 await dom.render(<Form/>);await act(async()=>{await operation.perform(request)})
 expect(reader).not.toHaveBeenCalled();expect(saved).toHaveBeenCalledExactlyOnceWith(request.params)
})
it.each(['current',undefined])('first progress UI gesture passes the frozen %s through original create IPC arguments',async epoch=>{
 vi.spyOn(api.continuousProgress,'list').mockResolvedValue([])
 const reader=vi.spyOn(api.sessions,'readInputEpoch').mockImplementation(async()=>{if(epoch===undefined)throw Error('unconfirmed');return epoch})
 const created=vi.spyOn(api.continuousProgress,'create').mockImplementation(async(t,intervalMs,prompt,_source,inputEpoch)=>({...t,intervalMs,prompt,...(inputEpoch===undefined?{}:{inputEpoch}),loopId:'new-progress',status:'active',nextCheckAt:1}))
 await dom.render(<ContinuousProgressControl session={composerSession('recipient')} />)
 await vi.waitFor(()=>expect(api.continuousProgress.list).toHaveBeenCalled())
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.textContent==='New automation')!.click())
 await dom.click('[aria-label="Automation type"] input[value="progress"]')
 const input=dom.container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'new explicit progress');input.dispatchEvent(new Event('input',{bubbles:true}))})
 const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.textContent==='Enable continuous progress')!
 expect(button).toBeDefined();await act(async()=>button.click())
 await vi.waitFor(()=>expect(created).toHaveBeenCalledTimes(1))
 expect(reader).toHaveBeenCalledExactlyOnceWith('local')
 expect(created.mock.calls[0]![4]).toBe(epoch);expect(created.mock.calls[0]![2]).toBe('new explicit progress')
})

it('a new schedule freezes its exact namespace before the original business request is first persisted', async () => {
 const held=Promise.withResolvers<string|null>()
 const reader=vi.spyOn(api.sessions,'readInputEpoch').mockReturnValue(held.promise)
 const saved=vi.spyOn(api.schedule,'create').mockRejectedValue(Error('original receipt unknown'))
 let operation!:ReturnType<typeof useScheduleOperation>
 function Form(){operation=useScheduleOperation('first-freeze',()=>{});return <button onClick={()=>void operation.perform(request)}>Create</button>}
 await dom.render(<Form/>);await dom.click('button')
 await vi.waitFor(()=>expect(reader).toHaveBeenCalledTimes(1))
 expect(useLauncherState.getState().drafts['first-freeze']?.schedule?.pending).toBeUndefined()
 expect(saved).not.toHaveBeenCalled();expect(dom.draft()).toBe('Keep my draft')
 await act(async()=>held.resolve('original-before-request-cut'))
 await vi.waitFor(()=>expect(operation.busy).toBe(false))
 const frozen=useLauncherState.getState().drafts['first-freeze']?.schedule?.pending
 expect(frozen).toEqual({...request,params:{...request.params,inputEpoch:'original-before-request-cut'}})
 reader.mockResolvedValue('later-after-restart-cut')
 await act(async()=>{await operation.perform(request)})
 expect(reader).toHaveBeenCalledTimes(1);expect(saved.mock.calls.map(([p])=>p)).toEqual([frozen!.params,frozen!.params])
})

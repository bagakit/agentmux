// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import * as core from '../../../packages/core/src/index.js'
import { fixture, closes, native, append, imageBlock, imageOperation, imageWrites } from '../../../packages/connectors/test/fixtures/publication-source-owner.js'
import { context } from '../../../packages/connectors/test/fixtures/room-binding.js'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { api } from '../src/renderer/src/lib/api'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom=composerDOM()
const wait=(read:()=>unknown|Promise<unknown>)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,10))});await read()},{timeout:9_000,interval:25})
async function consumer(mode:'message'|'upload'|'unknown'='message'){
 const f=await fixture(),starts=vi.spyOn(f.inner.kernel,'start')
 if(mode==='message')f.remote.controls.imageMessageFailures=[230020,230020,230020]
 if(mode==='upload')f.remote.controls.missingUploadKey=true
 if(mode==='unknown')f.remote.controls.unknownImageMessage=true
 await append(f,native('ui-original-source',[imageBlock()]));f.services.publication!.refresh()
 await wait(()=>expect(imageOperation(f)?.state).toBe(mode==='unknown'?'unknown':'not-applied'))
 const operationId=imageOperation(f)!.operationId,hostingTarget={hostId:'local',runtimeId:'original-image-runtime'}
 const hosted=await core.connectHostedAgentMux({rpc:f.rpc,waitForReady:false,forwardRpc:(method,params,context={},expected)=>f.rpc.call(method,params,{...(context.signal?{signal:context.signal}:{}),...(expected??context.runtimeFence?{runtimeFence:expected??context.runtimeFence}:{})})});closes.push(()=>hosted.dispose())
 vi.spyOn(hosted,'connect').mockRejectedValue(Error('Only startup observation is controlled'))
 const controller=new RuntimeController(f.store,async()=>hosted);closes.push(()=>controller.dispose());controller.commit(await controller.prepare(composerConfig))
 const handlers=new Map<string,(...args:any[])=>Promise<unknown>>(),trusted=vi.fn()
 registerConnectorIpc({handleWithEvent:(name,handler)=>handlers.set(name,handler),assertTrusted:trusted,runtime:controller,metadata:{publish(){},observation(){}}})
 const calls:Array<{method:string;input:any;target:any}>=[];let drop=false,hold:Promise<void>|undefined,release=()=>{}
 closes.push(()=>release())
 const bridge=vi.spyOn(api.connections,'call').mockImplementation(async(method,input,target)=>{calls.push({method,input:structuredClone(input),target:structuredClone(target)});const result=await handlers.get('connections:call')!({},method,input,target);if(method==='connection.delivery.retry'){if(drop){drop=false;throw Error('Original Host acceptance reply lost')}await hold}return unwrapSessionInputOperationResult(structuredClone(result)) as any})
 vi.spyOn(api.config,'get').mockResolvedValue(composerConfig)
 useAppStore.setState({connectorRoomIntents:{},agentComposerDrafts:{'original-agent':'Keep original source draft'}})
 const mount=()=>dom.render(<ConnectorDeliveryDetails binding={f.binding} hostingTarget={hostingTarget}/>)
 async function select(){
  await wait(()=>expect([...dom.container.querySelectorAll('.agent-connector-receipt code')].some(n=>n.textContent===operationId)).toBe(true))
  const row=[...dom.container.querySelectorAll('.agent-connector-receipt')].find(n=>n.querySelector('code')?.textContent===operationId)!
  await act(async()=>row.querySelector<HTMLButtonElement>('button')!.click())
  await wait(()=>expect(dom.container.querySelector('[data-selected-delivery]')?.getAttribute('data-selected-delivery')).toBe(operationId))
 }
 const record=()=>f.rpc.call('connection.delivery.inspect',{operationId}).then(r=>r.delivery!)
 const unchanged=()=>{expect(starts).not.toHaveBeenCalled();expect(f.inner.kernel.input).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep original source draft');expect(trusted).toHaveBeenCalled()}
 const facts=()=>{if(process.env.DELIVERY_RETRY_UI_FACTS)appendFileSync(process.env.DELIVERY_RETRY_UI_FACTS,JSON.stringify({case:expect.getState().currentTestName,operationId,hostingTarget,calls,imageWrites:imageWrites(f).length,uploads:f.remote.uploads.length,starts:starts.mock.calls.length,stops:f.inner.kernel.stop.mock.calls.length,intents:Object.values(useAppStore.getState().connectorRoomIntents)})+'\n')}
 return{...f,operationId,hostingTarget,calls,bridge,mount,select,record,unchanged,facts,drop:()=>{drop=true},hold(){hold=new Promise<void>(resolve=>{release=resolve})},release(){hold=undefined;release()}}
}
it('retains the submitted source after a lost reply and a later edge, and only a new click consumes the new failure',async()=>{
 const f=await consumer();await f.mount();await f.select();f.drop();await dom.click('[data-delivery-action="retry"]')
 await wait(()=>expect(dom.container.textContent).toContain('Retry reply unconfirmed'))
 const original=f.calls.find(c=>c.method==='connection.delivery.retry')!
 await wait(()=>expect(imageOperation(f)).toMatchObject({state:'not-applied',attempt:2}))
 const second=await f.record(),otherInput={operationId:f.operationId,source:second.retrySource!};await f.managed.call('connection.delivery.retry',otherInput)
 await wait(()=>expect(imageOperation(f)).toMatchObject({state:'not-applied',attempt:3}))
 await dom.render(null);await f.mount();await f.select()
 expect(f.calls.filter(c=>c.method==='connection.delivery.retry')).toHaveLength(1)
 expect(dom.container.textContent).toContain('Original retry result unconfirmed')
 // Another UI producer records a real accepted edge. Its history must not
 // replace this still-selected original source, even for the same operation.
 await act(async()=>{await retainConnectorRoomIntent({method:'connection.delivery.retry',input:otherInput,target:{executionHostId:f.binding.executionHostId,agentSessionId:f.binding.agentSessionId},hostingTarget:f.hostingTarget,phase:'may-have-dispatched'})})
 await dom.click('[data-delivery-action="continue"]')
 await wait(()=>expect(f.calls.filter(c=>c.method==='connection.delivery.retry')).toHaveLength(2))
 expect(f.calls.filter(c=>c.method==='connection.delivery.retry')).toEqual([original,original])
 expect(imageWrites(f)).toHaveLength(3)
 await wait(()=>expect(dom.container.textContent).toContain('Retry accepted'))
 await dom.click('[data-delivery-action="retry"]');await wait(()=>expect(imageOperation(f)).toMatchObject({state:'confirmed',attempt:4}))
 const latest=f.calls.filter(c=>c.method==='connection.delivery.retry').at(-1)!
 expect(latest.input).toEqual({operationId:f.operationId,source:{kind:'message',attempt:3}});expect(latest.target).toEqual(original.target)
 expect(Object.values(useAppStore.getState().connectorRoomIntents).filter(i=>i.method==='connection.delivery.retry').map(i=>i.input)).toEqual([original.input,otherInput,latest.input])
 const selected=dom.container.querySelector<HTMLSelectElement>('[aria-label="Submitted retry source"]')!
 await act(async()=>{selected.value=selected.options[0]!.value;selected.dispatchEvent(new Event('change',{bubbles:true}))})
 await dom.click('[data-delivery-action="continue"]');await wait(()=>expect(f.calls.filter(c=>c.method==='connection.delivery.retry')).toHaveLength(4))
 expect(f.calls.filter(c=>c.method==='connection.delivery.retry').at(-1)).toEqual(original)
 expect(imageWrites(f)).toHaveLength(4);f.unchanged();f.facts()
})
it('retries the owner-qualified original upload without creating another delivery or treating upload uncertainty as a message effect',async()=>{
 const f=await consumer('upload');await f.mount();await f.select();expect(dom.container.textContent).toContain('Retry upload');expect(imageWrites(f)).toHaveLength(0)
 f.remote.controls.missingUploadKey=false;await dom.click('[data-delivery-action="retry"]')
 await wait(()=>expect(imageOperation(f)?.state).toBe('confirmed'))
 expect(f.calls.find(c=>c.method==='connection.delivery.retry')?.input).toEqual({operationId:f.operationId,source:{kind:'content-upload',attempt:1}})
 expect(f.remote.uploads).toHaveLength(2);expect(imageWrites(f)).toHaveLength(1);f.unchanged();f.facts()
})
it('unknown message effects stay inspect-only and details only inspect the explicitly selected original record',async()=>{
 const f=await consumer('unknown');await f.mount()
 expect(f.calls.filter(c=>c.method==='connection.delivery.inspect')).toHaveLength(0)
 await f.select();expect(f.calls.filter(c=>c.method==='connection.delivery.inspect')).toHaveLength(1)
 expect(dom.container.querySelector('[data-delivery-action="retry"]')).toBeNull();expect(dom.container.querySelector('[data-delivery-action="continue"]')).toBeNull()
 await dom.click('[data-delivery-action="inspect"]')
 expect(f.calls.filter(c=>c.method==='connection.delivery.inspect')).toHaveLength(2)
 expect(f.calls.filter(c=>c.method==='connection.delivery.retry')).toHaveLength(0);expect(imageWrites(f)).toHaveLength(1);f.unchanged();f.facts()
})
it('local correlation write failure preserves the complete source in memory without gating the original authorized action',async()=>{
 const f=await consumer();await f.mount();await f.select();f.remote.controls.imageMessageFailures=[]
 const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Controlled local request persistence failure')})
 await dom.click('[data-delivery-action="retry"]');await wait(()=>expect(imageOperation(f)?.state).toBe('confirmed'))
 await wait(()=>expect(dom.container.textContent).toContain('Local request copy unconfirmed'))
 const call=f.calls.find(c=>c.method==='connection.delivery.retry')!
 expect(Object.values(useAppStore.getState().connectorRoomIntents).find(i=>i.method==='connection.delivery.retry')?.input).toEqual(call.input)
 write.mockRestore();f.unchanged();f.facts()
})
it('read failure retains the original selection and late recovery cannot overwrite another group or follow a replacement Runtime',async()=>{
 const f=await consumer();await f.mount();await f.select()
 const actual=f.bridge.getMockImplementation()!;let fail=true
 f.bridge.mockImplementation(async(method,input,target)=>{if(method==='connection.delivery.inspect'&&fail){fail=false;throw Error('Original selected read unavailable')}return actual(method,input,target)})
 const row=[...dom.container.querySelectorAll('.agent-connector-receipt')].find(n=>n.querySelector('code')?.textContent===f.operationId)!
 await act(async()=>row.querySelector<HTMLButtonElement>('button')!.click())
 await wait(()=>expect(dom.container.textContent).toContain('earlier result retained'))
 expect(dom.container.querySelector('[data-selected-delivery]')?.getAttribute('data-selected-delivery')).toBe(f.operationId)
 const original={operationId:f.operationId,source:(await f.record()).retrySource!}
 await expect(api.connections.call('connection.delivery.retry',original,{...f.hostingTarget,runtimeId:'same-alias-replacement'})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
 expect(imageWrites(f)).toHaveLength(1)
 f.remote.controls.imageMessageFailures=[];f.hold();await dom.click('[data-delivery-action="retry"]')
 await wait(()=>expect(imageOperation(f)?.state).toBe('confirmed'))
 const config=(await f.services.connections.inspect({connectionId:f.binding.connectionId})).connection!.config
 await f.services.connections.configure({operationId:'second-ui-config',expectedRevision:null,connection:{...config,connectionId:'second-ui-connection'}})
 const bound=await f.services.connections.bindings!.bind({...f.input,operationId:'second-ui-bind',bindingId:'second-ui-group',connectionId:'second-ui-connection',externalConversationId:'second-ui-room'},context)
 expect(bound.state).toBe('applied');if(bound.state!=='applied')throw Error('Second original group required')
 await dom.render(<ConnectorDeliveryDetails binding={bound.binding} hostingTarget={f.hostingTarget}/>);f.release()
 await wait(()=>expect(f.calls.some(c=>c.method==='connection.diagnose'&&c.input.bindingId===bound.binding.bindingId)).toBe(true))
 expect(dom.container.querySelector('[data-selected-delivery]')).toBeNull();expect(dom.container.textContent).not.toContain('Retry accepted')
 expect(imageWrites(f)).toHaveLength(2);f.unchanged();f.facts()
})

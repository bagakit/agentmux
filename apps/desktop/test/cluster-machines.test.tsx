// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { NodeResourceSample, NodeResources } from '@agentmux/core/node-publishing'
import type { HostConfig } from '../src/shared/contracts'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { MeshSettingsPane } from '../src/renderer/src/components/settings/MeshSettingsPane'
import { composerConfig } from './helpers/composer-dom-fixture'
import { ClusterMachinesPane } from '../src/renderer/src/components/settings/ClusterMachinesPane'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const hosts: HostConfig[] = [{ id: 'local', kind: 'local', label: 'This device' }, { id: 'farm', kind: 'ssh', label: 'Farm original', hostname: 'farm.internal', runtimeId: 'farm-runtime' }]
const node = (id: string, generation = 'process-1') => ({ runtimeId: id === 'farm' ? 'farm-runtime' : 'local-runtime', ownerInstanceId: generation, alias: id })
function reply(id: string, step: number, generation = 'process-1'): NodeResources {
 const sample: NodeResourceSample = { node: node(id, generation), policyRevision: 'policy-original', processId: 234, observedAt: 1000 + 1000 * step, system: {state:'available',value:{platform:'darwin',architecture:'arm64',uptimeSeconds:90000}},cpu:{state:'available',value:{logicalCpus:8,userMs:100*step,niceMs:0,systemMs:20*step,idleMs:880*step,irqMs:0,loadAverage:[1,2,3]}},memory:{state:'available',value:{totalBytes:16*1024**3,freeBytes:6*1024**3}},filesystem:{state:'available',value:{root:null,totalBytes:1000*1024**3,availableBytes:400*1024**3}},process:{state:'available',value:{cpuUserMicros:1000*step,cpuSystemMicros:50*step,rssBytes:100*1024**2,heapUsedBytes:1,heapTotalBytes:2,externalBytes:1,uptimeSeconds:100}} }
 return { node:sample.node,policyRevision:sample.policyRevision,status:'available',sample }
}
async function settle(predicate:()=>boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000 }) }
function instrument() {
 const count:Record<string,number>={}
 const owner=vi.spyOn(api.nodePublishing,'owner').mockImplementation(async(target)=>reply(target.hostId,count[target.hostId]=(count[target.hostId]??0)+1) as never)
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async(_method,input)=>({node:node((input as {hostId:string}).hostId),policyRevision:'policy-original',resourcesShared:false,roots:[],landing:null}) as never)
 return {owner,call,count}
}
it('visible Machines consumes two compatible samples per original Host and exposes their physical measures, never fake totals',async()=>{
 const f=instrument();await dom.render(<ClusterMachinesPane hosts={hosts} active={false}/>);expect(f.owner).not.toHaveBeenCalled()
 await dom.render(<ClusterMachinesPane hosts={hosts} active/>);await settle(()=>Object.values(f.count).every(n=>n===2)&&Object.keys(f.count).length===2)
 await settle(()=>dom.container.textContent?.includes('2 / 2 sampled')??false)
 const row=dom.container.querySelector('[data-cluster-host="farm"]')!
 expect(row.textContent).toContain('12.0%');expect(row.textContent).toContain('10.0 GiB / 16.0 GiB');expect(row.textContent).toContain('400.0 GiB available / 1000.0 GiB');expect(row.textContent).toContain('Private owner view')
 expect(row.textContent).toContain('farm-runtime');expect(f.owner.mock.calls.filter(c=>c[0].hostId==='farm').every(c=>c[0].expectedRuntimeId==='farm-runtime')).toBe(true)
 expect(f.call.mock.calls.filter(c=>c[0]==='node.resources')).toHaveLength(0)
})
it('denied private read retains independent published and withheld is distinct from zero or down',async()=>{
 const f=instrument();f.owner.mockRejectedValue(Error('Private owner not permitted'))
 f.call.mockImplementation(async(method,input)=>method==='node.resources'?{node:node((input as {hostId:string}).hostId),policyRevision:'policy-original',status:'withheld'} as never:{node:node('local'),policyRevision:'policy-original',resourcesShared:false,roots:[],landing:null} as never)
 await dom.render(<ClusterMachinesPane hosts={hosts} active/>);await settle(()=>dom.container.textContent?.includes('Not shared')??false)
 expect(f.call.mock.calls.some(c=>c[0]==='node.resources')).toBe(true);expect(dom.container.textContent).toContain('0 / 2 sampled');expect(dom.container.textContent).not.toContain('0.0%')
 expect(dom.container.textContent).toContain('Published resources');expect(dom.container.textContent).toContain('Private owner not permitted')
})
it('wrong Runtime on a refresh preserves last confirmed sample and does not contaminate healthy neighboring Hosts',async()=>{
 const f=instrument();await dom.render(<ClusterMachinesPane hosts={hosts} active/>);await settle(()=>dom.container.textContent?.includes('2 / 2 sampled')??false)
 f.owner.mockImplementation(async target=>reply(target.hostId==='farm'?'wrong-runtime':target.hostId,3) as never)
 await dom.click('[aria-label="Refresh Farm original"]');await settle(()=>dom.container.textContent?.includes('another original Runtime')??false)
 const row=dom.container.querySelector('[data-cluster-host="farm"]')!;expect(row.textContent).toContain('Last confirmed');expect(row.textContent).toContain('farm-runtime');expect(row.textContent).not.toContain('wrong-runtime')
 expect(dom.container.querySelector('[data-cluster-host="local"]')?.textContent).toContain('Sampled')
})
it('refreshing one finished Host never cancels a slow independent read; hiding cancels only this consumer and rejects late rows',async()=>{
 const f=instrument();let finish!:(v:unknown)=>void,slowSignal:AbortSignal|undefined
 f.owner.mockImplementation(async(target,_method,_params,signal)=>{
  if(target.hostId==='farm'){slowSignal=signal;return await new Promise(done=>{finish=done}) as never}
  return reply(target.hostId,f.count[target.hostId]=(f.count[target.hostId]??0)+1) as never
 })
 await dom.render(<ClusterMachinesPane hosts={hosts} active/>);await settle(()=>f.count.local===2)
 await dom.click('[aria-label="Refresh This device"]');expect(slowSignal?.aborted).toBe(false)
 await dom.render(<ClusterMachinesPane hosts={hosts} active={false}/>);expect(slowSignal?.aborted).toBe(true)
 await act(async()=>finish(reply('farm',2)));expect(dom.container.querySelector('[data-cluster-host="farm"]')?.textContent).not.toContain('farm-runtime')
})

it('partial metric sources stay visibly unavailable rather than implying a pending CPU interval',async()=>{
 const f=instrument();f.owner.mockImplementation(async target=>{const result=reply(target.hostId,1);if(result.status==='available'){result.sample.cpu={state:'unavailable',code:'CPU_SOURCE_UNAVAILABLE',message:'Original CPU counters unavailable'};result.sample.memory={state:'unavailable',code:'MEMORY_SOURCE_UNAVAILABLE',message:'Original memory counters unavailable'}}return result as never})
 await dom.render(<ClusterMachinesPane hosts={[hosts[1]!]} active/>);await settle(()=>dom.container.textContent?.includes('Partial sample')??false)
 expect(dom.container.textContent).toContain('CPU source unavailable');expect(dom.container.textContent).toContain('Memory source unavailable');expect(dom.container.textContent).not.toContain('Waiting for a compatible CPU interval');expect(dom.container.textContent).toContain('400.0 GiB available');await dom.click('[aria-label="Machine status filter"] button:nth-child(3)');expect(dom.container.querySelector('[data-cluster-host="farm"]')).not.toBeNull()
})

it('exact Machines field navigation wins over a Host hint, and unrelated renders do not replay a chosen connection navigation', async () => {
 const f=instrument(), config={...composerConfig,hosts}, close=vi.fn(),save=vi.fn()
 const request={section:'hosts' as const,field:'mesh-machines',hostId:'farm'}
 const render=(next=config)=>dom.render(<MeshSettingsPane config={next} active onSave={save} onClose={close} navigationRequest={request}/>)
 await render();expect(dom.container.querySelector('[aria-current="page"]')?.textContent).toBe('Machines')
 await settle(()=>dom.container.textContent?.includes('2 / 2 sampled')??false)
 await dom.click('[data-cluster-host="farm"] .cluster-machine-details button')
 await settle(()=>Boolean(dom.container.querySelector('[data-resource-editor="farm"] [data-host-panel="projects"]')))
 await dom.click('[data-resource-editor="farm"] [data-host-panel="projects"]')
 expect(dom.container.querySelector('[data-resource-editor="farm"] [data-host-panel="projects"]')?.getAttribute('aria-current')).toBe('page')
 await render({...config,hosts:hosts.map(h=>({...h,label:h.label+' updated'}))})
 expect(dom.container.querySelector('[data-resource-editor="farm"] [data-host-panel="projects"]')?.getAttribute('aria-current')).toBe('page')
 await dom.click('.mesh-editor-navigation button')
 expect(dom.container.querySelector('[aria-current="page"]')?.textContent).toBe('Overview')
 await dom.click('.mesh-view-tabs button:nth-child(2)')
 expect(dom.container.querySelector('[aria-current="page"]')?.textContent).toBe('Machines')
 await dom.click('[data-cluster-host="farm"] .cluster-machine-details button')
 expect(dom.container.querySelector('[data-resource-editor="farm"] [data-host-panel="connection"]')?.getAttribute('aria-current')).toBe('page')
 expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe('farm')
 expect(f.owner.mock.calls.every(call=>call[1]==='settings.node.resources')).toBe(true)
})

it('the production SettingsPanel reveals and focuses the actual Machines discovery target',async()=>{
 instrument()
 await dom.render(<SettingsPanel onClose={vi.fn()} initialSection="hosts" navigationRequest={{section:'hosts',field:'mesh-machines'}} />)
 await settle(()=>Boolean(dom.container.querySelector('[data-settings-field="mesh-machines"]')))
 expect(dom.container.querySelector('.mesh-view-tabs [aria-current="page"]')?.textContent).toBe('Machines')
 expect(dom.container.textContent).not.toContain('This setting is not shown')
 expect(dom.container.querySelector('[data-settings-field="mesh-machines"]')?.closest('[hidden]')).toBeNull()
})

// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { NodeResources, NodeResourceSample, NodeSettings } from '@agentmux/core/node-publishing'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { HostRuntimePanel } from '../src/renderer/src/components/settings/HostRuntimePanel'
import { HostPublishedResources } from '../src/renderer/src/components/settings/HostPublishedResources'
import { HostResourceTrends } from '../src/renderer/src/components/settings/HostResourceTrends'
import { nodeTrendPoints } from '../src/renderer/src/components/settings/node-resource-view'
import { nodePublicationDraftForRuntime } from '../src/renderer/src/lib/node-publication-draft'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const engine=vi.hoisted(()=>({replaceData:vi.fn(),dispose:vi.fn(),resize:vi.fn(),create:vi.fn()}))
vi.mock('@agentmux/editor-extensions/engines/vega-worker',()=>({createVegaPreview:(...args:unknown[])=>{engine.create(...args);return engine}}))
const dom=composerDOM(),identity={runtimeId:'node-original',ownerInstanceId:'core-original',alias:'work-mac'}
const settings:NodeSettings={node:identity,policyRevision:'policy-1',policy:{alias:'work-mac',shareResources:false,allowedPaths:['/published'],deniedPaths:['/published/private'],defaultPath:'/published'},operation:null}
const available=<T,>(value:T)=>({state:'available' as const,value})
function sample(at=1000):NodeResourceSample{return {node:identity,policyRevision:'policy-1',processId:123,observedAt:at,system:available({platform:'darwin',architecture:'arm64',uptimeSeconds:3600}),cpu:available({logicalCpus:4,userMs:at,systemMs:0,niceMs:0,irqMs:0,idleMs:at*3,loadAverage:[0,0,0]}),memory:available({totalBytes:8*1024**3,freeBytes:2*1024**3}),filesystem:available({root:null,totalBytes:100*1024**3,availableBytes:40*1024**3}),process:available({cpuUserMicros:at*100,cpuSystemMicros:0,rssBytes:128*1024**2,heapUsedBytes:1,heapTotalBytes:2,externalBytes:0,uptimeSeconds:10})}}
function resources(at=1000):NodeResources{return{node:identity,policyRevision:'policy-1',status:'available',sample:sample(at)}}
async function readyNode(){for(let i=0;i<100&&!dom.container.querySelector('[aria-label="Node alias"]');i++)await act(async()=>{await new Promise(done=>setTimeout(done,10))});expect(dom.container.querySelector('[aria-label="Node alias"]'),dom.container.textContent??'').not.toBeNull()}
async function input(label:string,value:string){await act(async()=>{const element=dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))})}
const props=()=>({config:useAppStore.getState().config!,active:true,onClose:vi.fn(),onNavigate:vi.fn()})
let disposeStore: (() => void) | undefined
beforeAll(async()=>{disposeStore=await useAppStore.getState().initialize()})
// Existing component scenarios control the same endpoint-local protocol leaves; new target
// consumers separately exercise the actual Main/preload/configured transport boundary.
beforeEach(()=>{
 vi.spyOn(api.hosts,'inspect').mockResolvedValue({routeHostId:'local',owner:{state:'available',value:identity}} as never)
 vi.spyOn(api.nodePublishing,'owner').mockImplementation((target,method,input,signal)=>(api.nodePublishing.call as import('@agentmux/core/node-publishing').NodePublishingPort['call'])(method,input,signal))
})
afterAll(()=>disposeStore?.())
afterEach(()=>{vi.useRealTimers();for(const value of Object.values(engine))value.mockClear()})
it('Node addresses copy only confirmed aliases and exact Runtime identity, independently of unsaved drafts or Host labels',async()=>{
 const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(structuredClone(settings) as never)
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);await input('Node alias','unsaved-alias')
 await dom.click('[aria-label="Copy Node address"]')
 expect(copy).toHaveBeenLastCalledWith('amux://host/work-mac?runtime=node-original')
 expect(dom.container.querySelector('.node-share-address')?.textContent).toContain('Copied')
 expect(call.mock.calls.some(row=>row[0]==='settings.node.configure')).toBe(false)
 const observed={...identity,alias:'observed-remote',runtimeId:'remote-original'}
 call.mockResolvedValueOnce({node:observed,policyRevision:'remote-policy',resourcesShared:false,roots:[],landing:null} as never)
 const host={id:'peer',kind:'ssh' as const,label:'Unsuitable Host label',hostname:'peer.invalid'}
 await dom.render(<HostPublishedResources host={host} committed={host} active/>);await dom.click('[aria-label="Copy Node address"]')
 expect(copy).toHaveBeenLastCalledWith('amux://host/observed-remote?runtime=remote-original')
 expect(call.mock.calls.filter(row=>row[0]!=='settings.node.inspect'&&row[0]!=='node.inspect')).toHaveLength(0)
 call.mockResolvedValue({...settings,node:{...identity,alias:''},policy:{...settings.policy,alias:''}} as never)
 await dom.render(<NetworkNodeSettingsPane key="without-published-alias" {...props()}/>);await input('Node alias','not-yet-published')
 expect(dom.container.querySelector('[aria-label="Copy Node address"]')).toBeNull()
})
it('actual Node editor preserves a later draft and keeps listener/other Host config in the original separate save owner',async()=>{
 let finish!:(value:NodeSettings)=>void
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async(method,input)=>{if(method==='settings.node.configure')return await new Promise<NodeSettings>(done=>{finish=done}) as never;return structuredClone(settings) as never})
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);await input('Node alias','my-node')
 await dom.click('.network-node-save button');expect(call.mock.calls.find(row=>row[0]==='settings.node.configure')?.[1]).toMatchObject({expectedRevision:'policy-1',policy:{alias:'my-node'}})
 await input('Node alias','later-edit')
 await act(async()=>finish({...settings,node:{...settings.node,alias:'my-node'},policyRevision:'policy-2',policy:{...settings.policy,alias:'my-node'},operation:{operationId:(call.mock.calls.find(row=>row[0]==='settings.node.configure')![1] as {operationId:string}).operationId,expectedRevision:'policy-1',revision:'policy-2',status:'confirmed',updatedAt:2}}))
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('later-edit')
 expect(dom.container.textContent).toContain('Publication: unsaved changes')
 const toggle=dom.container.querySelector<HTMLInputElement>('[aria-label="Allow Tailcat connections"]')!;await act(async()=>toggle.click())
 const configSave=vi.spyOn(api.config,'save').mockImplementation(async next=>next)
 const before=useAppStore.getState().config!,other={id:'peer',kind:'ssh' as const,label:'A newer peer',hostname:'peer.invalid'}
 useAppStore.setState({config:{...before,hosts:[...before.hosts,other]}})
 await dom.click('[data-settings-save-bar] button')
 expect(configSave).toHaveBeenCalledOnce();expect(configSave.mock.calls[0]![0].hosts).toContainEqual(other)
 expect(configSave.mock.calls[0]![0].hosts.find(host=>host.kind==='local')?.tailcat?.enabled).toBe(true)
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('later-edit')
})
it('a lost publication reply retains its original operation and only inspects it instead of repeating the save',async()=>{
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async method=>{if(method==='settings.node.configure')throw Error('reply lost');return structuredClone(settings) as never})
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);await input('Node alias','another-node');await dom.click('.network-node-save button')
 expect(dom.container.textContent).toContain('Publication save was not confirmed')
 const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='Inspect original save')!;await act(async()=>button.click())
 expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(1)
 expect(call.mock.calls.at(-1)?.[1]).toHaveProperty('operationId')
 expect(dom.container.textContent).toContain('original operation was not recorded')
 await dom.click('.network-node-save button')
 const saves=call.mock.calls.filter(row=>row[0]==='settings.node.configure');expect(saves).toHaveLength(2);expect((saves[1]![1] as {operationId:string}).operationId).not.toBe((saves[0]![1] as {operationId:string}).operationId)
})
it('remounting while the original configure is in flight cannot clear its operation from an earlier not-recorded observation',async()=>{
 let reject!:(cause:unknown)=>void
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async method=>method==='settings.node.configure'?await new Promise<never>((_done,no)=>{reject=no}):structuredClone(settings) as never)
 await dom.render(<NetworkNodeSettingsPane key="original-producer" {...props()}/>);await input('Node alias','pending-original');await dom.click('.network-node-save button')
 const retained=useAppStore.getState().nodePublicationDrafts as Record<string,{pending:{operationId:string}}>
 const operationId=retained[identity.runtimeId]!.pending.operationId
 try{
  await dom.render(<NetworkNodeSettingsPane key="replacement-view" {...props()}/>)
  expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(1)
  expect((useAppStore.getState().nodePublicationDrafts as typeof retained)[identity.runtimeId]?.pending?.operationId).toBe(operationId)
 }finally{await act(async()=>reject(Error('Original reply became unavailable')))}
})
it('a replacement Node pane observes the original confirmed save after its departed producer closes a clean edit',async()=>{
 let current=structuredClone(settings),finish!:(value:NodeSettings)=>void
 const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async method=>method==='settings.node.configure'?await new Promise<NodeSettings>(done=>{finish=done}):structuredClone(current) as never)
 await dom.render(<NetworkNodeSettingsPane key="departing-producer" {...props()}/>);await input('Node alias','confirmed-node')
 await act(async()=>dom.container.querySelector<HTMLInputElement>('[aria-label="Share system resources"]')!.click());await dom.click('.network-node-save button')
 const request=call.mock.calls.find(row=>row[0]==='settings.node.configure')![1] as {operationId:string}
 await dom.render(<NetworkNodeSettingsPane key="replacement-observer" {...props()}/>)
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('confirmed-node')
 current={...settings,node:{...identity,alias:'confirmed-node'},policyRevision:'policy-2',policy:{...settings.policy,alias:'confirmed-node',shareResources:true},operation:{operationId:request.operationId,expectedRevision:'policy-1',revision:'policy-2',status:'confirmed',updatedAt:2}}
 await act(async()=>finish(current))
 await vi.waitFor(()=>expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Share system resources"]')!.checked).toBe(true))
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('confirmed-node');expect(dom.container.textContent).toContain('Publication saved')
 await dom.click('[aria-label="Copy Node address"]');expect(copy).toHaveBeenLastCalledWith('amux://host/confirmed-node?runtime=node-original')
 expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(1)
})
it('a producer confirmed before the replacement initial read returns still refreshes the original publication',async()=>{
 let current=structuredClone(settings),finish!:(value:NodeSettings)=>void,initial!:(value:NodeSettings)=>void,holdInitial=false
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async(method,input)=>{
  if(method==='settings.node.configure')return await new Promise<NodeSettings>(done=>{finish=done}) as never
  if(holdInitial&&!(input as {operationId?:string}).operationId){holdInitial=false;return await new Promise<NodeSettings>(done=>{initial=done}) as never}
  return structuredClone(current) as never
 })
 await dom.render(<NetworkNodeSettingsPane key="old-producer" {...props()}/>);await input('Node alias','arrived-first');await dom.click('.network-node-save button')
 const request=call.mock.calls.find(row=>row[0]==='settings.node.configure')![1] as {operationId:string}
 holdInitial=true;await dom.render(<NetworkNodeSettingsPane key="delayed-initial-observer" {...props()}/>)
 current={...settings,node:{...identity,alias:'arrived-first'},policyRevision:'policy-2',policy:{...settings.policy,alias:'arrived-first',shareResources:true},operation:{operationId:request.operationId,expectedRevision:'policy-1',revision:'policy-2',status:'confirmed',updatedAt:2}}
 await act(async()=>finish(current));await act(async()=>initial(structuredClone(settings)))
 await vi.waitFor(()=>expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')?.value).toBe('arrived-first'))
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Share system resources"]')!.checked).toBe(true)
 expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(1)
})
it('an edit for another original Runtime is retained without applying or saving it on this Core',async()=>{
 const foreign={baseline:{node:{...identity,runtimeId:'other-runtime'},policyRevision:'foreign-revision',policy:settings.policy},draft:{...settings.policy,alias:'foreign-draft'}}
 useAppStore.setState({nodePublicationDrafts:{'other-runtime':foreign}})
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(structuredClone(settings) as never)
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('work-mac')
 expect(useAppStore.getState().nodePublicationDrafts).toEqual({'other-runtime':foreign});expect(call).toHaveBeenCalledTimes(2)
})
it.each(['superseded-confirmation','same-value-revision','unrecorded-returned-to-baseline'] as const)('the real Core %s requires saved-publication review before advancing the edited CAS baseline',async scenario=>{
 const{mkdtemp,mkdir,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{NodePublishingOwner}=await import('../../../packages/core/src/node-publishing-owner')
 const directory=await mkdtemp('/tmp/nn-cas-'),published=join(directory,'shared');await mkdir(published)
 const owner=new NodePublishingOwner({stateDirectory:directory,runtimeId:'cas-original',ownerInstanceId:'cas-owner'})
 const empty=await owner.call('settings.node.inspect',{}),first=await owner.call('settings.node.configure',{operationId:'initial-publication',expectedRevision:empty.policyRevision,policy:{...empty.policy,alias:'base-node',allowedPaths:[published]}})
 let loseReply=scenario!=='same-value-revision'
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async(method,input)=>{if(method==='settings.node.configure'&&loseReply&&scenario==='unrecorded-returned-to-baseline'){loseReply=false;throw Error('Original request was not recorded')}const result=await owner.call(method,input);if(method==='settings.node.configure'&&loseReply){loseReply=false;throw Error('Original confirmed reply lost')}return result as never})
 try{
  vi.spyOn(api.hosts,'inspect').mockResolvedValue({routeHostId:'local',owner:{state:'available',value:first.node}} as never)
  await dom.render(<NetworkNodeSettingsPane {...props()}/>);await readyNode()
  if(scenario!=='same-value-revision'){
   await input('Node alias','first-save');await dom.click('.network-node-save button');await vi.waitFor(()=>expect(dom.container.textContent).toContain('Publication save was not confirmed'))
  }
  const draftAlias=scenario==='unrecorded-returned-to-baseline'?'base-node':'later-draft'
  await input('Node alias',draftAlias)
  const before=await owner.call('settings.node.inspect',{}),changed=await owner.call('settings.node.configure',{operationId:'another-owner-revision',expectedRevision:before.policyRevision,policy:scenario!=='same-value-revision'?{...before.policy,alias:'other-owner',allowedPaths:[],defaultPath:null}:before.policy})
  const read=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===(scenario!=='same-value-revision'?'Inspect original save':'Refresh'))!
  await act(async()=>read.click());await vi.waitFor(()=>expect(dom.container.querySelector('[data-publication-review]')).not.toBeNull())
  const retained=nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts,first.node.runtimeId)!
  expect(retained.baseline.policyRevision).toBe(first.policyRevision);expect(retained.pending).toBeUndefined()
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe(draftAlias)
  expect(dom.container.querySelector<HTMLButtonElement>('.network-node-save button')!.disabled).toBe(true)
  expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(scenario!=='same-value-revision'?1:0)
  const details=dom.container.querySelector<HTMLDetailsElement>('[data-publication-review]')!;await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'))})
  expect(details.textContent).toContain(changed.policyRevision)
  if(scenario!=='same-value-revision'){expect(details.textContent).toContain('No shared folders');expect((await owner.call('settings.node.inspect',{})).policy.allowedPaths).toEqual([])}
  await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Keep my publication draft')!.click())
  await vi.waitFor(()=>expect(dom.container.querySelector<HTMLButtonElement>('.network-node-save button')!.disabled).toBe(false))
  await dom.click('.network-node-save button')
  await vi.waitFor(()=>expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure').at(-1)?.[1]).toMatchObject({expectedRevision:changed.policyRevision}))
  expect((await owner.call('settings.node.inspect',{})).policy).toMatchObject({alias:draftAlias,allowedPaths:[published]})
 }finally{await dom.render(<div/>);await rm(directory,{recursive:true,force:true})}
})
it('a failed original local checkpoint retains the edit and operation, reports not sent and leaves the healthy Agent usable',async()=>{
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(structuredClone(settings) as never),stop=vi.spyOn(api.sessions,'stop')
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);await input('Node alias','keep-local-edit')
 const write=vi.spyOn(window.localStorage,'setItem').mockImplementation(()=>{throw Error('Original local writer unavailable')})
 await dom.click('.network-node-save button')
 expect(dom.container.textContent).toContain('Publication request was not sent')
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('keep-local-edit')
 expect(call.mock.calls.filter(row=>row[0]==='settings.node.configure')).toHaveLength(0)
 expect(useAppStore.getState().workbenchSaveWarning).toBeTruthy();expect(useAppStore.getState().sessions[0]?.processState).toBe('running');expect(stop).not.toHaveBeenCalled()
 write.mockRestore()
})
it('an unreadable saved edit stays in the original user projection and is never treated as an empty draft',async()=>{
 const raw={[identity.runtimeId]:{baseline:'original unreadable bytes',pending:{operationId:'retain-this-operation'}}}
 useAppStore.setState({nodePublicationDrafts:raw})
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(structuredClone(settings) as never)
 await dom.render(<NetworkNodeSettingsPane {...props()}/>);expect(dom.container.textContent).toContain('saved Node publication edit is unreadable')
 expect(useAppStore.getState().nodePublicationDrafts).toBe(raw);expect(call).toHaveBeenCalledTimes(2)
 expect(dom.container.querySelector<HTMLButtonElement>('.network-node-save button')!.disabled).toBe(true)
})
it('actual Host consumer uses private owner resources locally, public target resources remotely, and explicit withheld clears retained private values',async()=>{
 vi.useFakeTimers();vi.spyOn(api.hosts,'inspect').mockRejectedValue(Error('independent identity observation failed'))
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(resources() as never)
 const local=composerConfig.hosts.find(host=>host.kind==='local')!
 await dom.render(<HostRuntimePanel host={local} committed={local} ownerTarget={{hostId:local.id,expectedRuntimeId:identity.runtimeId}} active/>);expect(call.mock.calls[0]!.slice(0,2)).toEqual(['settings.node.resources',{}]);expect(dom.container.textContent).toContain('6 GiB')
 const remote={id:'peer',kind:'ssh' as const,label:'Peer',hostname:'peer.invalid',runtimeId:identity.runtimeId}
 await dom.render(<HostRuntimePanel host={remote} committed={remote} active/>);expect(call.mock.calls.at(-1)!.slice(0,2)).toEqual(['node.resources',{hostId:'peer',expectedRuntimeId:identity.runtimeId}])
 call.mockResolvedValueOnce({node:identity,policyRevision:'policy-2',status:'withheld'} as never)
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(dom.container.textContent).toContain('System resources are not shared');expect(dom.container.textContent).not.toContain('6 GiB');expect(dom.container.querySelector('[data-node-trends]')).toBeNull()
 call.mockResolvedValueOnce(resources(16000) as never);await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});expect(engine.replaceData.mock.calls.at(-1)?.[1]).toHaveLength(1)
})
it('temporary failure keeps last confirmed values, hides the reader without further samples, and never turns gaps into zero CPU',async()=>{
 vi.useFakeTimers();vi.spyOn(api.hosts,'inspect').mockRejectedValue(Error('separate observation failed'))
 const call=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(resources() as never),local=composerConfig.hosts[0]!
 await dom.render(<HostRuntimePanel host={local} committed={local} ownerTarget={{hostId:local.id,expectedRuntimeId:identity.runtimeId}} active/>);call.mockResolvedValueOnce(resources(6000) as never)
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(dom.container.textContent).toContain('25.0%');expect(dom.container.textContent).toContain('10.0%')
 call.mockRejectedValueOnce(Error('temporary read loss'));await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(dom.container.textContent).toContain('Last confirmed');expect(dom.container.textContent).toContain('6 GiB')
 await dom.render(<HostRuntimePanel host={local} committed={local} ownerTarget={{hostId:local.id,expectedRuntimeId:identity.runtimeId}} active={false}/>);const count=call.mock.calls.length
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});expect(call).toHaveBeenCalledTimes(count)
 const frames=[{at:1000,sample:sample(1000)},{at:2000,sample:null},{at:3000,sample:sample(3000)}]
 expect(nodeTrendPoints(frames).map(point=>point.hostCpu)).toEqual([null,null,null])
})
it('shared directory consumer carries exact root/revision through list pagination and bounded original file reads',async()=>{
 const root={runtimeId:identity.runtimeId,rootId:'published-original',policyRevision:'policy-1'}
 const call=vi.spyOn(api.nodePublishing,'call').mockImplementation(async(method,input)=>{
  if(method==='node.inspect')return{node:identity,policyRevision:'policy-1',resourcesShared:false,roots:[{root,label:'Notes'}],landing:null} as never
  if(method==='node.files.list')return{root,path:'',entries:(input as {offset?:number}).offset?[{name:'readme.txt',kind:'file'}]:[{name:'folder',kind:'directory'}],truncated:!(input as {offset?:number}).offset,offset:(input as {offset?:number}).offset??0,nextOffset:(input as {offset?:number}).offset?null:1,revision:'directory-revision'} as never
  return{root,path:'readme.txt',encoding:'base64',data:btoa('<h1>Plain original bytes</h1>'),offset:0,totalBytes:58,nextOffset:29,revision:'file-revision'} as never
 })
 const host=composerConfig.hosts[0]!
 await dom.render(<HostPublishedResources host={host} committed={host} active/>);await dom.click('.host-published-resources__roots button')
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='Load more entries')!.click())
 expect(call.mock.calls.filter(row=>row[0]==='node.files.list').at(-1)?.[1]).toMatchObject({root,path:'',offset:1,expectedRevision:'directory-revision'})
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('li button')].find(n=>n.textContent?.includes('readme.txt'))!.click())
 expect(call.mock.calls.at(-1)?.slice(0,2)).toEqual(['node.files.read',{hostId:host.id,root,path:'readme.txt',maxBytes:65536}])
 expect(dom.container.querySelector('pre')?.textContent).toBe('<h1>Plain original bytes</h1>');expect(dom.container.querySelector('pre h1')).toBeNull()
 call.mockRejectedValueOnce(Object.assign(Error('Publication access changed'),{code:'NODE_PATH_DENIED'}))
 await act(async()=>[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='Read next chunk')!.click())
 expect(dom.container.querySelector('pre')).toBeNull();expect(dom.container.textContent).toContain('Publication access changed')
})
it.each(['hide','route'] as const)('the shared file reader cancels its current read on %s and ignores the late original reply',async change=>{
 const root={runtimeId:identity.runtimeId,rootId:'root-a',policyRevision:'policy-1'}
 let finish!:(value:unknown)=>void,fileSignal!:AbortSignal,nextSignal!:AbortSignal
 vi.spyOn(api.nodePublishing,'call').mockImplementation(async(method,input,signal)=>{
  if(method==='node.inspect'){nextSignal=signal!;return{node:identity,policyRevision:'policy-1',resourcesShared:false,roots:[{root,label:'Original root'}],landing:null} as never}
  if(method==='node.files.list')return{root,path:'',entries:[{name:'original.txt',kind:'file'}],truncated:false,offset:0,nextOffset:null,revision:'directory-1'} as never
  fileSignal=signal!;return await new Promise(done=>{finish=done}) as never
 })
 const host={id:'reader-a',kind:'ssh' as const,label:'Original carrier',hostname:'a.invalid'}
 await dom.render(<HostPublishedResources host={host} committed={host} active/>);await dom.click('.host-published-resources__roots button');await dom.click('li button')
 expect(fileSignal.aborted).toBe(false)
 const next=change==='route'?{...host,id:'reader-b',hostname:'b.invalid'}:host
 await dom.render(<HostPublishedResources host={next} committed={next} active={change==='route'}/>);expect(fileSignal.aborted).toBe(true)
 await act(async()=>finish({root,path:'original.txt',encoding:'base64',data:btoa('Late old file'),offset:0,totalBytes:13,nextOffset:null,revision:'file-1'}))
 expect(dom.container.querySelector('pre')).toBeNull();expect(dom.container.textContent).not.toContain('Late old file')
 if(change==='route')expect(nextSignal.aborted).toBe(false)
})
it('the actual chart wrapper replaces only its inline samples on the same engine lifetime and disposes on hide',async()=>{
 const frames=[{at:1000,sample:sample(1000)}]
 await dom.render(<HostResourceTrends points={nodeTrendPoints(frames)} active/>);expect(engine.create).toHaveBeenCalledTimes(1)
 await dom.render(<HostResourceTrends points={nodeTrendPoints([...frames,{at:2000,sample:sample(2000)}])} active/>);expect(engine.create).toHaveBeenCalledTimes(1);expect(engine.replaceData.mock.calls.at(-1)?.[0]).toBe('samples');expect(engine.replaceData.mock.calls.at(-1)?.[1]).toHaveLength(2)
 await dom.render(<HostResourceTrends points={[]} active={false}/>);expect(engine.dispose).toHaveBeenCalledTimes(1)
})

it('actual Settings catalog and visited Node pane retain the authored publication draft across original navigation',async()=>{
 vi.spyOn(api.nodePublishing,'call').mockResolvedValue(structuredClone(settings) as never)
 expect(settingsCatalog.visibleSections('Node alias').map(item=>item.id)).toContain('network-node')
 const before=useAppStore.getState().agentComposerDrafts
 await dom.render(<SettingsPanel initialSection="network-node" onClose={vi.fn()}/>);await input('Node alias','retained-publication')
 await dom.click('[data-settings-target="hosts"]')
 await dom.click('[data-settings-target="network-node"]')
 expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!.value).toBe('retained-publication')
 expect(useAppStore.getState().agentComposerDrafts).toBe(before)
})
it('real persisted Core owner → Unix public client → Main bridge → Renderer adapter → Settings editor and published file consumer',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path')
 const {NodePublishingOwner}=await import('../../../packages/core/src/node-publishing-owner')
 const {AgentMuxControlServer}=await import('../../../packages/core/src/public-rpc-server')
 const {connectAgentMuxRpc}=await import('../../../packages/core/src/public-rpc-client')
 const {registerNodePublishingIpc}=await import('../src/main/node-publishing-ipc')
 const {createRendererNodePublishing}=await import('../src/renderer/src/lib/node-publishing-client')
 const {EventEmitter}=await import('node:events')
 const directory=await mkdtemp('/tmp/nnu-'),published=join(directory,'shared '),denied=join(published,'private ');await mkdir(published);await mkdir(join(directory,'shared'));await mkdir(denied);await mkdir(join(published,'private'));await mkdir(join(directory,'state'));await writeFile(join(published,'original.txt'),'Original published bytes through Core')
 const owner=new NodePublishingOwner({stateDirectory:join(directory,'state'),runtimeId:'original-ui-runtime',ownerInstanceId:'original-ui-core'})
 const server=new AgentMuxControlServer({socketPath:join(directory,'rpc.sock'),coreClients:()=>[],nodePublishing:owner})
 await server.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
 class Sender extends EventEmitter{id=52;isDestroyed(){return false}}
 const sender=new Sender(),handlers=new Map<string,(...args:any[])=>any>()
 const ipc=registerNodePublishingIpc({handle:(name,listener)=>handlers.set(name,listener),call:(method,params,context)=>rpc.call(method,params,context),owner:(target,method,params,context)=>{expect(target).toEqual({hostId:'local',expectedRuntimeId:'original-ui-runtime'});return rpc.call(method,params,context)}})
 let serial=0
 const bridge=createRendererNodePublishing({owner:async(target,method,params,context)=>{const token='owner-'+(++serial);return handlers.get('nodePublishing:owner')!({sender},token,target,method,params)},call:async(method,params,context)=>{const token='ui-'+(++serial),release=context?.onAbort?.(()=>handlers.get('nodePublishing:cancel')!({sender},token));try{return await handlers.get('nodePublishing:call')!({sender},token,method,params)}finally{release?.()}}})
 vi.spyOn(api.nodePublishing,'call').mockImplementation(bridge.call)
 vi.spyOn(api.nodePublishing,'owner').mockImplementation(bridge.owner)
 vi.spyOn(api.hosts,'inspect').mockResolvedValue({routeHostId:'local',owner:{state:'available',value:{runtimeId:'original-ui-runtime'}}} as never)
 try{
  await dom.render(<NetworkNodeSettingsPane {...props()}/>);await readyNode();await input('Node alias','real-ui-node')
  for(const[label,value]of[['Shared folders',published],['Excluded paths',denied]]){
   await act(async()=>{const textarea=dom.container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,value!);textarea.dispatchEvent(new Event('input',{bubbles:true}))})
   await act(async()=>dom.container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!.dispatchEvent(new FocusEvent('focusout',{bubbles:true})))
  }
  await dom.click('.network-node-save button')
  await act(async()=>{for(let i=0;i<80&&dom.container.querySelector('.network-node-save [role="status"]')?.textContent!=='Publication saved';i++)await new Promise(resolve=>setTimeout(resolve,10))})
  const saved=await owner.call('settings.node.inspect',{});expect(saved.policy.alias).toBe('real-ui-node');expect(saved.policy.allowedPaths).toEqual([published]);expect(saved.policy.deniedPaths).toEqual([denied]);expect(saved.operation?.status).toBe('confirmed')
  const local=composerConfig.hosts[0]!
  await dom.render(<HostPublishedResources host={local} committed={local} active/>)
  await act(async()=>{for(let i=0;i<80&&!dom.container.querySelector('.host-published-resources__roots button');i++)await new Promise(resolve=>setTimeout(resolve,10))})
  await dom.click('.host-published-resources__roots button')
  await act(async()=>{for(let i=0;i<80&&!dom.container.querySelector('li button');i++)await new Promise(resolve=>setTimeout(resolve,10))})
  await dom.click('li button')
  await act(async()=>{for(let i=0;i<80&&!dom.container.querySelector('pre');i++)await new Promise(resolve=>setTimeout(resolve,10))})
  expect(dom.container.querySelector('pre')?.textContent).toBe('Original published bytes through Core')
  const privateRead=await bridge.owner({hostId:'local',expectedRuntimeId:saved.node.runtimeId},'settings.node.resources',{}),publicRead=await bridge.call('node.resources',{hostId:local.id,expectedRuntimeId:saved.node.runtimeId})
  expect(privateRead.status).toBe('available');expect(publicRead.status).toBe('withheld')
 }finally{await dom.render(<div/>);ipc.dispose();await rpc.dispose();await server.stop();await rm(directory,{recursive:true,force:true})}
})

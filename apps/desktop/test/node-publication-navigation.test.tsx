// @vitest-environment happy-dom
import {act} from 'react'
import {beforeAll,afterAll,expect,it,vi} from 'vitest'
import type {NodeSettings,NodePublication} from '@agentmux/core/node-publishing'
import {SettingsPanel} from '../src/renderer/src/components/SettingsPanel'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {composerDOM,composerConfig} from './helpers/composer-dom-fixture'
const dom=composerDOM();let dispose:(()=>void)|undefined
beforeAll(async()=>{dispose=await useAppStore.getState().initialize()});afterAll(()=>dispose?.())
const identity=(id='local')=>({runtimeId:id+'-runtime',ownerInstanceId:id+'-instance',alias:id+'-node'})
const settings=(published=false,id='local'):NodeSettings=>({node:identity(id),policyRevision:'revision',operation:null,policy:{alias:id+'-node',shareResources:published,allowedPaths:[],deniedPaths:[],defaultPath:null}})
const publication=(published=false,id='local'):NodePublication=>({node:identity(id),policyRevision:'revision',resourcesShared:published,roots:[],landing:null})
const icon=()=>dom.container.querySelector<HTMLElement>('[data-settings-target="network-node"] [data-node-publication]')!
async function input(value:string){await act(async()=>{const n=dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}))})}
async function paths(label:string,value:string){await act(async()=>{const n=dom.container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}))})}
async function choose(value:string){await act(async()=>{const n=dom.container.querySelector<HTMLSelectElement>('[aria-label="Node to manage"]')!;n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}))})}
async function ready(){await vi.waitFor(()=>expect(dom.container.querySelector('[aria-label="Node alias"]')).not.toBeNull())}
function leaves(published=false){const read=vi.spyOn(api.nodePublishing,'call').mockResolvedValue(publication(published) as never),owner=vi.spyOn(api.nodePublishing,'owner').mockResolvedValue(settings(published) as never);return{read,owner}}
it('the real Settings sidebar and Overview share one publication read, accessible current facts and the authored semantic family',async()=>{
 const{read}=leaves(true);await dom.render(<SettingsPanel initialSection="overview" onClose={vi.fn()}/>)
 await vi.waitFor(()=>expect(icon().dataset.nodePublication).toBe('published'))
 expect(read).toHaveBeenCalledExactlyOnceWith('node.inspect',{hostId:'local'},expect.any(AbortSignal))
 const icons=dom.container.querySelectorAll<HTMLElement>('[data-node-publication]');expect(icons.length).toBeGreaterThanOrEqual(2)
 for(const n of icons){expect(n.dataset.nodePublication).toBe('published');expect(n.getAttribute('aria-label')).toContain('Read ');expect(n.getAttribute('aria-hidden')).not.toBe('true');expect(n.querySelector('[data-icon-animation="stream"]')).not.toBeNull();expect(n.querySelector('[data-semantic-icon="status.node-published"]')).not.toBeNull()}
 expect(dom.container.querySelector('[data-settings-group="cluster"] [data-semantic-icon="object.settings-cluster"]')).not.toBeNull()
 expect(dom.container.querySelector('[data-settings-target="hosts"] [data-semantic-icon="object.hosts"]')).not.toBeNull();expect(dom.container.querySelector('[data-settings-target="mobile"] [data-semantic-icon="object.mobile-access"]')).not.toBeNull()
 await dom.click('[data-settings-target="appearance"]');await dom.click('[data-settings-target="overview"]');expect(read).toHaveBeenCalledTimes(1)
 await dom.render(<SettingsPanel initialSection="overview" visible={false} onClose={vi.fn()}/>);expect(icon().querySelector('[data-icon-animation="stream"]')).toBeNull()
})
it('the original narrow menu consumes the same accessible publication state without an extra reader',async()=>{
 const{read}=leaves(true);await dom.render(<SettingsPanel initialSection="overview" onClose={vi.fn()}/>);await vi.waitFor(()=>expect(icon().dataset.nodePublication).toBe('published'))
 await act(async()=>dom.container.querySelector('.settings-section-picker')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse',ctrlKey:false})))
 await vi.waitFor(()=>expect(document.querySelector('.settings-section-menu [data-settings-target="network-node"] [data-node-publication]')).not.toBeNull())
 const entry=document.querySelector<HTMLElement>('.settings-section-menu [data-settings-target="network-node"] [data-node-publication]')!
 expect(entry.dataset.nodePublication).toBe('published');expect(entry.getAttribute('aria-label')).toContain('Runtime local-runtime');expect(entry.getAttribute('aria-hidden')).not.toBe('true');expect(read).toHaveBeenCalledTimes(1)
})
it('drafts, selection and listener edits do not enable publication; an unconfirmed save is unknown until an independent owner read confirms current policy',async()=>{
 const{read,owner}=leaves(false);let current=settings(false)
 owner.mockImplementation(async(_target,method,input)=>{if(method==='settings.node.configure'){current={...settings(true),operation:{operationId:(input as{operationId:string}).operationId,expectedRevision:'revision',revision:'revision-next',status:'unknown',updatedAt:2}};return current as never}return current as never})
 await dom.render(<SettingsPanel initialSection="network-node" onClose={vi.fn()}/>);await ready();expect(icon().dataset.nodePublication).toBe('private')
 await act(async()=>dom.container.querySelector<HTMLInputElement>('[aria-label="Share system resources"]')!.click());await input('edited-alias');await act(async()=>dom.container.querySelector<HTMLInputElement>('[aria-label="Allow Tailcat connections"]')!.click())
 expect(icon().dataset.nodePublication).toBe('private');expect(icon().querySelector('[data-icon-animation="stream"]')).toBeNull();expect(read).toHaveBeenCalledTimes(1)
 await dom.click('.network-node-save button');expect(icon().dataset.nodePublication).toBe('unknown');expect(icon().getAttribute('aria-label')).toContain('Last confirmed private');expect(icon().querySelector('[data-icon-animation="stream"]')).toBeNull()
 await dom.click('[data-settings-field="publishing"] > header button')
 expect(icon().dataset.nodePublication).toBe('published');expect(dom.container.textContent).toContain('Original save needs confirmation');expect(owner.mock.calls.filter(row=>row[1]==='settings.node.configure')).toHaveLength(1)
})
it('late target reads cannot recolor the selected original Node, and current failures keep an accessible last-confirmed fact',async()=>{
 useAppStore.setState({config:{...composerConfig,hosts:[composerConfig.hosts[0]!,{id:'farm',kind:'ssh',label:'Farm',hostname:'private.invalid',runtimeId:'farm-runtime'}]}})
 const{owner}=leaves(false);let finish!:(value:NodeSettings)=>void,fail=false
 owner.mockImplementation(async(target)=>{if(target.hostId==='farm')return await new Promise<NodeSettings>(done=>{finish=done}) as never;if(fail)throw Error('Original read unavailable');return settings(false) as never})
 await dom.render(<SettingsPanel initialSection="network-node" onClose={vi.fn()}/>);await ready();expect(icon().dataset.nodePublication).toBe('private')
 await choose('farm');await vi.waitFor(()=>expect(icon().dataset.nodePublicationHost).toBe('farm'));expect(icon().dataset.nodePublication).toBe('unknown')
 await choose('local');await ready();await act(async()=>finish(settings(true,'farm')));expect(icon().dataset.nodePublicationHost).toBe('local');expect(icon().dataset.nodePublication).toBe('private')
 fail=true;await dom.click('[data-settings-field="publishing"] > header button');expect(icon().dataset.nodePublication).toBe('unknown');expect(icon().getAttribute('aria-label')).toContain('Last confirmed private');expect(icon().getAttribute('aria-label')).toContain('Original read unavailable')
})
it('a hidden Settings releases its sole Overview reader and ignores its late publication result without sampling resources',async()=>{
 let finish!:(value:NodePublication)=>void,signal!:AbortSignal
 const{read,owner}=leaves(false);read.mockImplementation(async(_method,_input,abort)=>{signal=abort!;return await new Promise<NodePublication>(done=>{finish=done}) as never})
 await dom.render(<SettingsPanel initialSection="overview" onClose={vi.fn()}/>);expect(read).toHaveBeenCalledTimes(1)
 await dom.render(<SettingsPanel initialSection="overview" visible={false} onClose={vi.fn()}/>);expect(signal.aborted).toBe(true)
 await act(async()=>finish(publication(true)));expect(icon().dataset.nodePublication).toBe('unknown');expect(owner).not.toHaveBeenCalled();expect(read.mock.calls.every(row=>row[0]==='node.inspect')).toBe(true)
})
it('removing the selected saved Host releases its pending Overview reader and cannot be recolored by that old reply',async()=>{
 let finish!:(value:NodePublication)=>void,signal!:AbortSignal
 const{read}=leaves(false);read.mockImplementation(async(_method,_input,abort)=>{signal=abort!;return await new Promise<NodePublication>(done=>{finish=done}) as never})
 await dom.render(<SettingsPanel initialSection="overview" onClose={vi.fn()}/>);expect(read).toHaveBeenCalledTimes(1)
 await act(async()=>useAppStore.setState({config:{...composerConfig,hosts:[]}}));expect(signal.aborted).toBe(true)
 await act(async()=>finish(publication(true)));expect(icon().dataset.nodePublication).toBe('unknown');expect(icon().getAttribute('aria-label')).toContain('original saved Host is unavailable');expect(read).toHaveBeenCalledTimes(1)
})
it('the editor uses actual published folders, and a metadata failure never closes a healthy policy editor',async()=>{
 const{read,owner}=leaves(false)
 owner.mockResolvedValue({...settings(false),policy:{...settings(false).policy,allowedPaths:['/root'],deniedPaths:['/root']}} as never)
 await dom.render(<SettingsPanel initialSection="network-node" onClose={vi.fn()}/>);await ready()
 await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(2));expect(icon().dataset.nodePublication).toBe('private')
 expect(read).toHaveBeenLastCalledWith('node.inspect',{hostId:'local',expectedRuntimeId:'local-runtime'},expect.any(AbortSignal))
 read.mockRejectedValue(Error('Publication metadata unavailable'))
 await dom.click('[data-settings-field="publishing"] > header button');await vi.waitFor(()=>expect(icon().dataset.nodePublication).toBe('unknown'))
 expect(dom.container.querySelector('[aria-label="Node alias"]')).not.toBeNull();expect(dom.container.querySelector('.network-node-feedback')).toBeNull()
 await input('healthy-owner-edit');expect(dom.container.querySelector<HTMLButtonElement>('.network-node-save button')!.disabled).toBe(false)
})
it('a metadata read from before a save cannot overwrite that newer unconfirmed publication',async()=>{
 const{read,owner}=leaves(false);let finish!:(value:NodePublication)=>void,signal!:AbortSignal
 read.mockImplementation(async(_method,_input,abort)=>{if(!finish)return await new Promise<NodePublication>(done=>{signal=abort!;finish=done}) as never;return publication(false) as never})
 // This known remote target needs no identity bootstrap; its first public read is the folder projection.
 useAppStore.setState({config:{...composerConfig,hosts:[...composerConfig.hosts,{id:'farm',kind:'ssh',label:'Farm',hostname:'private.invalid',runtimeId:'farm-runtime'}]}})
 const original={...settings(false,'farm'),policy:{...settings(false,'farm').policy,allowedPaths:['/root']}}
 owner.mockImplementation(async(_target,method,value)=>method==='settings.node.configure'?{...original,policy:{...original.policy,deniedPaths:['/root']},operation:{operationId:(value as{operationId:string}).operationId,expectedRevision:'revision',revision:'next',status:'unknown',updatedAt:2}} as never:original as never)
 await dom.render(<SettingsPanel initialSection="network-node" navigationRequest={{section:'network-node',hostId:'farm'}} onClose={vi.fn()}/>);await ready();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
 await paths('Excluded paths','/root');await dom.click('.network-node-save button');expect(signal.aborted).toBe(true)
 await act(async()=>finish({...publication(false,'farm'),roots:[{root:{runtimeId:'farm-runtime',rootId:'root',policyRevision:'revision'},label:'root'}]}))
 expect(icon().dataset.nodePublication).toBe('unknown');expect(icon().querySelector('[data-icon-animation="stream"]')).toBeNull()
})
it('a save completing after the Node becomes hidden cannot start a decorative folder read',async()=>{
 const{read,owner}=leaves(false);let finish!:(value:NodeSettings)=>void,operationId=''
 owner.mockImplementation(async(_target,method,input)=>{if(method==='settings.node.configure'){operationId=(input as{operationId:string}).operationId;return await new Promise<NodeSettings>(done=>{finish=done}) as never}return settings(false) as never})
 await dom.render(<SettingsPanel initialSection="network-node" onClose={vi.fn()}/>);await ready();await paths('Shared folders','/root');await dom.click('.network-node-save button');await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
 await dom.render(<SettingsPanel initialSection="network-node" visible={false} onClose={vi.fn()}/>)
 await act(async()=>finish({...settings(false),policy:{...settings(false).policy,allowedPaths:['/root']},operation:{operationId,expectedRevision:'revision',revision:'next',status:'confirmed',updatedAt:2}}))
 expect(read).toHaveBeenCalledTimes(1);expect(dom.container.querySelector('[data-icon-animation="stream"]')).toBeNull()
})

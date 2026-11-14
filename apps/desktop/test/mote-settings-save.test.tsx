// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { createMotePreferencesPlacementFixture } from '../../../packages/core/test/helpers/mote-preferences-placement'
import { MoteQuickModeDialog } from '../src/renderer/src/components/MoteQuickMode'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { readMoteQuickDefaults, saveMoteQuickDefaults } from '../src/renderer/src/lib/mote-quick-mode'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { confirmedMoteReference } from '../src/renderer/src/lib/mote-materials-actions'
import { readFile, writeFile } from 'node:fs/promises'
let app:MoteAppFixture|undefined;const closes:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{await app?.dispose();app=undefined;for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks()})
async function fixture(){
 const f=await createMotePreferencesPlacementFixture();closes.push(f.close);app=createMoteApp()
 const saved=await f.read(),scope={...f.scope,topic:{...f.scope.topic,quickMode:{status:'saved' as const,defaults:saved.defaults!,version:saved.source!.result.status==='read'?saved.source!.result.document.revision:'missing'}}}
 const state=useAppStore.getState();useAppStore.setState({config:{...state.config!,workspaces:state.config!.workspaces.map(workspace=>workspace.id===scope.workspace.id?scope.workspace:workspace)},scratchTopicSnapshots:{[scope.workspace.id]:{scope:scratchTopicsScope(scope.workspace),revision:1,topics:[scope.topic],error:null,reading:false}}})
 vi.spyOn(api.motePreferences,'read').mockImplementation(input=>f.rpc.call('space.mote.preferences.read',input))
 const save=vi.spyOn(api.motePreferences,'save').mockImplementation(input=>f.rpc.call('space.mote.preferences.save',input))
 const topics=async()=>{const read=await f.rpc.call('space.mote.preferences.read',{kind:'quick',target:f.target,includeChoices:false});if(read.kind!=='quick')throw Error('Original Quick source required');return[{...scope.topic,quickMode:{status:'saved' as const,defaults:read.defaults!,version:read.source!.result.status==='read'?read.source!.result.document.revision:'missing'}}]}
 vi.mocked(api.scratch.listTopics).mockImplementation(topics);vi.mocked(api.scratch.readTopic).mockImplementation(async()=> (await topics())[0]!)
 const resume=vi.spyOn(api.schedule,'resume'),onClose=vi.fn(),onOpenPath=vi.fn()
 return{f,scope,save,resume,onClose,onOpenPath}
}
it('actual Automatic care Save reaches original public Host CAS with reference:null and retains Main, paused unknown input and existing work',async()=>{
 const x=await fixture();expect(confirmedMoteReference(useAppStore.getState(),x.scope,{reference:null})).toBeNull()
 await app!.mount(createElement(MoteQuickModeDialog,{scope:x.scope,reference:null,onOpenPath:x.onOpenPath,onClose:x.onClose,returnFocus:()=>null,focusHeartbeat:true}))
 const input=await vi.waitFor(()=>{const node=document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]');expect(node).not.toBeNull();return node!})
 await vi.waitFor(()=>{const save=[...document.querySelectorAll<HTMLButtonElement>('.mote-quick-mode-dialog button')].find(node=>node.textContent?.trim()==='Save');expect(save?.disabled).toBe(false)})
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'60');input.dispatchEvent(new Event('input',{bubbles:true}))});await settleMoteApp()
 const before=useAppStore.getState(),drafts=structuredClone(before.agentComposerDrafts),layouts=structuredClone(before.layouts),tabs=structuredClone(before.tabs),selection=structuredClone(before.workbenchSpaceSelection),focus=structuredClone(before.agentFocus)
 const save=[...document.querySelectorAll<HTMLButtonElement>('.mote-quick-mode-dialog button')].find(node=>node.textContent?.trim()==='Save')!;await moteClick(save)
 await vi.waitFor(()=>expect(x.onClose).toHaveBeenCalledTimes(1))
 expect(x.save).toHaveBeenCalledTimes(1);const request=x.save.mock.calls[0]![0];expect(request.kind).toBe('quick');expect('destination' in request).toBe(false)
 const actual=await x.f.read();expect(actual.defaults!.presence?.intervalMs).toBe(3600000);expect(actual.defaults!.conversation).toEqual(x.f.defaults.conversation);expect(actual.defaults!.conversationRevision).toBe(x.f.defaults.conversationRevision);expect(actual.defaults!.conversationTransition).toEqual(x.f.marker);expect(actual.maintenance?.schedule).toEqual(x.f.paused)
 const after=useAppStore.getState();expect(after.agentComposerDrafts).toEqual(drafts);expect(after.layouts).toEqual(layouts);expect(after.tabs).toEqual(tabs);expect(after.workbenchSpaceSelection).toEqual(selection);expect(after.agentFocus).toEqual(focus)
 expect(x.resume).not.toHaveBeenCalled();expect(app!.launch).not.toHaveBeenCalled();expect(app!.send).not.toHaveBeenCalled();expect(app!.stop).not.toHaveBeenCalled();expect(x.onOpenPath).not.toHaveBeenCalled();expect(x.f.writes).toEqual([])
 await x.f.witness('actual-automatic-care',{reference:null,request,after:actual,before:{drafts,layouts,tabs,selection,focus},restored:{drafts:after.agentComposerDrafts,layouts:after.layouts,tabs:after.tabs,selection:after.workbenchSpaceSelection,focus:after.agentFocus},resume:x.resume.mock.calls,launch:app!.launch.mock.calls,send:app!.send.mock.calls,stop:app!.stop.mock.calls,inputWrites:x.f.writes})
})
it('same-Main no-placement save still rejects a changed resource scope, dirty Editor and a different pending original request',async()=>{
 const x=await fixture(),saved=await readMoteQuickDefaults(x.scope),values={...saved.defaults,presence:{enabled:true,intervalMs:3600000}},original=useAppStore.getState().config!
 useAppStore.setState({config:{...original,workspaces:original.workspaces.map(workspace=>workspace.id===x.scope.workspace.id?{...workspace,path:workspace.path+'/changed'}:workspace)}})
 await expect(saveMoteQuickDefaults(x.scope,values,saved,x.onOpenPath,()=>true,null)).rejects.toThrow('source changed');expect(x.save).not.toHaveBeenCalled()
 useAppStore.setState({config:original});const key=documentKey(x.scope.workspace.id,x.scope.rootPath+'/MOTE.md');useAppStore.setState({dirtyDocuments:{...useAppStore.getState().dirtyDocuments,[key]:true}})
 await expect(saveMoteQuickDefaults(x.scope,values,saved,x.onOpenPath,()=>true,null)).rejects.toThrow('Editor');expect(x.save).not.toHaveBeenCalled();useAppStore.setState({dirtyDocuments:{}})
 saved.pending={kind:'quick',target:x.f.target,operationId:'original-unknown',baseline:{resource:saved.source!.resource!,document:saved.document,defaults:saved.defaults},values:{...values,executorId:'next'}}
 await expect(saveMoteQuickDefaults(x.scope,values,saved,x.onOpenPath,()=>true,null)).rejects.toThrow('unknown result');expect(x.save).not.toHaveBeenCalled();expect(saved.pending.operationId).toBe('original-unknown')
})

it('an original pending request keeps its exact operation, baseline and destination after placement becomes unconfirmed',async()=>{
 const x=await fixture(),saved=await readMoteQuickDefaults(x.scope),values={...saved.defaults,presence:{enabled:true,intervalMs:3600000}}
 const ref=x.f.defaults.conversation!,{hostId:_,sessionId:__,...location}=ref
 const pending={kind:'quick' as const,target:x.f.target,operationId:'retained-original-request',baseline:{resource:saved.source!.resource!,document:saved.document,defaults:saved.defaults},values,destination:{kind:'occurrence' as const,...location}}
 saved.pending=pending;expect(confirmedMoteReference(useAppStore.getState(),x.scope,{reference:null})).toBeNull()
 const result=await saveMoteQuickDefaults(x.scope,values,saved,x.onOpenPath,()=>true,null)
 expect(result.status).toBe('saved');expect(x.save.mock.calls[0]![0]).toBe(pending);expect(x.save).toHaveBeenCalledTimes(1);expect(x.resume).not.toHaveBeenCalled();expect(saved.pending).toBeUndefined();expect(x.f.writes).toEqual([])
})

it('fresh Desktop settings reach original File CAS while optional display discovery is still pending',async()=>{
 const x=await fixture(),catalog=vi.spyOn(x.f.discovery,'catalog').mockImplementation(()=>new Promise(()=>{}))
 await app!.mount(createElement(MoteQuickModeDialog,{scope:x.scope,reference:null,onOpenPath:x.onOpenPath,onClose:x.onClose,returnFocus:()=>null,focusHeartbeat:true}))
 const input=await vi.waitFor(()=>{const node=document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]');expect(node?.value).toBe('30');return node!})
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Your saved settings can still be edited'))
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'60');input.dispatchEvent(new Event('input',{bubbles:true}))});await settleMoteApp()
 const save=[...document.querySelectorAll<HTMLButtonElement>('.mote-quick-mode-dialog button')].find(node=>node.textContent?.trim()==='Save')!
 expect(save.disabled).toBe(false);await moteClick(save);await vi.waitFor(()=>expect(x.onClose,document.body.textContent??'').toHaveBeenCalledTimes(1))
 expect(x.save).toHaveBeenCalledTimes(1);expect(x.save.mock.calls[0]![0]).toMatchObject({kind:'quick',values:{presence:{intervalMs:3600000}}})
 expect(catalog).toHaveBeenCalled();expect(x.f.transitions).toEqual([]);expect(x.f.writes).toEqual([]);expect(x.resume).not.toHaveBeenCalled()
 await x.f.witness('desktop-pending-choices',{request:x.save.mock.calls[0]![0],catalogCalls:catalog.mock.calls.length,closes:x.onClose.mock.calls.length})
})

it('late Desktop choices keep the original baseline and later edit instead of authorizing a changed File',async()=>{
 const x=await fixture(),first=await x.f.read();let release!:()=>void
 const held=new Promise<void>(resolve=>{release=resolve}),read=vi.spyOn(api.motePreferences,'read').mockImplementation(async input=>{
  if(input.kind==='quick'&&input.includeChoices!==false)await held
  return x.f.rpc.call('space.mote.preferences.read',input)
 })
 await app!.mount(createElement(MoteQuickModeDialog,{scope:x.scope,reference:null,onOpenPath:x.onOpenPath,onClose:x.onClose,returnFocus:()=>null,focusHeartbeat:true}))
 const input=await vi.waitFor(()=>{const node=document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]');expect(node?.value).toBe('30');return node!})
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'47');input.dispatchEvent(new Event('input',{bubbles:true}))});await settleMoteApp()
 const changed=(await readFile(x.f.motePath,'utf8'))+'\nA later original file note.\n';await writeFile(x.f.motePath,changed)
 await act(async()=>{release()});await vi.waitFor(()=>expect(read.mock.calls.filter(([value])=>value.kind==='quick'&&value.includeChoices!==false).length).toBeGreaterThan(0))
 await vi.waitFor(()=>expect(document.body.textContent).not.toContain('Your saved settings can still be edited'))
 expect(input.value).toBe('47')
 const save=[...document.querySelectorAll<HTMLButtonElement>('.mote-quick-mode-dialog button')].find(node=>node.textContent?.trim()==='Save')!;await moteClick(save)
 await vi.waitFor(()=>expect(x.save).toHaveBeenCalledTimes(1));expect(x.save.mock.calls[0]![0].baseline.document?.revision).toBe(first.source!.result.status==='read'?first.source!.result.document.revision:null)
 expect(x.save.mock.calls[0]![0]).toMatchObject({kind:'quick',values:{presence:{intervalMs:2820000}}})
 await vi.waitFor(()=>expect(document.body.textContent).toContain('changed'));expect(x.onClose).not.toHaveBeenCalled();expect(input.value).toBe('47');expect(await readFile(x.f.motePath,'utf8')).toBe(changed)
})

it('Desktop scoped discovery failure stays visible while unrelated settings save through their original owner',async()=>{
 const x=await fixture();vi.spyOn(x.f.discovery,'executors').mockRejectedValue(Error('Original Executor discovery unavailable'))
 await app!.mount(createElement(MoteQuickModeDialog,{scope:x.scope,reference:null,onOpenPath:x.onOpenPath,onClose:x.onClose,returnFocus:()=>null,focusHeartbeat:true}))
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Original Executor discovery unavailable'))
 const save=[...document.querySelectorAll<HTMLButtonElement>('.mote-quick-mode-dialog button')].find(node=>node.textContent?.trim()==='Save')!
 expect(save.disabled).toBe(false);await moteClick(save);await vi.waitFor(()=>expect(x.onClose).toHaveBeenCalledTimes(1))
 expect(x.save).toHaveBeenCalledTimes(1);expect(x.save.mock.calls[0]![0]).toMatchObject({kind:'quick',values:{executorId:'original'}});expect(x.f.transitions).toEqual([]);expect(x.f.writes).toEqual([])
})

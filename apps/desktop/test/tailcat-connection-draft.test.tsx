// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { tailcatConnectionDraft } from '../src/renderer/src/lib/tailcat-connection-draft'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import type { AppConfig, HostConfig, SshHostConfig } from '../src/shared/contracts'

const dom=composerDOM(),remote:SshHostConfig={id:'studio',kind:'ssh',label:'Studio',hostname:'',transport:'tailcat',runtimeId:'original-runtime',tailcat:{address:'tc-original-private',keyFile:'original-client'}}
let config:AppConfig
const save=vi.fn(async(_hosts:HostConfig[],_workspaces:AppConfig['workspaces'],_expected:Pick<AppConfig,'hosts'|'workspaces'>)=>{})
beforeEach(()=>{
 installNoteCanvasGeometry();config={...structuredClone(composerConfig),hosts:[structuredClone(composerConfig.hosts[0]!),structuredClone(remote)]}
 useAppStore.setState({config,tailcatConnectionDrafts:{},sessions:[],hostChecks:{}});save.mockReset()
 vi.spyOn(api.hosts,'inspect').mockImplementation(async host=>({routeHostId:host.id,configuration:host,tailcat:{state:'disabled'}}) as never)
 vi.spyOn(api.hosts,'network').mockRejectedValue(Error('Not observed in this private edit fixture'))
 vi.spyOn(api.nodePublishing,'call').mockRejectedValue(Error('Publication is independent of incoming edits'))
})
const show=()=>dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:'studio'}}/>)
const node=()=>dom.render(<NetworkNodeSettingsPane config={config} active onSave={async()=>{}} onNavigate={()=>{}} navigationRequest={{section:'network-node',hostId:'local'}}/>)
async function fill(label:string,value:string){const input=dom.container.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;expect(input).not.toBeNull();await act(async()=>{const detail=input.closest('details');if(detail)detail.open=true;Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
async function click(text:string){const button=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text);expect(button).toBeDefined();await act(async()=>button!.click())}
const value=(label:string)=>dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value
const read=(scope:string,id:string)=>tailcatConnectionDraft((useAppStore.getState().tailcatConnectionDrafts as Record<string,Record<string,unknown>>)[scope]?.[id])

it('the original Host editor restores unsent fields and the original save baseline without a config write',async()=>{
 await show();await fill('Tailcat address','tc-unsent-private');await fill('Tailcat client key','unsent-key')
 const original=structuredClone(useAppStore.getState().tailcatConnectionDrafts)
 expect(read('hosts','studio')?.expected).toEqual(remote)
 await dom.render(null);await show()
 expect(value('Tailcat address')).toBe('tc-unsent-private');expect(value('Tailcat client key')).toBe('unsent-key')
 expect(useAppStore.getState().tailcatConnectionDrafts).toEqual(original);expect(save).not.toHaveBeenCalled()
 await click('Save hosts');expect(save.mock.calls[0]![2].hosts.find(h=>h.id==='studio')).toEqual(remote)
 expect(read('hosts','studio')).toBeNull()
})
it('a changed Runtime or reused route never inherits the original retained connection edit',async()=>{
 await show();await fill('Tailcat address','tc-private-original-edit');await dom.render(null)
 const retained=structuredClone(useAppStore.getState().tailcatConnectionDrafts)
 config={...config,hosts:[config.hosts[0]!,{...remote,runtimeId:'replacement-runtime',tailcat:{...remote.tailcat!,address:'tc-replacement'}}]};useAppStore.setState({config})
 await show();expect(value('Tailcat address')).toBe('tc-replacement');expect(dom.container.textContent).toContain('not applied to another target')
 expect(useAppStore.getState().tailcatConnectionDrafts).toEqual(retained);expect(save).not.toHaveBeenCalled()
  await fill('Tailcat client key','replacement-unsent-key')
  expect(read('hosts','studio')?.value.tailcat?.keyFile).toBe('replacement-unsent-key')
  expect(read('hosts','studio')?.retained).toHaveLength(1)
  expect(tailcatConnectionDraft(read('hosts','studio')?.retained?.[0])?.value.tailcat?.address).toBe('tc-private-original-edit')
  const partial=useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as {tailcatConnectionDrafts:unknown}
  await dom.render(null);useAppStore.setState({tailcatConnectionDrafts:JSON.parse(JSON.stringify(partial.tailcatConnectionDrafts))});await show()
  expect(value('Tailcat client key')).toBe('replacement-unsent-key');expect(read('hosts','studio')?.retained).toHaveLength(1)
  await click('Discard this retained edit');expect(read('hosts','studio')?.retained ?? []).toEqual([])
  expect(read('hosts','studio')?.value.tailcat?.keyFile).toBe('replacement-unsent-key')
})
it('a new unsaved Tailcat Host is restored as a draft with no invented saved baseline',async()=>{
 const authored={...remote,id:'new-host',label:'New draft',tailcat:{address:'tc-new-unsent',keyFile:'new-key'}}
 useAppStore.setState({tailcatConnectionDrafts:{hosts:{'new-host':{value:authored}}}})
 await dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:'new-host'}}/>)
 expect(value('Tailcat address')).toBe('tc-new-unsent');expect(save).not.toHaveBeenCalled()
 await click('Save hosts');expect(save.mock.calls[0]![0]).toContainEqual(authored);expect(save.mock.calls[0]![2].hosts).not.toContainEqual(expect.objectContaining({id:'new-host'}))
})
it('the real receiving editor retains literal allowed-code text and key input across remount',async()=>{
 await node();const text='  nodekey:'+ 'cd'.repeat(32)+'  \n\n';await fill('Tailcat allowed clients',text);await fill('Tailcat server key','retained-server')
 expect(read('incoming','local')?.allowedText).toBe(text);await dom.render(null);await node()
 expect(value('Tailcat allowed clients')).toBe(text);expect(value('Tailcat server key')).toBe('retained-server')
 expect(save).not.toHaveBeenCalled();expect((useAppStore.getState().config!.hosts[0]!).tailcat).toBeUndefined()
})
it('opaque original edit bytes survive while the current editor and healthy work remain available',async()=>{
 const raw={hosts:{studio:{unrecognized:'retain-this-input'}},incoming:'future-format'};useAppStore.setState({tailcatConnectionDrafts:raw})
 await show();await fill('Tailcat client key','current-edit')
 expect(value('Tailcat client key')).toBe('current-edit');expect(read('hosts','studio')?.retained?.[0]).toBe(raw.hosts.studio)
 expect(read('hosts','studio')?.value.tailcat?.keyFile).toBe('current-edit')
 expect(dom.container.textContent).toContain('retained edit');expect(save).not.toHaveBeenCalled()
 await dom.render(null);await node();await fill('Tailcat server key','new-receiving-edit')
 const rawScope=(useAppStore.getState().tailcatConnectionDrafts as {incoming:Record<string,unknown>}).incoming
 expect(Object.values(rawScope)).toContain('future-format');expect(read('incoming','local')?.value.tailcat?.keyFile).toBe('new-receiving-edit')
})

it('the original user-document partializer includes literal private edits and leaves configuration unchanged',async()=>{
 await show();await fill('Tailcat address','tc-unsaved-document');const before=config
 const partial=useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as {tailcatConnectionDrafts:unknown}
 expect(partial.tailcatConnectionDrafts).toEqual(useAppStore.getState().tailcatConnectionDrafts)
 expect(JSON.stringify(partial.tailcatConnectionDrafts)).toContain('tc-unsaved-document');expect(useAppStore.getState().config).toBe(before)
})

it('a rejected original save keeps the old CAS baseline and the authored edit without retry',async()=>{
 save.mockRejectedValue(Object.assign(Error('Original configuration changed'),{code:'CONFIG_CONFLICT'}))
 await show();await fill('Tailcat client key','keep-after-conflict');await click('Save hosts')
 expect(save).toHaveBeenCalledOnce();expect(read('hosts','studio')?.expected).toEqual(remote)
 await dom.render(null);await show();expect(value('Tailcat client key')).toBe('keep-after-conflict')
 expect(save).toHaveBeenCalledOnce()
})

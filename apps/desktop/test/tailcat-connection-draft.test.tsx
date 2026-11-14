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

it('ordinary SSH fields and the selected Host survive a native-document round trip without a config write', async () => {
 const ssh:SshHostConfig={id:'ordinary-ssh',kind:'ssh',label:'Original SSH',hostname:'original.invalid',runtimeId:'original-runtime',remoteCommand:'/original/amux'}
 config={...config,hosts:[config.hosts[0]!,ssh]}
 const opaque={future:'keep-private-neighbor'}
 useAppStore.setState({config,tailcatConnectionDrafts:{hosts:{opaque},incoming:{future:'keep-incoming'}}})
 await dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:ssh.id}}/>)
 const input=dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Unsent SSH name');input.dispatchEvent(new Event('input',{bubbles:true}))})
 expect(read('hosts',ssh.id)?.value.label).toBe('Unsent SSH name')
 expect(read('hosts',ssh.id)?.expected).toEqual(ssh)
 const partial=useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as {tailcatConnectionDrafts:unknown}
 await dom.render(null);useAppStore.setState({tailcatConnectionDrafts:JSON.parse(JSON.stringify(partial.tailcatConnectionDrafts))})
 await dom.render(<HostSettingsPane config={config} active onSave={save}/>)
 expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(ssh.id)
 expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')?.value).toBe('Unsent SSH name')
 expect(dom.container.querySelector('[data-host-upgrade]')).not.toBeNull()
 expect((useAppStore.getState().tailcatConnectionDrafts as {hosts:Record<string,unknown>}).hosts.opaque).toEqual(opaque)
 expect((useAppStore.getState().tailcatConnectionDrafts as {incoming:unknown}).incoming).toEqual({future:'keep-incoming'})
 expect(save).not.toHaveBeenCalled()
})
it('an ordinary SSH replacement Runtime does not inherit the old edit or rewrite its retained input',async()=>{
 const ssh:SshHostConfig={id:'ordinary-ssh',kind:'ssh',label:'Original SSH',hostname:'original.invalid',runtimeId:'original-runtime'}
 config={...config,hosts:[config.hosts[0]!,ssh]};useAppStore.setState({config})
 await dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:ssh.id}}/>)
 const input=dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Keep the original edit');input.dispatchEvent(new Event('input',{bubbles:true}))})
 const original=structuredClone(useAppStore.getState().tailcatConnectionDrafts)
 expect(read('hosts',ssh.id)?.expected).toEqual(ssh)
 await dom.render(null)
 config={...config,hosts:[config.hosts[0]!,{...ssh,label:'Replacement SSH',runtimeId:'replacement-runtime'}]};useAppStore.setState({config})
 await dom.render(<HostSettingsPane config={config} active onSave={save}/>)
 expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')?.value).toBe('Replacement SSH')
 expect(dom.container.textContent).toContain('not applied to another target')
 expect(useAppStore.getState().tailcatConnectionDrafts).toEqual(original)
 expect(save).not.toHaveBeenCalled()
})

it('maintenance branch changes and a late receipt preserve the selected SSH Host and its newer unsaved edit',async()=>{
 vi.spyOn(api.hosts,'inspect').mockRejectedValue(Error('Runtime observation is unavailable in this maintenance fixture'))
 const ssh:SshHostConfig={id:'ordinary-ssh',kind:'ssh',label:'Original SSH',hostname:'original.invalid',runtimeId:'original-runtime',remoteCommand:'/original/amux',remoteSocketPath:'/original/control.sock'}
 config={...config,hosts:[config.hosts[0]!,ssh]};useAppStore.setState({config})
 const expected={targetDigest:'a'.repeat(64),runtimeId:'original-runtime',ownerInstanceId:'original-owner',processId:10,startTicks:'1',candidateDigest:'b'.repeat(64),nativeInstanceId:'original-native',nativeProcessId:11,nativeStartTicks:'2'}
 const candidate={digest:expected.candidateDigest,sourceCommit:'original-candidate',version:'0.1.0',ownerProtocolVersion:2,requiredNativeProtocolVersion:25}
 vi.spyOn(api.hosts,'upgradeCheck').mockImplementation(async input=>({input,eligible:true,reason:'ready',detail:'Core-only update',candidate,expected,current:{state:'available',observedAt:1,version:'0.1.0',sourceCommit:'original-source',deploymentDigest:'c'.repeat(64),ownerProtocolVersion:2,runtimeId:ssh.runtimeId!,ownerInstanceId:'original-owner',processId:10,native:{instanceId:'original-native',buildId:'original-native-build',protocolVersion:25}}}))
 let finish!:()=>void
 const pending=new Promise<void>(resolve=>{finish=resolve})
 const upgrade=vi.spyOn(api.hosts,'upgrade').mockImplementation(async(input,expected,operationId)=>{await pending;return{input,expected,operationId,status:'unknown',stage:'starting',detail:'Original reply unconfirmed',updatedAt:1}})
 await dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:ssh.id}}/>)
 await dom.click('[data-upgrade-action]')
 expect(upgrade).toHaveBeenCalledOnce()
 const input=dom.container.querySelector<HTMLInputElement>('[data-host-name]')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Keep the newer SSH edit');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await dom.click('[data-host-panel="overview"]')
 await act(async()=>finish())
 await dom.click('[data-host-panel="connection"]')
 expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(ssh.id)
 expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')?.value).toBe('Keep the newer SSH edit')
 expect(read('hosts',ssh.id)?.expected).toEqual(ssh)
 expect(dom.container.textContent).toContain('Original upgrade result unconfirmed')
 expect(upgrade).toHaveBeenCalledExactlyOnceWith(ssh,expected,expect.any(String))
 expect(save).not.toHaveBeenCalled()
})

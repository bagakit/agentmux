// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { MeshSettingsPane } from '../src/renderer/src/components/settings/MeshSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { tailcatConnectionDraft } from '../src/renderer/src/lib/tailcat-connection-draft'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import type { AppConfig, HostConfig, SshHostConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'

const dom=composerDOM(),remote:SshHostConfig={id:'studio',kind:'ssh',label:'Studio',hostname:'',transport:'tailcat',runtimeId:'original-runtime',tailcat:{address:'tc-original-private',keyFile:'original-client'}}
let config:AppConfig
const save=vi.fn(async(_hosts:HostConfig[],_workspaces:AppConfig['workspaces'],_expected:Pick<AppConfig,'hosts'|'workspaces'>)=>{})
beforeEach(()=>{
 installNoteCanvasGeometry();config={...structuredClone(composerConfig),hosts:[structuredClone(composerConfig.hosts[0]!),structuredClone(remote)]}
 useAppStore.setState({config,tailcatConnectionDrafts:{},sessions:[],hostChecks:{}});save.mockReset()
 vi.spyOn(api.hosts,'inspect').mockImplementation(async host=>({routeHostId:host.id,configuration:host,tailcat:{state:'disabled'},owner:{state:'unavailable',message:'Runtime observation is outside this draft test',readAt:1},nativeIdentity:{state:'unavailable',message:'Native identity is outside this draft test',readAt:1},diagnostics:{state:'unavailable',message:'Diagnostics are outside this draft test',readAt:1},resources:{state:'unavailable',message:'Resources are outside this draft test',readAt:1}}) as never)
 vi.spyOn(api.hosts,'network').mockRejectedValue(Error('Not observed in this private edit fixture'))
 vi.spyOn(api.nodePublishing,'call').mockRejectedValue(Error('Publication is independent of incoming edits'))
 vi.spyOn(api.mesh,'call').mockRejectedValue(Error('Network observation is independent of retained incoming edits'))
})
const show=()=>dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId:'studio'}}/>)
const host=(hostId='local')=>dom.render(<HostSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId}}/>)
const mesh=(hostId='local')=>dom.render(<MeshSettingsPane config={config} active onSave={save} navigationRequest={{section:'hosts',hostId}}/>)
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
  const retainedEdit=tailcatConnectionDraft(read('hosts','studio')?.retained?.[0])
  expect(retainedEdit?.value.kind==='ssh' ? retainedEdit.value.tailcat?.address : undefined).toBe('tc-private-original-edit')
  const privateDestination = dom.container.querySelector<HTMLInputElement>('.host-check-detail details input[type="password"]')!
  expect(privateDestination.readOnly).toBe(true)
  expect(privateDestination.value).toBe('tc-private-original-edit')
  expect(dom.container.textContent).not.toContain('tc-private-original-edit')
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
 await host();const text='  nodekey:'+ 'cd'.repeat(32)+'  \n\n';await fill('Tailcat allowed clients',text);await fill('Tailcat server key','retained-server')
 expect(read('incoming','local')?.allowedText).toBe(text);await dom.render(null);await host()
 expect(value('Tailcat allowed clients')).toBe(text);expect(value('Tailcat server key')).toBe('retained-server')
 expect(save).not.toHaveBeenCalled();expect((useAppStore.getState().config!.hosts[0]!).tailcat).toBeUndefined()
})
it('saved clean listener stops helper I/O while hidden and resumes it on the real local Connection',async()=>{
 const scratch={...composerConfig.workspaces[0]!,id:SCRATCH_WORKSPACE_ID,name:'Motes'}
 const leader:ScratchTopicSnapshot={id:PMO_TEAMS_TOPIC_ID,title:'Mote',summary:'',collaborators:[],kind:'mote',directoryPath:scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID),topicPath:scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)+'/topic.md',soul:{path:scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)+'/SOUL.md',content:'Helper',version:'v1'}}
 const plain:SshHostConfig={id:'studio',kind:'ssh',label:'Studio',hostname:'studio.invalid',runtimeId:'original-runtime'}
 config={...structuredClone(composerConfig),hosts:[structuredClone(composerConfig.hosts[0]!),plain],workspaces:[...composerConfig.workspaces,scratch]}
 const target=topicSpaceIconTarget(scratch,leader)!,fileName='a'.repeat(64)+'.png'
 useLauncherState.setState({moteTopicId:null})
 useAppStore.setState({config,spaceObjectIcons:{[target.key]:{kind:'image',fileName}},workspaceFileRevisions:{[SCRATCH_WORKSPACE_ID]:0},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:JSON.stringify([scratch.hostId,scratch.path]),revision:0,reading:true,error:null,topics:[leader]}}})
 const listTopics=vi.spyOn(api.scratch,'listTopics').mockResolvedValue([leader] as never)
 let rejectAvatar!:(cause:unknown)=>void
 const readAvatar=vi.spyOn(api.scratch,'readMoteAvatar').mockImplementationOnce(()=>new Promise<never>((_,reject)=>{rejectAvatar=reject})).mockResolvedValue({dataUrl:'data:image/png;base64,AA==',width:1,height:1})
 const report=vi.spyOn(useAppStore.getState(),'reportError'),inspect=vi.mocked(api.hosts.inspect)
 let signal:AbortSignal|undefined
 inspect.mockImplementationOnce(async(_host,context)=>{signal=context?.signal;return await new Promise<never>(()=>{})})
 await mesh()
 await vi.waitFor(()=>{expect(inspect).toHaveBeenCalledTimes(1);expect(listTopics).toHaveBeenCalledTimes(1);expect(readAvatar).toHaveBeenCalledTimes(1)})
 expect(signal?.aborted).toBe(false)
 await dom.click('[data-resource-editor] [data-host-panel="agents"]')
 expect(signal?.aborted).toBe(true)
 await act(async()=>useAppStore.setState({workspaceFileRevisions:{[SCRATCH_WORKSPACE_ID]:1},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:JSON.stringify([scratch.hostId,scratch.path]),revision:1,reading:true,error:null,topics:[leader]}}}))
 await mesh('studio')
 await act(async()=>useAppStore.setState({workspaceFileRevisions:{[SCRATCH_WORKSPACE_ID]:2}}))
 await dom.click('.mesh-editor-navigation button')
 expect(inspect).toHaveBeenCalledTimes(1);expect(listTopics).toHaveBeenCalledTimes(1);expect(readAvatar).toHaveBeenCalledTimes(1)
 await act(async()=>rejectAvatar(new Error('Hidden avatar read failed')))
 expect(report.mock.calls.filter(call=>String(call[0]).includes('Mote avatar'))).toHaveLength(0)
 await dom.click('.mesh-view-tabs button:nth-child(2)')
 await act(async()=>useAppStore.setState({workspaceFileRevisions:{[SCRATCH_WORKSPACE_ID]:3},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:JSON.stringify([scratch.hostId,scratch.path]),revision:3,reading:true,error:null,topics:[leader]}}}))
 await mesh('local')
 await vi.waitFor(()=>{expect(inspect).toHaveBeenCalledTimes(2);expect(listTopics).toHaveBeenCalledTimes(2);expect(readAvatar).toHaveBeenCalledTimes(2)})
 expect(report.mock.calls.filter(call=>String(call[0]).includes('Mote avatar'))).toHaveLength(0)
})
it('retains an in-flight incoming save and later literal edits across Host, panel and Mesh switches without hidden inspection',async()=>{
 let finish!:()=>void
 const configure=vi.spyOn(api.hosts,'configureTailcat').mockImplementation(()=>new Promise<never>(resolve=>{finish=()=>resolve({} as never)}))
 const inspect=vi.mocked(api.hosts.inspect)
 await mesh();const initialReads=inspect.mock.calls.length
 await fill('Tailcat server key','submitted-server');await click('Save incoming connections')
 const text='  nodekey:'+'ef'.repeat(32)+'  \n\n';await fill('Tailcat allowed clients',text);await fill('Tailcat server key','later-server')
 await dom.click('[data-resource-editor] [data-host-panel="agents"]');expect(inspect).toHaveBeenCalledTimes(initialReads)
 await mesh('studio');expect(inspect).toHaveBeenCalledTimes(initialReads)
 const retainedIncoming=[...dom.container.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
 expect(retainedIncoming).toHaveLength(1)
 expect(retainedIncoming.every(node=>node.hidden||node.closest('[hidden]')||node.inert||node.closest('[inert]'))).toBe(true)
 await mesh('local');await dom.click('.mesh-editor-navigation button');expect(inspect).toHaveBeenCalledTimes(initialReads)
 await dom.click('.mesh-view-tabs button:nth-child(2)')
 expect(value('Tailcat allowed clients')).toBe(text);expect(value('Tailcat server key')).toBe('later-server')
 expect(dom.container.querySelector('[data-settings-field="incoming"] [data-settings-save-bar]')?.textContent).toContain('Saving Incoming connections')
 await act(async()=>finish())
 expect(configure).toHaveBeenCalledTimes(1);expect(save).not.toHaveBeenCalled()
 expect(value('Tailcat allowed clients')).toBe(text);expect(value('Tailcat server key')).toBe('later-server')
 expect(read('incoming','local')?.allowedText).toBe(text);expect(read('hosts','local')).toBeNull()
})
it('opaque original edit bytes survive while the current editor and healthy work remain available',async()=>{
 const raw={hosts:{studio:{unrecognized:'retain-this-input'}},incoming:'future-format'};useAppStore.setState({tailcatConnectionDrafts:raw})
 await show();await fill('Tailcat client key','current-edit')
 expect(value('Tailcat client key')).toBe('current-edit');expect(read('hosts','studio')?.retained?.[0]).toBe(raw.hosts.studio)
 expect(read('hosts','studio')?.value.tailcat?.keyFile).toBe('current-edit')
 expect(dom.container.textContent).toContain('retained edit');expect(save).not.toHaveBeenCalled()
 await dom.render(null);await host();await fill('Tailcat server key','new-receiving-edit')
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
 await dom.click('[data-resource-editor] [data-host-panel="overview"]')
 await act(async()=>finish())
 await dom.click('[data-resource-editor] [data-host-panel="connection"]')
 expect(dom.container.querySelector('[data-resource-editor]')?.getAttribute('data-resource-editor')).toBe(ssh.id)
 expect(dom.container.querySelector<HTMLInputElement>('[data-host-name]')?.value).toBe('Keep the newer SSH edit')
 expect(read('hosts',ssh.id)?.expected).toEqual(ssh)
 expect(dom.container.textContent).toContain('Original upgrade result unconfirmed')
 expect(upgrade).toHaveBeenCalledExactlyOnceWith(ssh,expected,expect.any(String))
 expect(save).not.toHaveBeenCalled()
})

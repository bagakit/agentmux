// @vitest-environment node
import { act } from 'react'
import { afterEach,expect,it,vi } from 'vitest'
import { Window } from 'happy-dom'
import { join } from 'node:path'
import { createMoteInputFixture,moteInputTestSource } from '../../../packages/core/test/helpers/mote-input-owner'
import { createHostContent } from '../../host/src/content-owner'
import { createHostMoteMainReader,createHostMoteDialogue } from '../../host/src/mote-dialogue'
import { HostMoteQuickPreferences } from '../../host/src/mote-quick-preferences'
import { MoteDialogueStore } from '../../../packages/core/src/mote-dialogue-store'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { spatialCatalog } from '../../../packages/core/src/spatial-state'
import { registerMoteDialogueIpc } from '../src/main/mote-dialogue-ipc'
import { parseMoteDialogueResult } from '@agentmux/core/mote-dialogue'
vi.hoisted(()=>vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
const closes:Array<()=>void|Promise<unknown>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllGlobals()})
it('actual entry consumer crosses trusted Main IPC and original Unix Host/Core continuity without input or a replacement Run',async()=>{
 const f=await createMoteInputFixture();closes.push(f.close)
 const target={spaceId:moteInputTestSource.spaceId,zoneId:moteInputTestSource.zoneId,expectedResource:{hostId:'local',workspaceId:'__scratch__',workspacePath:join(f.root,'scratch')}}
 const content=createHostContent({configurationPath:join(f.root,'configuration.json'),spatial:f.spatial}),main=createHostMoteMainReader({configurationPath:join(f.root,'configuration.json'),spatial:f.spatial,files:content.files!})
 const dialogue=createHostMoteDialogue({main,spatial:f.spatial,store:new MoteDialogueStore(join(f.root,'entry-dialogue.sqlite')),clientForHost:()=>f.client})
 const quick=new HostMoteQuickPreferences({main,files:content.files!,catalog:async()=>spatialCatalog((await f.spatial.read())!.graph),executors:async()=>[]})
 const server=new AgentMuxControlServer({socketPath:join(f.root,'entry-consumer.sock'),coreClients:f.coreClients,moteDialogue:dialogue,moteQuickPreferences:quick})
 await server.start();closes.push(()=>server.stop());const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});closes.push(()=>rpc.dispose())
 const window=new Window()
 for(const key of ['window','document','navigator','localStorage','sessionStorage','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver'])vi.stubGlobal(key,key==='window'?window:window[key as keyof Window])
 vi.stubGlobal('getComputedStyle',window.getComputedStyle.bind(window));vi.stubGlobal('requestAnimationFrame',window.requestAnimationFrame.bind(window));vi.stubGlobal('cancelAnimationFrame',window.cancelAnimationFrame.bind(window));vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);closes.push(()=>window.close())
 const {useAppStore}=await import('../src/renderer/src/store')
 const {api}=await import('../src/renderer/src/lib/api')
 const {useMoteMainEntry}=await import('../src/renderer/src/lib/mote-main-entry')
 const {MoteDialogueViewProvider}=await import('../src/renderer/src/lib/mote-dialogue-view')
 const {createClientUiRoot}=await import('./helpers/client-ui-render')
 const {defaultAgent,moteTopics,scratchWorkspace}=await import('./fixtures/mote-workface')
 const original=await main.readCurrentMoteMain(target);expect(original.current?.sessionId).toBe('primary')
 const workspace={...scratchWorkspace,path:target.expectedResource.workspacePath},topic={...moteTopics[0]!,id:f.graph.spaces[0]!.topicId!,directoryPath:f.graph.zones[0]!.directoryPath!,readError:'Directory listing temporarily unavailable'},scope={workspace,topic,rootPath:f.graph.zones[0]!.directoryPath!}
 const session={...defaultAgent,id:'primary',workspacePath:f.root,control:{kind:'agent' as const,hostId:'local',agentSessionId:'primary',run:{runId:'run-primary'}},processState:'exited' as const}
 useAppStore.setState({sessions:[session],spaceZoneBindings:{[target.zoneId]:{spaceId:target.spaceId,workspaceId:workspace.id,topicId:topic.id,contentKind:'mote',directoryPath:topic.directoryPath}}})
 const refresh=vi.spyOn(useAppStore.getState(),'refreshSession').mockResolvedValue(session),start=vi.fn(()=>{throw Error('This live original Run cannot Start again')});f.inner.kernel.start=start
 const channels=new Map<string,(event:import('electron').IpcMainInvokeEvent,input:unknown)=>Promise<unknown>>(),humanEvent={} as import('electron').IpcMainInvokeEvent
 const trust=vi.fn((_channel:string,event:import('electron').IpcMainInvokeEvent)=>{if(event!==humanEvent)throw Error('Foreign renderer sender')})
 const bridge=vi.fn(async(hostId:string,method:import('@agentmux/core').AgentMuxRpcMethod,input:unknown)=>{expect(hostId).toBe(target.expectedResource.hostId);return await rpc.call(method,input as never)})
 registerMoteDialogueIpc({handleWithEvent:(channel,handler)=>{channels.set(channel,handler)},assertTrusted:trust,runtime:{callOriginalCore:bridge as import('../src/main/runtime-controller').RuntimeController['callOriginalCore']}})
 vi.spyOn(api.moteDialogue,'read').mockImplementation(async input=>parseMoteDialogueResult('space.mote.dialogue.read',await channels.get('moteDialogue:read')!(humanEvent,input),input))
 const inspect=vi.spyOn(api.moteDialogue,'inspectRecovery').mockImplementation(async input=>parseMoteDialogueResult('space.mote.dialogue.recovery.inspect',await channels.get('moteDialogue:recovery:inspect')!(humanEvent,input),input))
 const ensure=vi.spyOn(api.moteDialogue,'ensureRecovery').mockImplementation(async input=>parseMoteDialogueResult('space.mote.dialogue.recovery.ensure',await channels.get('moteDialogue:recovery:ensure')!(humanEvent,input),input))
 function Entry(){const state=useMoteMainEntry({scope,active:true,entryToken:'explicit-original-open'});return <output data-entry-status={state.status}>{state.issue}</output>}
 const container=document.createElement('div');document.body.append(container);const root=createClientUiRoot(container);closes.push(async()=>{await act(async()=>root.unmount());container.remove()})
 await act(async()=>root.render(<MoteDialogueViewProvider scope={scope} active><Entry/></MoteDialogueViewProvider>))
 await vi.waitFor(()=>expect(container.querySelector('output')?.getAttribute('data-entry-status'),container.textContent??'').toBe('settled'),{timeout:5000})
 expect(inspect).toHaveBeenCalledTimes(1);expect(ensure).toHaveBeenCalledTimes(1);expect(refresh).toHaveBeenCalledWith('primary')
 const request=ensure.mock.calls[0]![0],retained=(await f.client.readAgentSession('primary'))?.continuityOperations?.[request.operationId]
 expect(retained).toMatchObject({kind:'reattachable',agentSessionId:'primary',previousRun:{runId:'run-primary'},moteMainEntry:{target,reference:original.current,expectedRoleRevision:original.roleRevision}})
 expect(trust.mock.calls.map(row=>row[0])).toEqual(['moteDialogue:read','moteDialogue:recovery:inspect','moteDialogue:recovery:ensure'])
 expect(start).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled();expect(f.writes).toEqual([])
},45000)

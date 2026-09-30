import {EventEmitter} from 'node:events'
import {expect,it,vi} from 'vitest'
import {AgentMuxMemoryAgentSessionStore,type AgentMuxClient,type AgentSessionHistoryPage,type AgentSessionHistoryObservationHandle} from '@agentmux/core'
import type {BrowserWindow,IpcMainInvokeEvent} from 'electron'
import type {AgentMuxPreloadApi,AgentSessionControl,AppConfig} from '../src/shared/contracts'
import {SESSION_HISTORY_OBSERVATION_CHANNEL} from '../src/shared/contracts'
import type {ConfigStore} from '../src/main/config-store'
import type {ScratchTopics} from '../src/main/scratch-topics'
import type {WorkspaceFiles} from '../src/main/workspace-files'
import {RuntimeController} from '../src/main/runtime-controller'
const preload=vi.hoisted(()=>({api:null as AgentMuxPreloadApi|null,invoke:vi.fn(),handlers:new Map<string,Function>(),receivers:new Map<string,Function>()}))
vi.mock('electron',()=>({
 contextBridge:{exposeInMainWorld:(_name:string,api:AgentMuxPreloadApi)=>{preload.api=api}},
 ipcRenderer:{invoke:preload.invoke,on:(channel:string,listener:Function)=>preload.receivers.set(channel,listener),removeListener:(channel:string,listener:Function)=>{if(preload.receivers.get(channel)===listener)preload.receivers.delete(channel)},off:vi.fn(),send:vi.fn()},webFrame:{getZoomFactor:()=>1},
 app:{getPath:()=>'/isolated-history-ipc-test'},
 ipcMain:{handle:(channel:string,handler:Function)=>preload.handlers.set(channel,handler),removeHandler:(channel:string)=>preload.handlers.delete(channel),on:vi.fn(),removeListener:vi.fn()},
 clipboard:{},dialog:{},nativeImage:{},shell:{}
}))
vi.mock('@agentmux/core',async(importOriginal)=>({...await importOriginal<typeof import('@agentmux/core')>(),
 AgentMuxControlServer:class{async start(){} async stop(){}}
}))
vi.mock('@agentmux/demand',()=>({openDemandStore:()=>({})}))
vi.mock('../src/main/browser-profile-manager',()=>({BrowserProfileManager:class{async initialize(){} async dispose(){}}}))
vi.mock('../src/main/browser-operation-journal',()=>({BROWSER_OPERATION_JOURNAL_FILE:'isolated-journal.json',BrowserOperationFileStore:class{},BrowserOperationJournal:class{async ready(){}}}))
vi.mock('../src/main/browser-ref-ledger-store',()=>({BrowserRefLedgerStore:class{}}))
vi.mock('../src/main/browser-view-manager',()=>({BrowserViewManager:class{dispose(){}}}))
vi.mock('../src/main/agent-notifier',()=>({createAgentNotifier:()=>({dispose(){}})}))
import '../src/preload/index'
import {registerIpc} from '../src/main/ipc'
import {DEFAULT_CONFIG} from '../src/main/config-store'
const control:AgentSessionControl={kind:'agent',hostId:'synthetic-host',agentSessionId:'synthetic-session',run:{runId:'healthy-run'}}
const page:AgentSessionHistoryPage={agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'native-main'},items:[{id:'persisted-item',kind:'user-message',contentParts:[{kind:'text',text:'original  \n'},{kind:'resource',resourceType:'image',reference:'/synthetic/screenshot.png'}]}],nextCursor:'opaque'}
async function owner(){
 const store=new AgentMuxMemoryAgentSessionStore()
 await store.compareAndSwap(null,{kind:'agent',agentSessionId:control.agentSessionId,providerId:'codex',executorId:'specific-codex',hostId:control.hostId,
 workspacePath:'/synthetic',run:control.run,retiredRuns:[],hookBindingId:'private-binding',hookToken:'private-token',createdAt:1,updatedAt:1,
 nativeHandle:{kind:'provider',providerId:'codex',sessionId:'native-main'}})
 const controller=new RuntimeController(store)
 const client={observeSessionHistory:vi.fn(),sessionHistoryPage:vi.fn().mockResolvedValue(page),writeAgent:vi.fn().mockResolvedValue(undefined),connect:vi.fn().mockResolvedValue(undefined),onEvent:vi.fn().mockReturnValue(vi.fn()),dispose:vi.fn().mockResolvedValue(undefined)}
 controller.commit({hosts:[{id:control.hostId,client:client as unknown as AgentMuxClient,executionHost:{kind:'local',dispose:vi.fn()} as never}],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 const config:AppConfig={...structuredClone(DEFAULT_CONFIG),executors:{
 'specific-codex':{providerId:'codex',label:'Specific Codex',command:'/synthetic/specific-codex',args:['--config','model="specific"'],env:{CODEX_HOME:'/synthetic/specific-home'},injectAgentMuxGuide:false},
 'other-codex':{providerId:'codex',label:'Other Codex',command:'/synthetic/other-codex',args:[],env:{CODEX_HOME:'/synthetic/other-home'},injectAgentMuxGuide:false}
 }}
 return{controller,client,config,store}
}
it('actual preload/registered IPC/RuntimeController use trusted exact durable Executor invocation without connecting a Run',async()=>{
 const {controller,client,config}=await owner()
 client.connect.mockRejectedValue(new Error('synthetic Runtime is temporarily unavailable'))
 vi.spyOn(controller,'prepare').mockResolvedValue({hosts:[],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 const sender=Object.assign(new EventEmitter(),{id:77,isDestroyed:()=>false,send:vi.fn()})
 const dispose=await registerIpc({window:{webContents:sender} as unknown as BrowserWindow,runtime:controller,progressLoops:{subscribe:()=>()=>{}} as never,
 configStore:{get:async()=>config} as unknown as ConfigStore,scratchTopics:{} as ScratchTopics,
 workspaceFiles:{dispose:async()=>{}} as unknown as WorkspaceFiles})
 try{
  const handler=preload.handlers.get('sessions:historyPage')
  expect(handler).toBeTypeOf('function')
  preload.invoke.mockImplementation((channel:string,subject:AgentSessionControl,options)=>{
   expect(channel).toBe('sessions:historyPage');return handler!({sender} as unknown as IpcMainInvokeEvent,subject,options)
  })
  expect(preload.api).not.toBeNull()
  await expect(preload.api!.sessions.historyPage(control,{cursor:'native-opaque',limit:30})).resolves.toBe(page)
  expect(client.connect).not.toHaveBeenCalled()
  expect(client.sessionHistoryPage).toHaveBeenCalledExactlyOnceWith('synthetic-session',{
   cursor:'native-opaque',limit:30,commandOverride:'/synthetic/specific-codex',args:['--config','model="specific"'],env:{CODEX_HOME:'/synthetic/specific-home'}
  })
 }finally{await dispose()}
})
it('picks only Renderer page fields and never accepts a command/environment override from IPC input',async()=>{
 const {controller,client,config}=await owner()
 await controller.sessionHistoryPage(control,{cursor:'opaque',limit:5,commandOverride:'/untrusted/command',args:['untrusted'],env:{CODEX_HOME:'/untrusted/home'}} as never,config)
 expect(client.sessionHistoryPage).toHaveBeenCalledExactlyOnceWith(control.agentSessionId,{
  cursor:'opaque',limit:5,commandOverride:'/synthetic/specific-codex',args:['--config','model="specific"'],env:{CODEX_HOME:'/synthetic/specific-home'}
 })
})
it('rejects another Session response and refuses Terminal control without native calls',async()=>{
 const {controller,client,config}=await owner()
 client.sessionHistoryPage.mockResolvedValueOnce({...page,agentSessionId:'foreign-session'})
 await expect(controller.sessionHistoryPage(control,undefined,config)).rejects.toThrow('another Session')
 client.sessionHistoryPage.mockClear()
 await expect(controller.sessionHistoryPage({kind:'terminal',hostId:'synthetic-host',runId:'healthy-run',run:{runId:'healthy-run'}} as unknown as AgentSessionControl,undefined,config)).rejects.toThrow('requires an Agent Session')
 expect(client.connect).not.toHaveBeenCalled();expect(client.sessionHistoryPage).not.toHaveBeenCalled()
})
it.each(['missing-executor','wrong-provider','wrong-host'])('fails %s reading without calling Core or changing the independent input path',async reason=>{
 const {controller,client,config}=await owner()
 if(reason==='missing-executor') delete config.executors['specific-codex']
 if(reason==='wrong-provider') config.executors['specific-codex']!.providerId='claude'
 await expect(controller.sessionHistoryPage(reason==='wrong-host'?{...control,hostId:'other-host'}:control,undefined,config)).rejects.toThrow()
 expect(client.sessionHistoryPage).not.toHaveBeenCalled()
 expect(client.connect).not.toHaveBeenCalled()
 await controller.write(control,'healthy synthetic input','user')
 expect(client.writeAgent).toHaveBeenCalledExactlyOnceWith({agentSessionId:control.agentSessionId,expectedRun:control.run,data:'healthy synthetic input',source:'user'})
})
it('a bounded history failure never gates the independently working Core input path',async()=>{
 const {controller,client,config}=await owner()
 client.sessionHistoryPage.mockRejectedValueOnce(new Error('native response exceeds byte budget'))
 await expect(controller.sessionHistoryPage(control,undefined,config)).rejects.toThrow('byte budget')
 await controller.write(control,'healthy synthetic input','user')
 expect(client.writeAgent).toHaveBeenCalledExactlyOnceWith({agentSessionId:control.agentSessionId,expectedRun:control.run,data:'healthy synthetic input',source:'user'})
})
it('keeps host reconfiguration reservations and rejects a response from a retired host identity',async()=>{
 const {controller,client,config}=await owner()
 const reservations=(controller as unknown as {hostReconfigurationReservations:Set<string>}).hostReconfigurationReservations
 reservations.add(control.hostId)
 await expect(controller.sessionHistoryPage(control,undefined,config)).rejects.toThrow('being reconfigured')
 expect(client.sessionHistoryPage).not.toHaveBeenCalled()
 reservations.delete(control.hostId)
 let resolve!:(value:AgentSessionHistoryPage)=>void
 client.sessionHistoryPage.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
 const read=controller.sessionHistoryPage(control,undefined,config)
 await vi.waitFor(()=>expect(client.sessionHistoryPage).toHaveBeenCalledOnce())
 controller.commit({hosts:[],removedHostIds:[control.hostId],reservedHostIds:[],hostSignatures:new Map()})
 resolve(page)
 await expect(read).rejects.toThrow('host configuration changed')
 expect(client.connect).not.toHaveBeenCalled()
})

it('actual trusted IPC/preload observation owns its token, filters other notices and releases pending/late resources',async()=>{
 const {controller,client,config}=await owner()
 vi.spyOn(controller,'prepare').mockResolvedValue({hosts:[],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 const sender=Object.assign(new EventEmitter(),{id:88,isDestroyed:()=>false,send:vi.fn((channel:string,payload:unknown)=>preload.receivers.get(channel)?.({},payload))})
 const disposeIpc=await registerIpc({window:{webContents:sender} as unknown as BrowserWindow,runtime:controller,progressLoops:{subscribe:()=>()=>{}} as never,
 configStore:{get:async()=>config} as unknown as ConfigStore,scratchTopics:{} as ScratchTopics,workspaceFiles:{dispose:async()=>{}} as unknown as WorkspaceFiles})
 let deliver!:(event:unknown)=>void
 let ready!:(handle:AgentSessionHistoryObservationHandle)=>void
 client.observeSessionHistory.mockImplementation(async(_id,listener)=>{deliver=listener;return await new Promise(resolve=>{ready=resolve})})
 const calls:Array<{channel:string,args:unknown[]}>=[]
 preload.invoke.mockImplementation(async(channel:string,...args:unknown[])=>{
  calls.push({channel,args});const handler=preload.handlers.get(channel);expect(handler).toBeTypeOf('function')
  return handler!({sender} as unknown as IpcMainInvokeEvent,...args)
 })
 try{
  const receive=vi.fn(),abort=new AbortController()
  const pending=preload.api!.sessions.observeHistory(control,receive,{signal:abort.signal})
  await vi.waitFor(()=>expect(client.observeSessionHistory).toHaveBeenCalledTimes(1))
  expect(client.observeSessionHistory.mock.calls[0]).toEqual([control.agentSessionId,expect.any(Function),{
   commandOverride:'/synthetic/specific-codex',args:['--config','model="specific"'],env:{CODEX_HOME:'/synthetic/specific-home'},signal:expect.any(AbortSignal)
  }])
  const token=calls[0]!.args[0]
  const receiveWire=preload.receivers.get(SESSION_HISTORY_OBSERVATION_CHANNEL)!
  expect(receiveWire).toBeTypeOf('function')
  const notice={kind:'invalidated',agentSessionId:control.agentSessionId,source:page.source}
  receiveWire({}, {token:'another-token',observation:notice})
  receiveWire({}, {token,observation:{...notice,agentSessionId:'foreign-session'}})
  expect(receive).toHaveBeenCalledTimes(0)
  deliver(notice);expect(receive).toHaveBeenCalledExactlyOnceWith(notice)
  const observeHandler=preload.handlers.get('sessions:observeHistory')!
  await expect(observeHandler({sender:Object.assign(new EventEmitter(),{id:999,isDestroyed:()=>false})},'foreign',control)).rejects.toThrow('Untrusted history observation sender')
  expect(client.observeSessionHistory).toHaveBeenCalledTimes(1)
  const rejected=pending.catch(error=>error)
  const disposeHandle=vi.fn()
  abort.abort(new Error('Visible consumer left'))
  await vi.waitFor(()=>expect(calls.map(call=>call.channel)).toEqual(['sessions:observeHistory','sessions:releaseHistoryObservation']))
  expect(preload.receivers.has(SESSION_HISTORY_OBSERVATION_CHANNEL)).toBe(false)
  ready({source:page.source,dispose:disposeHandle})
  expect((await rejected).message).toBe('Visible consumer left')
  expect(disposeHandle).toHaveBeenCalledTimes(1)
  deliver(notice);expect(receive).toHaveBeenCalledTimes(1)
  expect(client.connect).toHaveBeenCalledTimes(0)
  expect(client.writeAgent).toHaveBeenCalledTimes(0)
 }finally{await disposeIpc()}
})

it('retiring the exact observed Host reports unavailable and releases its watch while healthy replacement input remains available',async()=>{
 const {controller,client,config}=await owner()
 const dispose=vi.fn()
 client.observeSessionHistory.mockResolvedValue({source:page.source,dispose})
 const receive=vi.fn()
 const handle=await controller.observeSessionHistory(control,receive,config,new AbortController().signal)
 const replacement={...client,writeAgent:vi.fn().mockResolvedValue(undefined),onEvent:vi.fn().mockReturnValue(vi.fn()),dispose:vi.fn().mockResolvedValue(undefined)}
 controller.commit({hosts:[{id:control.hostId,client:replacement as unknown as AgentMuxClient,executionHost:{kind:'local',dispose:vi.fn()} as never}],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 expect(receive).toHaveBeenCalledExactlyOnceWith({kind:'unavailable',agentSessionId:control.agentSessionId,code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED',message:'History host configuration changed. The current window is kept; refresh its source.'})
 expect(dispose).toHaveBeenCalledTimes(1)
 handle.dispose();expect(dispose).toHaveBeenCalledTimes(1)
 expect(replacement.connect).toHaveBeenCalledTimes(0)
 await controller.write(control,'healthy replacement input','user')
 expect(replacement.writeAgent).toHaveBeenCalledTimes(1)
 expect(replacement.connect).toHaveBeenCalledTimes(1)
})

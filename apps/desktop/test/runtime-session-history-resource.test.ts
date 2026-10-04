const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import {EventEmitter} from 'node:events'
import {rm} from 'node:fs/promises'
import {afterAll,expect,it,vi} from 'vitest'
import {AgentMuxMemoryAgentSessionStore,type AgentMuxClient,type AgentSessionHistoryPage,type AgentSessionHistoryObservationHandle} from '@agentmux/core'
import type {BrowserWindow,IpcMainInvokeEvent} from 'electron'
import type {AgentMuxPreloadApi,AgentSessionControl,AppConfig} from '../src/shared/contracts'
import {SESSION_HISTORY_OBSERVATION_CHANNEL} from '../src/shared/contracts'
import type {ConfigStore} from '../src/main/config-store'
import type {ScratchTopics} from '../src/main/scratch-topics'
import type {WorkspaceFiles} from '../src/main/workspace-files'
import {RuntimeController} from '../src/main/runtime-controller'
const preload=await vi.hoisted(async()=>({api:null as AgentMuxPreloadApi|null,invoke:vi.fn(),handlers:new Map<string,Function>(),receivers:new Map<string,Function>(),directory:await(await import('node:fs/promises')).mkdtemp(_hygiene_fixturePath("tmp/amx-resource-main-review-"))}))
afterAll(async()=>{await rm(preload.directory,{recursive:true,force:true})})
vi.mock('electron',()=>({
 contextBridge:{exposeInMainWorld:(_name:string,api:AgentMuxPreloadApi)=>{preload.api=api}},
 ipcRenderer:{invoke:preload.invoke,on:(channel:string,listener:Function)=>preload.receivers.set(channel,listener),removeListener:(channel:string,listener:Function)=>{if(preload.receivers.get(channel)===listener)preload.receivers.delete(channel)},off:vi.fn(),send:vi.fn()},webFrame:{getZoomFactor:()=>1},
 app:{getPath:()=>preload.directory,getAppPath:()=>preload.directory,isPackaged:false},
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
const page:AgentSessionHistoryPage={agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'native-main'},items:[{id:'persisted-item',kind:'user-message',contentParts:[{kind:'text',text:'original  \n'},{kind:'resource',resourceType:'image',reference:_hygiene_fixturePath("synthetic/screenshot.png")}]}],nextCursor:'opaque'}
async function owner(){
 const store=new AgentMuxMemoryAgentSessionStore()
 await store.compareAndSwap(null,{kind:'agent',agentSessionId:control.agentSessionId,providerId:'codex',executorId:'specific-codex',hostId:control.hostId,
 workspacePath:_hygiene_fixturePath("synthetic"),run:control.run,retiredRuns:[],hookBindingId:'private-binding',hookToken:'private-token',createdAt:1,updatedAt:1,
 nativeHandle:{kind:'provider',providerId:'codex',sessionId:'native-main'}})
 const controller=new RuntimeController(store, localRuntimeConnector)
 const client={observeSessionHistory:vi.fn(),sessionHistoryPage:vi.fn().mockResolvedValue(page),sessionHistorySources:vi.fn().mockResolvedValue([{agentSessionId:control.agentSessionId,history:{providerId:'codex',executorId:'specific-codex',workspacePath:_hygiene_fixturePath("synthetic"),createdAt:1}}]),sessionHistoryResource:vi.fn(),writeAgent:vi.fn().mockResolvedValue(undefined),connect:vi.fn().mockResolvedValue(undefined),onEvent:vi.fn().mockReturnValue(vi.fn()),dispose:vi.fn().mockResolvedValue(undefined)}
 controller.commit({hosts:[{id:control.hostId,client:client as unknown as AgentMuxClient,executionHost:{kind:'local',dispose:vi.fn()} as never}],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 const config:AppConfig={...structuredClone(DEFAULT_CONFIG),executors:{
 'specific-codex':{providerId:'codex',label:'Specific Codex',command:_hygiene_fixturePath("synthetic/specific-codex"),args:['--config','model="specific"'],env:{CODEX_HOME:_hygiene_fixturePath("synthetic/specific-home")},injectAgentMuxGuide:false},
 'other-codex':{providerId:'codex',label:'Other Codex',command:_hygiene_fixturePath("synthetic/other-codex"),args:[],env:{CODEX_HOME:_hygiene_fixturePath("synthetic/other-home")},injectAgentMuxGuide:false}
 }}
 return{controller,client,config,store}
}

const resourceRequest={source:page.source,turnId:'original-turn',recordId:'persisted-item',partIndex:1,expectedReference:_hygiene_fixturePath("synthetic/screenshot.png")}
const resourceResponse={agentSessionId:control.agentSessionId,source:page.source,turnId:'original-turn',recordId:'persisted-item',partIndex:1,reference:_hygiene_fixturePath("synthetic/screenshot.png"),result:{status:'unavailable',code:'MISSING',message:'The original file is absent.'}}
it('resource IPC/preload keeps the recorded target and trusted Executor on its original Host without connecting Runtime',async()=>{
 vi.stubEnv('AGENTMUX_STATE_DIRECTORY',preload.directory)
 const {controller,client,config}=await owner();client.sessionHistoryResource.mockResolvedValue(resourceResponse)
 vi.spyOn(controller,'prepare').mockResolvedValue({hosts:[],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 const sender=Object.assign(new EventEmitter(),{id:777,isDestroyed:()=>false,send:vi.fn()})
 let dispose:(()=>Promise<void>)|undefined
 try {
  dispose=await registerIpc({window:{webContents:sender,isDestroyed:()=>false} as unknown as BrowserWindow,runtime:controller,progressLoops:{subscribe:()=>()=>{}} as never,
  configStore:{get:async()=>config} as unknown as ConfigStore,scratchTopics:{setNameAudit:vi.fn()} as unknown as ScratchTopics,workspaceFiles:{dispose:async()=>{}} as unknown as WorkspaceFiles})
  const handler=preload.handlers.get('sessions:historyResource');expect(handler).toBeTypeOf('function')
  preload.invoke.mockImplementation((channel:string,subject,request)=>{expect(channel).toBe('sessions:historyResource');return handler!({sender} as unknown as IpcMainInvokeEvent,subject,request)})
  await expect(preload.api!.sessions.historyResource(control,resourceRequest)).resolves.toBe(resourceResponse)
  expect(client.sessionHistoryResource).toHaveBeenCalledExactlyOnceWith(control.agentSessionId,{...resourceRequest,commandOverride:_hygiene_fixturePath("synthetic/specific-codex"),args:['--config','model="specific"'],env:{CODEX_HOME:_hygiene_fixturePath("synthetic/specific-home")}})
  expect(client.connect).not.toHaveBeenCalled();expect(client.writeAgent).not.toHaveBeenCalled()
 } finally {await dispose?.();vi.unstubAllEnvs()}
})
it('resource reads strip Renderer invocation and reject another exact response target without disturbing healthy input',async()=>{
 const {controller,client,config}=await owner();client.sessionHistoryResource.mockResolvedValue(resourceResponse)
 await controller.sessionHistoryResource(control,{...resourceRequest,commandOverride:_hygiene_fixturePath("untrusted/command"),env:{KEY:'untrusted'}} as never,config)
 expect(client.sessionHistoryResource.mock.calls[0]![1]).toMatchObject({commandOverride:_hygiene_fixturePath("synthetic/specific-codex"),env:{CODEX_HOME:_hygiene_fixturePath("synthetic/specific-home")}})
 client.sessionHistoryResource.mockResolvedValue({...resourceResponse,recordId:'other'})
 const rejectedTarget=await controller.sessionHistoryResource(control,resourceRequest,config).then(()=>null,(error:Error)=>error)
 expect(rejectedTarget).toBeInstanceOf(Error);expect(rejectedTarget?.message).toContain('another recorded target')
 await controller.write(control,'healthy input','user');expect(client.writeAgent).toHaveBeenCalledExactlyOnceWith({agentSessionId:control.agentSessionId,expectedRun:control.run,data:'healthy input',source:'user'})
})
it('resource Host removal while reading cannot return stale bytes, and unknown Hosts do not call another device',async()=>{
 const {controller,client,config}=await owner();let resolve!:(value:typeof resourceResponse)=>void
 client.sessionHistoryResource.mockImplementation(()=>new Promise(done=>{resolve=done}))
 const read=controller.sessionHistoryResource(control,resourceRequest,config)
 await vi.waitFor(()=>expect(client.sessionHistoryResource).toHaveBeenCalledOnce())
 controller.commit({hosts:[],removedHostIds:[control.hostId],reservedHostIds:[],hostSignatures:new Map()});resolve(resourceResponse)
 const rejectedHost=await read.then(()=>null,(error:Error)=>error)
 expect(rejectedHost).toBeInstanceOf(Error);expect(rejectedHost?.message).toContain('host configuration changed')
 client.sessionHistoryResource.mockClear()
 await expect(controller.sessionHistoryResource({...control,hostId:'other-device'},resourceRequest,config)).rejects.toThrow('not configured')
 expect(client.sessionHistoryResource).not.toHaveBeenCalled();expect(client.connect).not.toHaveBeenCalled()
})

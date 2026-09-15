import {expect,it,vi} from 'vitest'
import {AgentMuxMemoryAgentSessionStore,type AgentMuxClient,type AgentSessionHistoryPage} from '@agentmux/core'
import type {AgentMuxPreloadApi,AgentSessionControl} from '../src/shared/contracts'
import {RuntimeController} from '../src/main/runtime-controller'
const preload=vi.hoisted(()=>({api:null as AgentMuxPreloadApi|null,invoke:vi.fn()}))
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_name:string,api:AgentMuxPreloadApi)=>{preload.api=api}},ipcRenderer:{invoke:preload.invoke,on:vi.fn(),off:vi.fn(),send:vi.fn()},webFrame:{getZoomFactor:()=>1}}))
import '../src/preload/index'
const control:AgentSessionControl={kind:'agent',hostId:'synthetic-host',agentSessionId:'synthetic-session',run:{runId:'healthy-run'}}
const page:AgentSessionHistoryPage={agentSessionId:control.agentSessionId,source:{providerId:'codex',nativeSessionId:'native-main'},items:[{id:'persisted-item',kind:'user-message',contentParts:[{kind:'text',text:'original  \n'},{kind:'resource',resourceType:'image',reference:'/synthetic/screenshot.png'}]}],nextCursor:'opaque'}
function owner(){
 const controller=new RuntimeController(new AgentMuxMemoryAgentSessionStore())
 const client={sessionHistoryPage:vi.fn().mockResolvedValue(page),writeAgent:vi.fn().mockResolvedValue(undefined),connect:vi.fn().mockResolvedValue(undefined),onEvent:vi.fn().mockReturnValue(vi.fn()),dispose:vi.fn().mockResolvedValue(undefined)}
 controller.commit({hosts:[{id:control.hostId,client:client as unknown as AgentMuxClient,executionHost:{kind:'local',dispose:vi.fn()} as never}],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
 return{controller,client}
}
it('preload invokes the history channel and RuntimeController forwards the exact Agent identity/options to public Core',async()=>{
 const {controller,client}=owner()
 client.connect.mockRejectedValue(new Error('synthetic Runtime is temporarily unavailable'))
 preload.invoke.mockImplementation((channel:string,subject:AgentSessionControl,options)=>{expect(channel).toBe('sessions:historyPage');return controller.sessionHistoryPage(subject,options)})
 expect(preload.api).not.toBeNull()
 await expect(preload.api!.sessions.historyPage(control,{cursor:'native-opaque',limit:30})).resolves.toBe(page)
 expect(client.connect).not.toHaveBeenCalled()
 expect(client.sessionHistoryPage).toHaveBeenCalledExactlyOnceWith('synthetic-session',{cursor:'native-opaque',limit:30})
})
it('rejects another Session response and refuses a Terminal control without native calls',async()=>{
 const {controller,client}=owner()
 client.sessionHistoryPage.mockResolvedValueOnce({...page,agentSessionId:'foreign-session'})
 await expect(controller.sessionHistoryPage(control)).rejects.toThrow('another Session')
 client.sessionHistoryPage.mockClear()
 await expect(controller.sessionHistoryPage({kind:'terminal',hostId:'synthetic-host',runId:'healthy-run',run:{runId:'healthy-run'}} as unknown as AgentSessionControl)).rejects.toThrow('requires an Agent Session')
 expect(client.connect).not.toHaveBeenCalled();expect(client.sessionHistoryPage).not.toHaveBeenCalled()
})
it('a bounded history failure never gates the independently working Core input path',async()=>{
 const {controller,client}=owner()
 client.sessionHistoryPage.mockRejectedValueOnce(new Error('native response exceeds byte budget'))
 await expect(controller.sessionHistoryPage(control)).rejects.toThrow('byte budget')
 await controller.write(control,'healthy synthetic input')
 expect(client.writeAgent).toHaveBeenCalledExactlyOnceWith('synthetic-session','healthy synthetic input')
})
it('keeps host reconfiguration reservations and rejects a response from a retired host identity',async()=>{
 const {controller,client}=owner()
 const reservations=(controller as unknown as {hostReconfigurationReservations:Set<string>}).hostReconfigurationReservations
 reservations.add(control.hostId)
 await expect(controller.sessionHistoryPage(control)).rejects.toThrow('being reconfigured')
 expect(client.sessionHistoryPage).not.toHaveBeenCalled()
 reservations.delete(control.hostId)
 let resolve!:(value:AgentSessionHistoryPage)=>void
 client.sessionHistoryPage.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
 const read=controller.sessionHistoryPage(control)
 controller.commit({hosts:[],removedHostIds:[control.hostId],reservedHostIds:[],hostSignatures:new Map()})
 resolve(page)
 await expect(read).rejects.toThrow('host configuration changed')
 expect(client.connect).not.toHaveBeenCalled()
})

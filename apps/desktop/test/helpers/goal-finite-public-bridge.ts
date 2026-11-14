import {vi} from 'vitest'
import type {AgentMuxPreloadApi} from '../../src/shared/contracts'
import type {AgentMuxRpcClient} from '../../../../packages/core/src/public-rpc-client'
import type {IpcMainInvokeEvent} from 'electron'

const bridge=vi.hoisted(()=>({api:null as AgentMuxPreloadApi|null,invoke:vi.fn(),listeners:new Map<string,Set<(...args:unknown[])=>void>>()}))
vi.mock('electron',()=>({
 contextBridge:{exposeInMainWorld:(name:string,api:AgentMuxPreloadApi)=>{bridge.api=api;Object.assign(window,{[name]:api})}},
 ipcRenderer:{invoke:bridge.invoke,on:(name:string,listener:(...args:unknown[])=>void)=>{const set=bridge.listeners.get(name)??new Set();set.add(listener);bridge.listeners.set(name,set)},off:(name:string,listener:(...args:unknown[])=>void)=>bridge.listeners.get(name)?.delete(listener),removeListener:(name:string,listener:(...args:unknown[])=>void)=>bridge.listeners.get(name)?.delete(listener),send:vi.fn()},
 webFrame:{getZoomFactor:()=>1},webUtils:{getPathForFile:()=>{throw Error('No file input is part of this Goal control proof')}}
}))
await vi.hoisted(async()=>{await import('../../src/preload/index')})
import {desktopGoalControl,readDesktopGoals,reconcileDesktopGoalDispatch} from '../../src/main/desktop-goals'
import {assertAppDocumentSender} from '../../src/main/ipc-sender-trust'
import {parseAgentMuxControlRequest} from '../../../../packages/core/src/control-codec'

/** Formal Preload + Main's original public Goal control. Electron delivery is
 * explicit; business requests traverse the actual Unix Core/Host owner. */
export function installGoalFinitePublicBridge(rpc:AgentMuxRpcClient){
 const requests:Array<{channel:string;input:unknown}>=[]
 const sender={isDestroyed:()=>false,mainFrame:{url:'file:///private-goal/index.html',detached:false,isDestroyed:()=>false},getURL:()=>'file:///private-goal/index.html'}
 const event={sender,senderFrame:sender.mainFrame} as unknown as IpcMainInvokeEvent
 const runtime={callOriginalCore:((hostId,method,params,context)=>{
  if(hostId!=='local')throw Error('This original Goal owner was not redirected')
  return rpc.call(method,params,{...(context.signal?{signal:context.signal}:{}),...(context.caller?{credentials:context.caller}:{}),...(context.runtimeFence?{runtimeFence:context.runtimeFence}:{}),...(context.principal?.kind==='device'&&context.forwarding?{forwarding:context.forwarding}:{})})
 }) satisfies Parameters<typeof desktopGoalControl>[0]['callOriginalCore']}
 const control=desktopGoalControl(runtime)
 bridge.invoke.mockImplementation(async(channel:string,...args:unknown[])=>{
  assertAppDocumentSender(event,sender as never,{current:{mode:'prod',filePath:'/private-goal/index.html'},loading:null})
  requests.push({channel,input:structuredClone(args[0])})
  if(channel==='goals:execute')return await control(parseAgentMuxControlRequest(args[0]))
  if(channel==='demands:list')return await readDesktopGoals(runtime)
  // Original demands:inspectDispatch registration reads this same public Goal;
  // delivery is the controlled Electron leaf, not a replacement input owner.
  if(channel==='demands:inspectDispatch'){
   const reference=args[0] as {goalId:string;operationId:string}
   return(await runtime.callOriginalCore('local','goal.inspect',{goalId:reference.goalId},{principal:{kind:'user',id:'local-user:'+(process.getuid?.()??'current')}})).goal?.dispatches?.find(row=>row.operationId===reference.operationId)??null
  }
  if(channel==='demands:reconcileDispatch')return await reconcileDesktopGoalDispatch(runtime,args[0] as {goalId:string;operationId:string})
  throw Error('Unexpected private Goal IPC channel: '+channel)
 })
 if(!bridge.api)throw Error('Formal Preload must expose the existing public API')
 return{api:bridge.api,requests}
}

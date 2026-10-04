import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { parseToolkitSnapshot, type AgentMuxToolkitPort, type ToolkitMetricsSnapshot } from '../src/toolkit.js'

const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'toolkit-owning', toolId: 'performance' } as const
const snapshot = (): ToolkitMetricsSnapshot => ({ schema:'agentmux.toolkit.v1',kind:'metrics',toolId:'performance',executionId:null,run:null,
  state:'idle',reason:null,startedAt:null,observedAt:null,observation:null,manual:false,consumerCount:0,sequence:0,trend:[] })
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function endpoint() {
  const directory = await mkdtemp(join(tmpdir(),'amx-toolkit-control-'))
  cleanups.push(() => rm(directory,{recursive:true,force:true}))
  return join(directory,'control.sock')
}
async function server(toolkit?: AgentMuxToolkitPort) {
  const path = await endpoint(), owner = new AgentMuxControlServer({socketPath:path, coreClients:()=>[], execute:vi.fn(), ...(toolkit ? { toolkit } : {})})
  await owner.start(); cleanups.push(() => owner.stop()); return {path,owner}
}
async function client(path:string) {
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path}})
  cleanups.push(()=>rpc.dispose());return rpc
}
async function raw(path:string) {
  const socket=createConnection({path,allowHalfOpen:true});cleanups.push(()=>{ socket.destroy() })
  await new Promise<void>(resolve=>socket.once('connect',resolve));socket.write(JSON.stringify({jsonrpc:'2.0',id:base.requestId,method:'toolkit.watch',params:{toolId:base.toolId}})+'\n')
  return socket
}
function firstFrame(socket:Socket): Promise<any> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>resolve({missingOpeningDeadline:true}),4_000)
    let buffer='';socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]!))}})
    socket.once('error',error=>{clearTimeout(timer);reject(error)})
  })
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const port=(subscribe:AgentMuxToolkitPort['subscribe']):AgentMuxToolkitPort=>({execute:async request=>({operation:request.operation as 'toolkit.get',snapshot:snapshot()}),subscribe})
const opening=(id:string|number)=>({jsonrpc:'2.0',id,result:{subscriptionId:'reader',method:'toolkit.watch',initial:{toolId:base.toolId}}})
const notification=(sequence:number)=>({jsonrpc:'2.0',method:'system.subscription.event',params:{subscriptionId:'reader',method:'toolkit.watch',sequence,event:{type:'snapshot',data:snapshot()}}})
async function rawOwner(path:string, respond:(socket:Socket,id:string|number)=>void) {
  const owner=createServer(socket=>socket.once('data',chunk=>respond(socket,JSON.parse(chunk.toString()).id)))
  await new Promise<void>(resolve=>owner.listen(path,resolve));cleanups.push(()=>new Promise<void>(resolve=>owner.close(()=>resolve())))
}

describe('public Toolkit RPC lifecycle and framing',()=>{
  it('keeps unsupported typed, validates exact owner schema and operation budgets',async()=>{
    const {path}=await server()
    await expect((await client(path)).call('toolkit.inspect',{toolId:base.toolId})).rejects.toMatchObject({code:'TOOLKIT_UNSUPPORTED'})
    expect(parseToolkitSnapshot(snapshot()).state).toBe('idle')
    expect(()=>parseAgentMuxControlRequest({...base,operation:'toolkit.get',extra:true})).toThrow()
    expect(()=>parseToolkitSnapshot({...snapshot(),observedAt:10})).toThrow()
    expect(()=>parseToolkitSnapshot({...snapshot(),trend:Array.from({length:61},()=>({observedAt:1,appCpuPercent:0,appRssKib:0}))})).toThrow()
    expect(agentMuxControlTimeoutMs('toolkit.get')).toBe(agentMuxControlTimeoutMs('toolkit.watch'))
    expect(agentMuxControlTimeoutMs('toolkit.run')).toBeGreaterThan(agentMuxControlTimeoutMs('toolkit.get'))
  })
  it.each(['FIN','close','stop','deadline'] as const)('disposes late watch establishment after %s with no late frames',async kind=>{
    let settle!: (v:{dispose():void})=>void, enter!:()=>void
    const entered=new Promise<void>(resolve=>{enter=resolve}),dispose=vi.fn()
    const {owner,path}=await server(port(async()=>{enter();return await new Promise(resolve=>{settle=resolve})}))
    const socket=await raw(path),frames:string[]=[];socket.on('data',chunk=>frames.push(chunk.toString()));await entered
    if(kind==='FIN')socket.end();else if(kind==='close')socket.destroy();else if(kind==='stop')await owner.stop()
    else expect(await firstFrame(socket)).toMatchObject({jsonrpc:'2.0',id:base.requestId,error:{data:{code:'CONTROL_TIMEOUT'}}})
    await flush();await flush();settle({dispose});await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce())
    expect(frames.join('')).not.toContain('"method":"system.subscription.event"');expect(frames.join('')).not.toContain('"subscriptionId"')
  })
  it('coalesces synchronous snapshots after real opening backpressure',async()=>{
    const dispose=vi.fn(),{owner,path}=await server(port(async (_toolId,push)=>{for(let i=0;i<50;i++)push({...snapshot(),sequence:i});return {dispose}}))
    let serverSocket!:Socket
    ;(owner as unknown as {server:Server}).server.once('connection',s=>{serverSocket=s;(s as any)._writableState.highWaterMark=1})
    const frames:any[]=[],rpc=await client(path)
    const lease=await rpc.subscribe('toolkit.watch',{toolId:base.toolId},{onInitial:()=>frames.push({type:'attached'}),onEvent:event=>frames.push(event),onEnd:vi.fn()})
    await vi.waitFor(()=>expect(frames).toHaveLength(2));expect(frames.map(f=>f.type)).toEqual(['attached','snapshot'])
    expect(frames[1].data.sequence).toBe(49);expect(serverSocket.writableHighWaterMark).toBe(1)
    await lease.dispose();await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce())
  })
  it.each(['complete JSON without LF','partial JSON'] as const)('rejects %s at real EOF after attachment',async kind=>{
    const path=await endpoint();await rawOwner(path,(socket,id)=>socket.end(JSON.stringify(opening(id))+'\n'+(kind==='partial JSON'?'{' : JSON.stringify(notification(1)))))
    const events:string[]=[],ends:unknown[]=[]
    await (await client(path)).subscribe('toolkit.watch',{toolId:base.toolId},{onInitial:()=>events.push('attached'),onEvent:event=>events.push(event.type),onEnd:e=>ends.push(e)})
    await vi.waitFor(()=>expect(ends).toHaveLength(1));expect(ends[0]).toMatchObject({code:'CONTROL_PROTOCOL_ERROR'});expect(events).toEqual(['attached'])
  })
  it('stops same-chunk dispatch immediately when the attached consumer aborts',async()=>{
    const path=await endpoint();await rawOwner(path,(socket,id)=>socket.write([opening(id),notification(1),notification(2)].map(f=>JSON.stringify(f)+'\n').join('')))
    const signal=new AbortController(),events:string[]=[],ends:unknown[]=[]
    await (await client(path)).subscribe('toolkit.watch',{toolId:base.toolId},{signal:signal.signal,onInitial:()=>{events.push('attached');signal.abort()},onEvent:event=>events.push(event.type),onEnd:e=>ends.push(e)})
    await flush();expect(events).toEqual(['attached']);expect(ends).toEqual([expect.objectContaining({code:'CONTROL_CANCELLED'})])
  })
  it('rejects malformed UTF8 watch bytes after a nonempty attached frame',async()=>{
    const path=await endpoint(),frame=notification(1);frame.params.event.data.reason='#'
    const line=Buffer.from(JSON.stringify(frame)+'\n'),index=line.indexOf(35);expect(index).toBeGreaterThan(0);line[index]=255
    await rawOwner(path,(socket,id)=>socket.end(Buffer.concat([Buffer.from(JSON.stringify(opening(id))+'\n'),line])))
    const events:string[]=[],ends:unknown[]=[]
    await (await client(path)).subscribe('toolkit.watch',{toolId:base.toolId},{onInitial:()=>events.push('attached'),onEvent:event=>events.push(event.type),onEnd:e=>ends.push(e)})
    await vi.waitFor(()=>expect(ends).toHaveLength(1));expect(events).toEqual(['attached']);expect(ends[0]).toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
  })
})

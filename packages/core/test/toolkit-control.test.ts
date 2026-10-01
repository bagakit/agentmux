import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl, parseAgentMuxControlRequest } from '../src/control-host.js'
import { subscribeAgentMuxToolkit } from '../src/toolkit-control.js'
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
  const path = await endpoint(), owner = new AgentMuxControlServer({execute:vi.fn(), ...(toolkit ? { toolkit } : {})},path)
  await owner.start(); cleanups.push(() => owner.stop()); return {path,owner}
}
async function raw(path:string) {
  const socket=createConnection({path,allowHalfOpen:true});cleanups.push(()=>{ socket.destroy() })
  await new Promise<void>(resolve=>socket.once('connect',resolve));socket.write(JSON.stringify({...base,operation:'toolkit.watch'})+'\n')
  return socket
}
function firstFrame(socket:Socket): Promise<any> {
  return new Promise((resolve,reject)=>{let buffer='';socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]!))});socket.once('error',reject)})
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const port=(subscribe:AgentMuxToolkitPort['subscribe']):AgentMuxToolkitPort=>({execute:async request=>({operation:request.operation as 'toolkit.get',snapshot:snapshot()}),subscribe})

describe('public Toolkit Control lifecycle and framing',()=>{
  it('keeps unsupported typed, validates exact public schema and operation budgets',async()=>{
    const {path}=await server()
    await expect(requestAgentMuxControl({...base,operation:'toolkit.get'},path)).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
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
    else expect(await firstFrame(socket)).toMatchObject({ok:false,error:{code:'CONTROL_TIMEOUT'}})
    await flush();await flush();settle({dispose});await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce())
    expect(frames.join('')).not.toContain('"event":"snapshot"');expect(frames.join('')).not.toContain('"event":"attached"')
  })
  it('coalesces synchronous snapshots after real opening backpressure',async()=>{
    const dispose=vi.fn(),{owner,path}=await server(port(async (_toolId,push)=>{for(let i=0;i<50;i++)push({...snapshot(),sequence:i});return {dispose}}))
    let serverSocket!:Socket
    ;(owner as unknown as {server:Server}).server.once('connection',s=>{serverSocket=s;(s as any)._writableState.highWaterMark=1})
    const frames:any[]=[]
    const lease=await subscribeAgentMuxToolkit({...base,operation:'toolkit.watch'},{onFrame:f=>frames.push(f),onEnd:vi.fn()},{path})
    await vi.waitFor(()=>expect(frames).toHaveLength(2));expect(frames.map(f=>f.event)).toEqual(['attached','snapshot'])
    expect(frames[1].result.snapshot.sequence).toBe(49);expect(serverSocket.writableHighWaterMark).toBe(1)
    lease.dispose();await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce())
  })
  it.each(['complete JSON without LF','partial JSON'] as const)('rejects %s at real EOF after attachment',async kind=>{
    const path=await endpoint(), rawServer=createServer(socket=>socket.once('data',()=>{
      const {toolId:_,...identity}=base,env={...identity,operation:'toolkit.watch',ok:true}
      socket.end(JSON.stringify({...env,event:'attached',result:{}})+'\n'+(kind==='partial JSON'?'{' : JSON.stringify({...env,event:'snapshot',result:{snapshot:snapshot()}})))
    }))
    await new Promise<void>(resolve=>rawServer.listen(path,resolve));cleanups.push(()=>new Promise<void>(resolve=>rawServer.close(()=>resolve())))
    const events:string[]=[],ends:unknown[]=[]
    await subscribeAgentMuxToolkit({...base,operation:'toolkit.watch'},{onFrame:f=>events.push(f.event),onEnd:e=>ends.push(e)},{path})
    await vi.waitFor(()=>expect(ends).toHaveLength(1));expect(ends[0]).toMatchObject({code:'CONTROL_PROTOCOL_ERROR'});expect(events).toEqual(['attached'])
  })
  it('stops same-chunk dispatch immediately when the attached consumer aborts',async()=>{
    const path=await endpoint(),{toolId:_,...identity}=base,env={...identity,operation:'toolkit.watch',ok:true}
    const rawServer=createServer(socket=>socket.once('data',()=>socket.write([
      {...env,event:'attached',result:{}},{...env,event:'snapshot',result:{snapshot:snapshot()}},{...env,event:'snapshot',result:{snapshot:snapshot()}}
    ].map(f=>JSON.stringify(f)+'\n').join(''))))
    await new Promise<void>(resolve=>rawServer.listen(path,resolve));cleanups.push(()=>new Promise<void>(resolve=>rawServer.close(()=>resolve())))
    const signal=new AbortController(),events:string[]=[],ends:unknown[]=[]
    await subscribeAgentMuxToolkit({...base,operation:'toolkit.watch'},{onFrame:f=>{events.push(f.event);signal.abort()},onEnd:e=>ends.push(e)},{path,signal:signal.signal})
    await flush();expect(events).toEqual(['attached']);expect(ends).toEqual([expect.objectContaining({code:'CONTROL_CANCELLED'})])
  })
  it('rejects malformed UTF8 watch bytes after a nonempty attached frame',async()=>{
    const path=await endpoint(),{toolId:_,...identity}=base,env={...identity,operation:'toolkit.watch',ok:true}
    const line=Buffer.from(JSON.stringify({...env,event:'snapshot',result:{snapshot:{...snapshot(),reason:'#'}}})+'\n')
    const index=line.indexOf(35);expect(index).toBeGreaterThan(0);line[index]=255
    const rawServer=createServer(socket=>socket.once('data',()=>socket.end(Buffer.concat([
      Buffer.from(JSON.stringify({...env,event:'attached',result:{}})+'\n'),line]))))
    await new Promise<void>(resolve=>rawServer.listen(path,resolve));cleanups.push(()=>new Promise<void>(resolve=>rawServer.close(()=>resolve())))
    const events:string[]=[],ends:unknown[]=[]
    await subscribeAgentMuxToolkit({...base,operation:'toolkit.watch'},{onFrame:f=>events.push(f.event),onEnd:e=>ends.push(e)},{path})
    await vi.waitFor(()=>expect(ends).toHaveLength(1));expect(events).toEqual(['attached']);expect(ends[0]).toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
  })
})

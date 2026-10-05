import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>_hygiene_fixturePath("tmp"),getAppPath:()=>process.cwd()}}))
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'
import { desktopToolkitPublicPort } from './helpers/desktop-toolkit-public-port.js'
const cleanup:(()=>Promise<unknown>|void)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
it('normal compiled public CLI watch capture and inspect consume original Owner evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'amx-perf-cli-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 // This is an isolated test authority, never a fallback principal on the user endpoint.
 const env=objectCliEnvironment(dir),cli=resolve('packages/core/bin/amux')
 expect((await readFile(resolve('packages/core/dist/agentmux.js'))).byteLength).toBeGreaterThan(0)
 let accept:(event:any)=>void=()=>{}
 const port:ToolkitRunPort={create:vi.fn(async(_input,onEvent)=>{accept=onEvent;return {runId:'private-cli-toolkit-run',pid:88,kind:'terminal'} as any}),attach:vi.fn(async()=>({replay:[],gap:null}) as any),replay:vi.fn(async()=>({replay:[],gap:null}) as any),stop:vi.fn(async()=>{}),release:vi.fn(async()=>{}),remove:vi.fn(async()=>{})}
 const owner=new PerformanceToolkitOwner({openRunPort:async()=>port,launch:()=>({runner:process.execPath,cli,script:resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:dir,env:{}}),enabled:()=>true,receipts:{read:async()=>null,save:async()=>{}}})
 cleanup.push(()=>owner.dispose())
 const server=new AgentMuxControlServer({socketPath:join(dir,'control.sock'),coreClients:()=>[],execute:vi.fn(),toolkit:desktopToolkitPublicPort(owner)});await server.start();cleanup.push(()=>server.stop())
 const child=spawn(process.execPath,[cli,'toolkit','watch','performance','--capture-failure','--failure-evidence'],{env,stdio:['ignore','pipe','pipe']});cleanup.push(()=>{if(child.exitCode===null)child.kill('SIGTERM')})
 const frames:any[]=[],stderr:string[]=[];let buffer='';child.stdout.on('data',bytes=>{buffer+=bytes;let lf;while((lf=buffer.indexOf('\n'))>=0){frames.push(JSON.parse(buffer.slice(0,lf)));buffer=buffer.slice(lf+1)}});child.stderr.on('data',bytes=>stderr.push(bytes.toString()))
 // Capture admission precedes asynchronous port creation. Inject output only
 // after the original Run is attached and the public subscription has opened.
 await vi.waitFor(()=>{
  expect(child.exitCode,stderr.join('')).toBeNull()
  expect(owner.current).toMatchObject({state:'observing',run:{hostId:'local',runId:'private-cli-toolkit-run'},diagnostics:{captureEnabled:true}})
  expect(frames.some(frame=>typeof frame.result?.subscriptionId==='string')).toBe(true)
 },{timeout:5000})
 const raw=Buffer.from('[bad]\n');accept({type:'terminal-output',dataBytes:raw,evidence:{outputByteRange:{startByte:0,endByte:raw.length}}})
 await vi.waitFor(()=>expect(frames.some(frame=>frame.method==='system.subscription.event'&&frame.params.event.type==='snapshot'&&frame.params.event.data.diagnostics.lastFailure)).toBe(true))
 const ordinary=await runCompiledObjectCli(['toolkit','inspect','performance'],env)
 expect(ordinary.code,ordinary.stderr).toBe(0);expect(JSON.parse(ordinary.stdout).result.snapshot.diagnostics).toMatchObject({failureEvidence:'retained',lastFailure:{details:{bytes:null,error:{stack:null}}}})
 const inspect=await runCompiledObjectCli(['toolkit','inspect','performance','--failure-evidence'],env)
 expect(inspect.code,inspect.stderr).toBe(0)
 const failure=JSON.parse(inspect.stdout).result.snapshot.diagnostics.lastFailure
 expect(failure).toMatchObject({run:{hostId:'local',runId:'private-cli-toolkit-run'},details:{stage:'toolkit-json',bytes:{startByte:0,endByte:raw.length,omittedBytes:0}}})
 expect(Buffer.from(failure.details.bytes.prefixBase64,'base64')).toEqual(raw)
 child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve))
 expect(port.create).toHaveBeenCalledOnce();expect(port.remove).toHaveBeenCalledOnce()
})

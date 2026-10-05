import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { connectToolkitResultChannel, openToolkitResultChannel } from '../../../packages/core/src/toolkit-result-channel.js'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>_hygiene_fixturePath("tmp"),getAppPath:()=>process.cwd()}}))
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as Core from '@agentmux/core'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { PerformanceFailureStore } from '../src/main/toolkit-performance-failure-store.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseToolkitSnapshot, toolkitFailureError, type ToolkitMetricsSnapshot } from '@agentmux/core/control'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'
import { desktopToolkitPublicPort } from './helpers/desktop-toolkit-public-port.js'
const cleanup:(()=>Promise<unknown>|void)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))}
const request=(includeFailureEvidence=false)=>({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'inspect',operation:'toolkit.get' as const,toolId:'performance',...(includeFailureEvidence?{includeFailureEvidence:true as const}:{})})
async function fixture(options:{store?:{read():Promise<any>;save(value:any):Promise<void>};cleanupError?:boolean}={}) {
 const dir=await mkdtemp(join(tmpdir(),'amx-perf-failure-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const store=options.store??new PerformanceFailureStore(join(dir,'failure.json'))
 const writes=new Set<Promise<void>>()
 const failures={read:()=>store.read(),save:(value:any)=>{
  const pending=Promise.resolve().then(()=>store.save(value));writes.add(pending)
  void pending.then(()=>writes.delete(pending),()=>writes.delete(pending));return pending
 }}
 cleanup.push(async()=>{await Promise.allSettled([...writes])})
 let accept:(event:any)=>void=()=>{},cursor=0
 const port:ToolkitRunPort={create:vi.fn(async(_input,onEvent)=>{accept=onEvent;return {runId:'original-toolkit-run',pid:88,kind:'terminal'} as any}),
  attach:vi.fn(async()=>({replay:[],gap:null}) as any),replay:vi.fn(async()=>({replay:[],gap:null}) as any),stop:vi.fn(async()=>{}),release:vi.fn(async()=>{}),remove:vi.fn(async()=>{if(options.cleanupError)throw new Error('cleanup unknown')})}
 const owner=new PerformanceToolkitOwner({openRunPort:async()=>port,launch:()=>({runner:process.execPath,cli:_hygiene_fixturePath("private/fixture-cli"),script:resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:dir,env:{}}),enabled:()=>true,receipts:{read:async()=>null,save:async()=>{}},failures,now:()=>1234})
 cleanup.push(()=>owner.dispose())
 let resultSocket: Awaited<ReturnType<typeof connectToolkitResultChannel>> | null = null, path = ''
 const bytes=async(raw:Uint8Array)=>{
  const env=(port.create as any).mock.calls.at(-1)[0].env
  if(path!==env.AGENTMUX_TOOLKIT_RESULT_PATH){path=env.AGENTMUX_TOOLKIT_RESULT_PATH;resultSocket=await connectToolkitResultChannel({...env});resultSocket.on('error',()=>{})}
  resultSocket!.write(raw);await flush()
 }
 const terminal=(raw:Uint8Array)=>{const start=cursor;cursor+=raw.length;accept({type:'terminal-output',dataBytes:raw,evidence:{outputByteRange:{startByte:start,endByte:cursor}}})}

 const watch=async(capture=false)=>owner.subscribe('performance',vi.fn(),vi.fn(),new AbortController().signal,capture?{captureFailure:true}:undefined)
 return {owner,store,port,dir,bytes,terminal,watch,end:()=>resultSocket?.end(),accept:(event:any)=>accept(event)}
}
it('keeps exact outer JSON stage, fragmented bytes and original Run after cleanup',async()=>{
 const f=await fixture();await f.watch(true);const raw=Buffer.from('[1,2,broken]\r\n');await f.bytes(raw.subarray(0,4));await f.bytes(raw.subarray(4));await flush();await vi.waitFor(()=>expect(f.owner.current.diagnostics.persistence).toBe('confirmed'))
 await vi.waitFor(()=>expect(f.owner.current.state).toBe('failed'))
 const snapshot=(await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}).snapshot
 expect(snapshot).toMatchObject({run:null,state:'failed',diagnostics:{persistence:'confirmed',lastFailure:{executionId:snapshot.executionId,run:{hostId:'local',runId:'original-toolkit-run'},recordedAt:1234,details:{stage:'toolkit-json',bytes:{startByte:0,endByte:raw.length,omittedBytes:0}}}}})
 expect(f.owner.current.diagnostics).toMatchObject({failureEvidence:'retained',lastFailure:{details:{bytes:null,error:{stack:null}}}})
 const ordinary=(await f.owner.execute(request(),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}).snapshot
 expect(ordinary.diagnostics.lastFailure?.details.bytes).toBeNull();expect(ordinary.diagnostics.lastFailure?.details.error.stack).toBeNull()
 expect(Buffer.from(snapshot.diagnostics.lastFailure!.details.bytes!.prefixBase64,'base64')).toEqual(raw)
 expect(snapshot.diagnostics.lastFailure!.details.error.stack).toContain('SyntaxError');expect(parseToolkitSnapshot(snapshot)).toEqual(snapshot)
 expect((await stat(join(f.dir,'failure.json'))).mode&0o777).toBe(0o600);expect(await f.store.read()).toEqual(snapshot.diagnostics.lastFailure)
 expect(f.port.stop).toHaveBeenCalledOnce();expect(f.port.remove).toHaveBeenCalledOnce()
})
it('ordinary watch retains metadata but no raw or diagnostic write',async()=>{
 const store={read:vi.fn(async()=>null),save:vi.fn(async()=>{})},f=await fixture({store});await f.watch();await f.bytes(Buffer.from('[bad]\n'));await flush()
 expect(f.owner.current.diagnostics).toMatchObject({captureEnabled:false,persistence:'not-requested',failureEvidence:'retained',lastFailure:{details:{stage:'toolkit-json',bytes:null,error:{message:null,stack:null}}}});expect(store.save).not.toHaveBeenCalled()
})
it('joining with capture preserves existing healthy execution and only releases this lease',async()=>{
 const f=await fixture(),one=await f.watch(),two=await f.watch(true)
 expect(f.port.create).toHaveBeenCalledOnce();expect(f.owner.current.diagnostics.captureEnabled).toBe(false)
 expect((f.port.create as any).mock.calls[0][0].env.AGENTMUX_PERFORMANCE_CAPTURE_FAILURE).toBe('0')
 two.dispose();await flush();expect(f.port.stop).not.toHaveBeenCalled();expect(f.owner.current.consumerCount).toBe(1)
 one.dispose();await vi.waitFor(()=>expect(f.port.stop).toHaveBeenCalledOnce());expect(f.owner.current.consumerCount).toBe(0)
})
it('primary failure survives diagnostic write and cleanup failures independently',async()=>{
 const f=await fixture({cleanupError:true,store:{read:async()=>null,save:()=>{throw new Error('diagnostic disk full')}}});await f.watch(true);await f.bytes(Buffer.from('[bad]\n'));await flush()
 await vi.waitFor(()=>expect(f.owner.current.state).toBe('unknown'));expect(f.owner.current.diagnostics).toMatchObject({persistence:'unconfirmed',issue:{operation:'write-failure',message:null},cleanupIssue:{operation:'remove',message:null},lastFailure:{details:{stage:'toolkit-json'}}})
 expect(f.owner.current.diagnostics.lastFailure!.details.error.message).toBeNull()
})
it('slow or corrupt diagnostic read does not gate observation admission',async()=>{
 let settle!:(v:null)=>void;const f=await fixture({store:{read:()=>new Promise(resolve=>{settle=resolve}),save:async()=>{}}})
 const lease=await f.watch();expect(f.port.create).toHaveBeenCalledOnce();settle(null);lease.dispose();await flush()
 const g=await fixture({store:{read:async()=>{throw new Error('old evidence unreadable')},save:async()=>{}}});await g.watch();expect(g.port.create).toHaveBeenCalledOnce();expect(g.owner.current.diagnostics.issue).toMatchObject({operation:'read-failure',message:null})
})
it('preserves original inner CLI parser failure instead of relabeling outer JSON',async()=>{
 const f=await fixture();await f.watch(true)
 const failure={stage:'cli-rpc-json',error:toolkitFailureError(new SyntaxError('inner bad JSON')),bytes:{source:'metrics-rpc-stdout',startByte:12,endByte:17,prefixBase64:Buffer.from('[bad]').toString('base64'),suffixBase64:'',omittedBytes:0},exit:null}
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'error',reason:failure.error.message,failure})+'\n'));await flush();const result=await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot};expect(result.snapshot.diagnostics.lastFailure?.details).toEqual(failure)
})
it('separates decoder, incomplete LF and process-close facts',async()=>{
 const f=await fixture();await f.watch(true);await f.bytes(Buffer.from([0xff]));await flush();expect(f.owner.current.diagnostics.lastFailure?.details.stage).toBe('run-output-decode')
 const g=await fixture();await g.watch(true);await g.bytes(Buffer.from('[bad]'));g.accept({type:'process-state',state:'exited',exitCode:0});g.end();await flush();expect(g.owner.current.diagnostics.lastFailure?.details.stage).toBe('run-output-lf')
 const h=await fixture();await h.watch(true);h.accept({type:'process-state',state:'exited',exitCode:17,exitSignal:'SIGXCPU'});await flush();expect(h.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'process-exit',exit:{code:17,signal:'SIGXCPU'}})
})
it('reads latest bounded disk bytes without claiming durable ACK or execution admission',async()=>{
 const f=await fixture();await f.watch(true);await f.bytes(Buffer.from('[bad]\n'));await flush();await vi.waitFor(()=>expect(f.owner.current.diagnostics.persistence).toBe('confirmed'));const disk=await f.store.read(),g=await fixture({store:{read:async()=>disk,save:async()=>{}}})
 const result=await g.owner.execute(request(),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}
 expect(result.snapshot).toMatchObject({state:'idle',run:null,executionId:null,diagnostics:{failureEvidence:'retained',lastFailure:{executionId:disk!.executionId,details:{bytes:null,error:{stack:null}}},persistence:'observed-on-disk'}})
 const explicit=await g.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot};expect(explicit.snapshot.diagnostics.lastFailure).toEqual(disk)
 await writeFile(join(f.dir,'failure.json'),'x'.repeat(128*1024+1));await expect(f.store.read()).rejects.toThrow('budget')
})
it('public Unix RPC forwards explicit capture and exposes the same own failure',async()=>{
 const f=await fixture(),path=join(f.dir,'control.sock'),server=new AgentMuxControlServer({socketPath:path,coreClients:()=>[],execute:vi.fn(),toolkit:desktopToolkitPublicPort(f.owner)})
 await server.start();cleanup.push(()=>server.stop());const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path}});cleanup.push(()=>rpc.dispose())
 const frames:any[]=[],lease=await rpc.subscribe('toolkit.watch',{toolId:'performance',captureFailure:true,includeFailureEvidence:true},{onInitial:()=>{},onEvent:event=>frames.push(event),onEnd:()=>{}})
 expect(f.owner.current.diagnostics.captureEnabled).toBe(true);await f.bytes(Buffer.from('[bad]\n'));await flush();const result=await rpc.call('toolkit.inspect',{toolId:'performance'})
 expect((result.snapshot as ToolkitMetricsSnapshot).diagnostics.lastFailure?.details.stage).toBe('toolkit-json');expect(frames.some(frame=>frame.type==='snapshot'&&frame.data.diagnostics?.lastFailure?.details.bytes)).toBe(true)
 expect((result.snapshot as ToolkitMetricsSnapshot).diagnostics.lastFailure?.details.bytes).toBeNull()
 const explicit=await rpc.call('toolkit.inspect',{toolId:'performance',includeFailureEvidence:true});expect((explicit.snapshot as ToolkitMetricsSnapshot).diagnostics.lastFailure?.details.bytes).not.toBeNull();await lease.dispose()
})
it('managed Runtime refusal remains; Toolkit capture grants no arbitrary Run access',async()=>{
 await expect(new AgentMuxRpcService().call('runtime.owner.identity',{}, {caller:{agentSessionId:'fixture-managed',capability:'fixture-capability'},principal:{kind:'user',id:'fixture-transport'}} as any)).rejects.toMatchObject({code:'AGENT_CAPABILITY_INVALID'})
})

// Executes the original product script with candidate TS imports. No Native Runtime/installed claim.
it.each([
 ['syntax','process.stdout.write("[broken]\\n")','cli-rpc-json','metrics-rpc-stdout'],
 ['opening','process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"request",result:{subscriptionId:"reader",method:"wrong",initial:{observation:{}}}})+"\\n")','cli-rpc-opening','metrics-rpc-stdout'],
 ['stderr','process.stderr.write("original CLI stderr");process.exitCode=7','cli-eof','metrics-rpc-stderr'],
 ['eof','process.stdout.write(Buffer.from([0xe4]))','cli-eof','metrics-rpc-stdout']
])('actual packaged script preserves %s source stage and finite bytes',async(_name,body,stage,source)=>{
 const {spawn}=await import('node:child_process'),dir=await mkdtemp(join(tmpdir(),'amx-perf-script-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const cli=join(dir,'fixture-cli.mjs');await writeFile(cli,body)
 let stdout=''
 const channel=await openToolkitResultChannel({onBytes:bytes=>{stdout+=Buffer.from(bytes).toString('utf8')},onEnd(){},onError:()=>{}});cleanup.push(channel.close)
 const child=spawn(process.execPath,['--loader',resolve('apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'),resolve('apps/desktop/resources/toolkit/performance.mjs'),cli],{cwd:process.cwd(),env:{...process.env,...channel.env,AGENTMUX_PERFORMANCE_CAPTURE_FAILURE:'1'},stdio:['ignore','pipe','pipe']})
 cleanup.push(()=>{if(child.exitCode===null)child.kill('SIGTERM')})
 let stderr='';child.stdout.resume();child.stderr.on('data',bytes=>{stderr+=bytes})
 const code=await new Promise(resolve=>child.once('close',resolve))
 expect(code,stderr).toBe(1)
 const frames=stdout.trim().split('\n').map(line=>JSON.parse(line));expect(frames).toHaveLength(1)
 expect(frames[0]).toMatchObject({event:'error',failure:{stage,bytes:{source,startByte:0,omittedBytes:0}}})
 expect(frames[0].failure.error.stack).toBeTypeOf('string')
 expect(frames[0].reason).toBe(frames[0].failure.error.message)
})

it.each(['metrics-payload','toolkit-document','metrics-scope'])('records the actual %s validation boundary after valid JSON',async stage=>{
 const f=await fixture();await f.watch(true)
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 const frame:any={schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,diagnostics:{stderrBytes:0,stderr:null},document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''}}
 if(stage==='metrics-payload')frame.payload={invalid:true}
 if(stage==='toolkit-document')frame.document={invalid:true}
 if(stage==='metrics-scope')frame.payload.scope.mainPid=process.pid+1
 await f.bytes(Buffer.from(JSON.stringify(frame)+'\n'));await flush()
 expect(f.owner.current.diagnostics.lastFailure?.details.stage).toBe(stage)
 expect(f.owner.current.observation).toBeNull()
})

it('separates simultaneous ordinary readers from explicit evidence readers after capture',async()=>{
 const f=await fixture(),safe:any[]=[],raw:any[]=[]
 const one=await f.owner.subscribe('performance',value=>raw.push(value),vi.fn(),new AbortController().signal,{captureFailure:true,includeFailureEvidence:true})
 const two=await f.owner.subscribe('performance',value=>safe.push(value),vi.fn(),new AbortController().signal)
 await f.bytes(Buffer.from('[bad]\n'));await flush()
 expect(raw.some(value=>value.diagnostics.lastFailure?.details.bytes)).toBe(true)
 expect(safe.some(value=>value.diagnostics.lastFailure)).toBe(true)
 for(const value of safe){expect(value.diagnostics.lastFailure?.details.bytes??null).toBeNull();expect(value.diagnostics.lastFailure?.details.error.stack??null).toBeNull()}
 expect(f.port.create).toHaveBeenCalledOnce();one.dispose();two.dispose()
})
it.each(['CTXMUX_NATIVE_SERVICE_UNAVAILABLE','CTXMUX_TERMINAL_DERIVED_FAULT'])('preserves live %s source without inventing attach failure',async code=>{
 const f=await fixture();await f.watch()
 const evidence={source:'run-process',observedAt:4567,run:{runId:'original-toolkit-run'}}
 f.accept({type:'agent-error',code,message:'original live service failure',evidence});await flush()
 expect(f.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'run-event',eventOrigin:evidence,error:{code,stack:null}})
})
it('bounds a blocked durable writer to active plus latest pending and reports replaced writes',async()=>{
 let unblock!:()=>void
 const writer=vi.spyOn(Core,'durableWriteFile').mockImplementationOnce(()=>new Promise<void>(resolve=>{unblock=resolve})).mockResolvedValue(undefined)
 const f=await fixture(),base={schema:'agentmux.performance.failure.v1' as const,executionId:'one',run:null,recordedAt:1,details:{stage:'launch' as const,error:toolkitFailureError(new Error('original')),bytes:null,exit:null}}
 const one=f.store.save(base);await vi.waitFor(()=>expect(writer).toHaveBeenCalledOnce())
 const two=f.store.save({...base,executionId:'two'});let superseded:any=null;void two.catch(error=>{superseded=error})
 const three=f.store.save({...base,executionId:'three'})
 try { await flush();expect(superseded).toMatchObject({code:'TOOLKIT_DIAGNOSTIC_SUPERSEDED'});expect(writer).toHaveBeenCalledOnce() } finally { unblock() }
 await one;await three
 expect(writer).toHaveBeenCalledTimes(2);expect(JSON.parse(writer.mock.calls[1]![1] as string).executionId).toBe('three')
})
it('pending diagnostic replacement remains visible without gating new healthy observation',async()=>{
 let unblock!:()=>void
 const writer=vi.spyOn(Core,'durableWriteFile').mockImplementationOnce(()=>new Promise<void>(resolve=>{unblock=resolve})).mockResolvedValue(undefined)
 const f=await fixture()
 for(let i=0;i<3;i++){const lease=await f.watch(true);await f.bytes(Buffer.from('[bad]\n'));await flush();lease.dispose();await flush()}
 expect(f.owner.current.diagnostics.droppedWrites).toBe(1)
 const healthy=await f.watch();expect(f.port.create).toHaveBeenCalledTimes(4);expect(f.owner.current.state).toBe('observing')
 unblock();await flush();healthy.dispose()
})
it('actual script preserves notification code without collecting an ordinary stack',async()=>{
 const {spawn}=await import('node:child_process'),dir=await mkdtemp(join(tmpdir(),'amx-perf-notification-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const cli=join(dir,'fixture-cli.mjs'),observation=deepMetricsSnapshot().observation
 const opening={jsonrpc:'2.0',id:'request',result:{subscriptionId:'reader',method:'system.metrics.watch',initial:{observation}}}
 const notification={jsonrpc:'2.0',method:'system.subscription.event',params:{subscriptionId:'reader',method:'system.metrics.watch',sequence:1,event:{type:'error',error:{code:'ORIGINAL_METRICS_FAILURE',message:'original failure'}}}}
 await writeFile(cli,`process.stdout.write(${JSON.stringify(JSON.stringify(opening)+'\n'+JSON.stringify(notification)+'\n')})`)
 let stdout=''
 const channel=await openToolkitResultChannel({onBytes:bytes=>{stdout+=Buffer.from(bytes).toString('utf8')},onEnd(){},onError:()=>{}});cleanup.push(channel.close)
 const child=spawn(process.execPath,['--loader',resolve('apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'),resolve('apps/desktop/resources/toolkit/performance.mjs'),cli],{cwd:process.cwd(),env:{...process.env,...channel.env,AGENTMUX_PERFORMANCE_CAPTURE_FAILURE:'0'},stdio:['ignore','pipe','pipe']})
 cleanup.push(()=>{if(child.exitCode===null)child.kill('SIGTERM')});child.stdout.resume();child.stderr.resume()
 expect(await new Promise(resolve=>child.once('close',resolve))).toBe(1)
 const frames=stdout.trim().split('\n').map(line=>JSON.parse(line))
 expect(frames.at(-1)).toMatchObject({event:'error',failure:{stage:'cli-rpc-notification',bytes:null,error:{code:'ORIGINAL_METRICS_FAILURE',stack:null}}})
})

it.each(['before-replace','after-replace'] as const)('retains original diagnostic errno and %s phase independently',async phase=>{
 const cause=Object.assign(new Error('disk failure'),{code:'ENOSPC'})
 const f=await fixture({store:{read:async()=>null,save:async()=>{throw new Core.DurableWriteError(_hygiene_fixturePath("private/fixture"),phase,cause)}}})
 await f.watch(true);await f.bytes(Buffer.from('[bad]\n'));await flush()
 expect(f.owner.current.diagnostics.issue).toEqual({operation:'write-failure',phase,code:'ENOSPC',message:null})
 const explicit=await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}
 expect(explicit.snapshot.diagnostics.issue?.message).toBe('disk failure')
 expect(f.owner.current.diagnostics.lastFailure?.details.stage).toBe('toolkit-json')
 expect(parseToolkitSnapshot(f.owner.current)).toEqual(f.owner.current)
})

it('withholds message-only original text in ordinary reads, restart and later healthy executions',async()=>{
 const f=await fixture();const marker='PRIVATE_STDERR_MARKER_own_test';await f.watch(true)
 const failure={stage:'cli-stderr',error:{...toolkitFailureError(new Error(marker)),stack:null},bytes:null,exit:null}
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'error',reason:marker,failure})+'\n'));await flush();await vi.waitFor(()=>expect(f.owner.current.diagnostics.persistence).toBe('confirmed'))
 expect(f.owner.current.reason).toBe(marker)
 expect(f.owner.current.diagnostics).toMatchObject({failureEvidence:'retained',lastFailure:{details:{error:{message:null,stack:null},bytes:null}}})
 expect(JSON.stringify(f.owner.current.diagnostics)).not.toContain(marker)
 const raw=await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot};expect(raw.snapshot.diagnostics.lastFailure?.details.error.message).toBe(marker)
 const lease=await f.watch();expect(f.owner.current.reason).toBeNull();expect(JSON.stringify(f.owner.current)).not.toContain(marker);expect(f.owner.current.diagnostics.failureEvidence).toBe('retained');lease.dispose()
 const disk=await f.store.read(),g=await fixture({store:{read:async()=>disk,save:async()=>{}}})
 const safe=await g.owner.execute(request(),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot};expect(JSON.stringify(safe)).not.toContain(marker);expect(safe.snapshot.diagnostics.failureEvidence).toBe('retained')
 const loaded=await g.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot};expect(loaded.snapshot.diagnostics.lastFailure?.details.error.message).toBe(marker)
})

it.each(['[native/startup] arbitrary terminal log\r\n','{"event":"result","sequence":999}\n'])('isolates terminal diagnostics from the result channel: %s',async noise=>{
 const f=await fixture();await f.watch(true)
 f.terminal(Buffer.from(noise))
 expect(f.owner.current.diagnostics.lastFailure).toBeNull()
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,
  document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n'))
 expect(f.owner.current).toMatchObject({state:'observing',sequence:1,diagnostics:{output:{terminalBytes:Buffer.byteLength(noise),terminal:null,terminalGap:false},lastFailure:null,failureEvidence:'retained'}})
 expect(parseToolkitSnapshot(f.owner.current)).toEqual(f.owner.current)
 const explicit=await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}
 expect(Buffer.from(explicit.snapshot.diagnostics.output!.terminal!.prefixBase64,'base64').toString()).toBe(noise)
 expect(explicit.snapshot.diagnostics.output!.executionId).toBe(f.owner.current.executionId)
 expect(explicit.snapshot.diagnostics.output!.run).toEqual(f.owner.current.run)
 await f.bytes(Buffer.from('[bad]\n'));await vi.waitFor(()=>expect(f.owner.current.diagnostics.persistence).toBe('confirmed'))
 const failure=await f.store.read();expect(failure?.details.stage).toBe('toolkit-json')
 expect(failure?.details.diagnosticOutput).toEqual([explicit.snapshot.diagnostics.output!.terminal])
 expect(f.owner.current.diagnostics.lastFailure?.details.diagnosticOutput).toEqual([])
})
it.each(['[native/startup] diagnostic only\n','{"jsonrpc":"2.0","error":"diagnostic only"}\n'])('actual script drains finite stderr without failing healthy metrics: %s',async noise=>{
 const {spawn}=await import('node:child_process'),dir=await mkdtemp(join(tmpdir(),'amx-perf-noise-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
 const cli=join(dir,'fixture-cli.mjs'),observation=deepMetricsSnapshot().observation
 const opening={jsonrpc:'2.0',id:'request',result:{subscriptionId:'reader',method:'system.metrics.watch',initial:{observation}}}
 await writeFile(cli,`process.stderr.write(${JSON.stringify(noise)});await new Promise(r=>setTimeout(r,30));process.stdout.write(${JSON.stringify(JSON.stringify(opening)+'\n')});`)
 let output=''
 const channel=await openToolkitResultChannel({onBytes:bytes=>{output+=Buffer.from(bytes).toString('utf8')},onEnd(){},onError:()=>{}});cleanup.push(channel.close)
 const child=spawn(process.execPath,['--loader',resolve('apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'),resolve('apps/desktop/resources/toolkit/performance.mjs'),cli],{cwd:process.cwd(),env:{...process.env,...channel.env,AGENTMUX_PERFORMANCE_CAPTURE_FAILURE:'1'},stdio:['ignore','pipe','pipe']})
 cleanup.push(()=>{if(child.exitCode===null)child.kill('SIGTERM')});child.stdout.resume();child.stderr.resume()
 expect(await new Promise(resolve=>child.once('close',resolve))).toBe(0)
 const frames=output.trim().split('\n').map(line=>JSON.parse(line));expect(frames).toHaveLength(1)
 expect(frames[0]).toMatchObject({event:'result',sequence:1,diagnostics:{stderrBytes:Buffer.byteLength(noise),stderr:{source:'metrics-rpc-stderr',omittedBytes:0}}})
 expect(Buffer.from(frames[0].diagnostics.stderr.prefixBase64,'base64').toString()).toBe(noise)
})
it('backpressures results before Core creation acknowledgement without inventing Run identity',async()=>{
 const f=await fixture();let release!:()=>void, connected!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{connected=resolve})
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 ;(f.port.create as any).mockImplementationOnce(async(input:any)=>{
  const socket=await connectToolkitResultChannel({...input.env});socket.on('error',()=>{})
  socket.write(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n')
  connected();await blocked;return {runId:'acknowledged-original',kind:'terminal',pid:123}
 })
 const watch=f.watch();await ready;await flush()
 expect(f.owner.current).toMatchObject({run:null,observation:null,sequence:0})
 release();await watch;await vi.waitFor(()=>expect(f.owner.current).toMatchObject({run:{runId:'acknowledged-original'},sequence:1}))
})
it('drains the final explicit script failure after an earlier Core exit notification',async()=>{
 const f=await fixture();await f.watch(true)
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n'))
 f.accept({type:'process-state',state:'exited',exitCode:9})
 const failure={stage:'cli-rpc-notification',error:{...toolkitFailureError(new Error('final typed error')),code:'FINAL_TYPED_FAILURE'},bytes:null,exit:null}
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'error',reason:failure.error.message,failure})+'\n'))
 await vi.waitFor(()=>expect(f.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'cli-rpc-notification',error:{code:'FINAL_TYPED_FAILURE'}}))
})
it('late old failure read never borrows terminal evidence from a new execution',async()=>{
 let finishRead!:(value:any)=>void
 const old={schema:'agentmux.performance.failure.v1' as const,executionId:'old-A',run:{hostId:'local',runId:'run-A'},recordedAt:1,details:{stage:'launch' as const,error:toolkitFailureError(new Error('old-A-only')),bytes:null,exit:null}}
 const f=await fixture({store:{read:()=>new Promise(resolve=>{finishRead=resolve}),save:async()=>{}}})
 await f.watch(true);f.terminal(Buffer.from('new-B-only'))
 expect(f.owner.current.executionId).not.toBe(old.executionId)
 finishRead(structuredClone(old));await flush()
 const result=await f.owner.execute(request(true),new AbortController().signal) as {snapshot:ToolkitMetricsSnapshot}
 expect(result.snapshot.diagnostics.lastFailure).toEqual(old)
 expect(result.snapshot.diagnostics.output!.executionId).toBe(f.owner.current.executionId)
 expect(Buffer.from(result.snapshot.diagnostics.output!.terminal!.prefixBase64,'base64').toString()).toBe('new-B-only')
})
it('known Run exit exposes bounded draining and never reuses a stuck result stream as observing',async()=>{
 const f=await fixture();await f.watch(true)
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n'))
 f.accept({type:'process-state',state:'exited',exitCode:9})
 expect(f.owner.current).toMatchObject({state:'unknown',sequence:1});expect(f.owner.current.reason).toContain('draining')
 await expect(f.watch()).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
 await vi.waitFor(()=>expect(f.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'result-channel',exit:{code:9},error:{code:'CONTROL_TIMEOUT'}}),{timeout:4000})
 await vi.waitFor(()=>expect(f.owner.current.run).toBeNull())
 expect(f.port.stop).not.toHaveBeenCalled();expect(f.port.release).toHaveBeenCalledOnce();expect(f.port.remove).toHaveBeenCalledOnce()
})
it.each([false,true])('keeps actual channel I/O origin after attach/result (result=%s)',async observed=>{
 const channels=await import('../../../packages/core/src/toolkit-result-channel.js'),actual=channels.openToolkitResultChannel
 let channelError!:(error:unknown)=>void
 vi.spyOn(channels,'openToolkitResultChannel').mockImplementation(args=>{channelError=args.onError;return actual(args)})
 const f=await fixture();await f.watch(true)
 if(observed){const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n'))}
 channelError(Object.assign(new Error('own synthetic socket reset'),{code:'ECONNRESET'}));await flush()
 expect(f.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'result-channel',error:{code:'ECONNRESET'}})
})

it('attach completion preserves known exit while original result bytes drain',async()=>{
 const f=await fixture();let finishAttach!:(value:any)=>void,entered!:()=>void
 const ready=new Promise<void>(resolve=>{entered=resolve})
 ;(f.port.attach as any).mockImplementationOnce(()=>{entered();return new Promise(resolve=>{finishAttach=resolve})})
 const watch=f.watch(true);await ready
 const payload=deepMetricsSnapshot().observation!;payload.scope.mainPid=process.pid
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,payload,document:{schema:'agentmux.toolkit.result.v1',summary:'Runs',items:[],links:[],notice:''},diagnostics:{stderrBytes:0,stderr:null}})+'\n'))
 f.accept({type:'process-state',state:'exited',exitCode:9})
 finishAttach({replay:[],gap:null});await watch
 expect(f.owner.current).toMatchObject({state:'unknown',sequence:1});expect(f.owner.current.reason).toContain('draining')
 const failure={stage:'cli-rpc-notification',error:{...toolkitFailureError(new Error('final typed error')),code:'FINAL_TYPED_FAILURE'},bytes:null,exit:null}
 await f.bytes(Buffer.from(JSON.stringify({schema:'agentmux.toolkit.result.v1',event:'error',reason:failure.error.message,failure})+'\n'))
 await vi.waitFor(()=>expect(f.owner.current.diagnostics.lastFailure?.details).toMatchObject({stage:'cli-rpc-notification',error:{code:'FINAL_TYPED_FAILURE'}}))
})

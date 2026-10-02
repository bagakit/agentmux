import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mainFixtureState, children, cleanups, cli, nativeMain, until, oneCli, record, processes, executionGroup, alive, terminalMetadata, storage } from './toolkit-main.fixture.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, copyFile, rm, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createConnection } from 'node:net'
import { PROTOCOL_VERSION } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import type { ToolkitMetricsSnapshot as ToolkitSnapshot } from '@agentmux/core/control'
import * as assets from '../src/main/toolkit-asset.js'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts.js'
import * as terminalQueries from '../src/shared/terminal-osc-color-query.js'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const fixture = mainFixtureState()
describe('registered Main official Performance vertical slice',()=>{
  it('actual production asset helper reads packaged app resources and invokes the current compiled CLI from the exact app topology',async()=>{
    const directory=await mkdtemp(_hygiene_fixturePath("tmp/amx-toolkit-package-")),root=join(directory,'Contents','Resources','app')
    cleanups.push(()=>rm(directory,{recursive:true,force:true}))
    await mkdir(join(root,'resources','toolkit'),{recursive:true});await mkdir(join(root,'node_modules','@agentmux','core','dist'),{recursive:true})
    await copyFile(resolve('apps/desktop/resources/toolkit/performance.mjs'),join(root,'resources','toolkit','performance.mjs'))
    const core=resolve('packages/core'),packagedCore=join(root,'node_modules','@agentmux','core')
    await symlink(join(core,'package.json'),join(packagedCore,'package.json'))
    await symlink(join(core,'node_modules'),join(packagedCore,'node_modules'),'dir')
    for(const entry of await readdir(join(core,'dist'))) {
      if(entry !== 'agentmux.js')await symlink(join(core,'dist',entry),join(packagedCore,'dist',entry))
    }
    const productionLaunch=assets.performanceLaunch,m=await nativeMain()
    await symlink(process.env.AGENTMUX_TOOLKIT_CLI!,join(root,'node_modules','@agentmux','core','dist','agentmux.js'))
    fixture.packaged=true;fixture.appPath=root
    const launch=productionLaunch()
    expect(launch.script).toBe(join(root,'resources','toolkit','performance.mjs'))
    expect(launch.cli).toBe(join(root,'node_modules','@agentmux','core','dist','agentmux.js'))
    const script=await assets.readPerformanceScript(launch)
    expect(script.text).toBe(await readFile(resolve('apps/desktop/resources/toolkit/performance.mjs'),'utf8'))
    expect(script.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const help=await exec(launch.runner,[launch.cli,'--help','toolkit','watch'],{env:{...process.env,...launch.env}})
    expect(help.stdout.trim().length).toBeGreaterThan(30)
    const child=spawn(launch.runner,[launch.script,launch.cli],{cwd:launch.cwd,env:{...process.env,...launch.env},stdio:['ignore','pipe','pipe']})
    children.push(child)
    let stdout='',stderr='',code:number|null|undefined
    child.stdout!.on('data',bytes=>{stdout+=bytes});child.stderr!.on('data',bytes=>{stderr+=bytes});child.once('close',value=>{code=value})
    const frames=()=>stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line))
    await until(()=>{expect(code,stderr).toBeUndefined();expect(frames().length).toBeGreaterThanOrEqual(2)},15000)
    expect(frames()).toEqual(expect.arrayContaining([expect.objectContaining({schema:'agentmux.toolkit.result.v1',event:'result',sequence:1,
      payload:expect.objectContaining({schema:'agentmux.metrics.v1'})})]))
    expect(frames().map(frame=>frame.sequence)).toEqual(frames().map((_,index)=>index+1))
    child.kill('SIGTERM');await until(()=>expect(code,stderr).not.toBeUndefined())
    expect(frames().every(frame=>frame.event==='result')).toBe(true)
    await until(()=>expect((m.sampler as any).subscribers.size).toBe(0))
    await record('packaged-topology',{root,launch,sha256:script.sha256,help:help.stdout,frames:frames(),exitCode:code})
  })
  it('actual CLI/help/asset, shared consumers and ten native closed/reopen retirements preserve an external metrics observer and healthy Run',async()=>{
    const m=await nativeMain()
    const before=await readFile(join(m.directory,'config.json'))
    const healthy=await m.runtime.launchTerminal({hostId:'local',workspacePath:join(m.directory,'work'),shellCommand:'cat'},m.config)
    expect(healthy.kind).toBe('terminal');const healthyRef=healthy.control.run
    const original=(await m.core.listRuns()).find(run=>run.runId===healthyRef.runId)
    expect(original?.state).toBe('running');expect(original?.pid).toBeGreaterThan(0)
    const baseline=(await m.core.listRuns()).map(run=>run.runId)
    expect(baseline).toContain(healthyRef.runId)
    expect(m.sender.events.filter(e=>e.channel===SESSION_EVENT_CHANNEL && e.value.event?.run?.runId===healthyRef.runId).length).toBeGreaterThan(0)
    const scan=vi.spyOn(terminalQueries,'scanTerminalOscColorQueries')
    const baselineMetadata=terminalMetadata(m.core)
    expect(baselineMetadata.runPids.map(([id])=>id)).toContain(healthyRef.runId)
    const runningRemoval=await m.core.removeTerminal(healthyRef).then(()=>({accepted:true}),error=>({accepted:false,code:error.code}))
    expect(runningRemoval).toMatchObject({accepted:false,code:expect.stringMatching(/^CTXMUX_/u)})
    for(const verb of ['ls','inspect','script','run','stop','watch']) {
      const h=cli('--help','toolkit',verb);await until(()=>expect(h.code).not.toBeUndefined());expect(h.code,h.stderr).toBe(0);expect(h.stdout.trim().length).toBeGreaterThan(30)
    }
    expect((await oneCli('toolkit','ls')).result.tools).toEqual([{kind:'metrics',toolId:'performance',name:'Performance',readonly:true}])
    const script=(await oneCli('toolkit','script','performance')).result.script
    expect(script.text).toBe(await readFile(process.env.AGENTMUX_TOOLKIT_ASSET ?? resolve('apps/desktop/resources/toolkit/performance.mjs'),'utf8'))
    expect(script.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const external:unknown[]=[]
    const metric=await m.rpc.subscribe('system.metrics.watch',{}, {
      onInitial:initial=>external.push(initial.observation),
      onEvent:event=>{if(event.type==='snapshot')external.push(event.data)},onEnd:()=>{}
    })
    cleanups.push(async()=>metric.dispose())
    let snapshots:ToolkitSnapshot[]=[], endError:Error|undefined
    const establishment=await m.rpc.subscribe('toolkit.watch',{toolId:'performance'},{onInitial:()=>{},onEvent:event=>{
      if(event.type==='snapshot'){if(event.data.kind!=='metrics')throw new Error('Performance requires its metrics snapshot');snapshots.push(event.data)}
    },onEnd:e=>{endError=e}})
      .then(watcher=>({watcher,error:null}),error=>({watcher:null,error}))
    expect(establishment.error,'Actual owned RawRun Toolkit observation must establish before consumer reads').toBeNull()
    expect(establishment.watcher,'Actual Toolkit observation must return its own disposer').toHaveProperty('dispose',expect.any(Function))
    const watcher=establishment.watcher!
    cleanups.push(async()=>watcher.dispose())
    await until(()=>{expect(endError).toBeUndefined();expect(snapshots.filter(v=>v.sequence>0).length).toBeGreaterThanOrEqual(2)},15000)
    expect(scan).not.toHaveBeenCalled()
    const execution=snapshots.at(-1)!.executionId,ref=snapshots.at(-1)!.run!
    expect(ref.runId).not.toBe(healthyRef.runId);expect((await m.core.listRuns()).length).toBe(baseline.length+1)
    await m.invoke('toolkit:observe','performance','actual-ui-lease')
    expect((await m.rpc.call('toolkit.inspect',{toolId:'performance'}))).toMatchObject({snapshot:{executionId:execution,consumerCount:2}})
    await m.invoke('toolkit:release','actual-ui-lease')
    expect((await m.rpc.call('toolkit.inspect',{toolId:'performance'}))).toMatchObject({snapshot:{executionId:execution,consumerCount:1}})
    expect(snapshots.at(-1)!.observation!.process.data!.length).toBeGreaterThan(0)
    const manual=(await oneCli('toolkit','run','performance')).result.snapshot
    expect(manual.executionId).toBe(execution)
    const ownPid=(await m.sdk.status(ref.runId as any)).pid!;expect(ownPid).toBeGreaterThan(0)
    const group=await executionGroup(ownPid)
    expect(group.length).toBeGreaterThanOrEqual(2)
    expect(group.some(p=>p.command.includes('metrics watch'))).toBe(true)
    await watcher.dispose()
    await until(()=>expect((m.sampler as any).subscribers.size).toBe(2))
    expect((await m.rpc.call('toolkit.inspect',{toolId:'performance'}))).toMatchObject({snapshot:{manual:true,consumerCount:0,state:'observing'}})
    let sequence=manual.sequence
    for(let n=0;n<3;n++){
      let current!:ToolkitSnapshot
      for(let attempt=0;attempt<150;attempt++){
        const snapshot=(await m.rpc.call('toolkit.inspect',{toolId:'performance'})).snapshot
        expect(snapshot.kind).toBe('metrics')
        if(snapshot.kind!=='metrics')throw new Error('Performance requires its own metrics snapshot')
        current=snapshot
        if(current.sequence>sequence)break
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      expect(current.sequence).toBeGreaterThan(sequence);sequence=current.sequence
      const native=await m.sdk.status(ref.runId as any),files=await storage(join(m.directory,'state','ctxmux'))
      expect(native.latest_output_bytes).toBeGreaterThan(0);expect(native.durable_output_bytes).not.toBeNull()
      await record('storage-trend',{n,observedAt:Date.now(),sequence,runId:ref.runId,
        latestOutputBytes:native.latest_output_bytes,durableOutputBytes:native.durable_output_bytes,firstAvailableByte:native.first_available_byte,files})
    }
    expect((await oneCli('toolkit','stop','performance')).result.snapshot.state).toBe('paused')
    await until(()=>expect(group.filter(p=>alive(p.pid))).toEqual([]))
    expect(terminalMetadata(m.core)).toEqual(baselineMetadata)
    await record('execution-group',{phase:'explicit-stop',group,allExited:true})
    for(let n=0;n<10;n++){
      const seen:ToolkitSnapshot[]=[]
      const lease=await m.rpc.subscribe('toolkit.watch',{toolId:'performance'},{onInitial:()=>{},onEvent:event=>{
        if(event.type==='snapshot'){if(event.data.kind!=='metrics')throw new Error('Performance requires its metrics snapshot');seen.push(event.data)}
      },onEnd:e=>{endError=e}})
      await until(()=>{expect(endError).toBeUndefined();expect(seen.some(v=>v.sequence>0)).toBe(true)},15000)
      const own=seen.at(-1)!.run!;expect(own.runId).toBeTruthy()
      const ownProcess=(await m.core.listRuns()).find(run=>run.runId===own.runId);expect(ownProcess?.pid).toBeGreaterThan(0)
      const closedGroup=await executionGroup(ownProcess!.pid!)
      expect(closedGroup.length).toBeGreaterThanOrEqual(2)
      await lease.dispose()
      await until(()=>expect((m.sampler as any).subscribers.size).toBe(1))
      try {await until(async()=>expect((await m.core.listRuns()).map(run=>run.runId).sort()).toEqual([...baseline].sort()))}
      catch(error){await record('cleanup-failure',{list:await m.core.listRuns(),snapshot:(await m.rpc.call('toolkit.inspect',{toolId:'performance'}))});throw error}
      expect((await m.core.listRuns()).find(run=>run.runId===healthyRef.runId)?.pid).toBe(original?.pid)
      await until(()=>expect(closedGroup.filter(p=>alive(p.pid))).toEqual([]))
      // Removal plus an event-loop turn settle the real Attachment pump.
      await new Promise<void>(resolve=>setImmediate(resolve))
      expect(terminalMetadata(m.core)).toEqual(baselineMetadata)
      const leaked=m.sender.events.filter(e=>e.channel===SESSION_EVENT_CHANNEL&&e.value?.event?.type==='terminal-output'&&e.value?.event?.run?.runId===own.runId)
      expect(leaked).toEqual([])
      await record('cycles',{n,ownRun:own.runId,ownPid:ownProcess?.pid,remaining:(await m.core.listRuns()).map(run=>run.runId),external:external.length,
        metadata:terminalMetadata(m.core),baselineMetadata})
    }
    expect(external.length).toBeGreaterThan(2)
    await metric.dispose()
    await until(()=>expect((m.sampler as any).subscribers.size).toBe(0))
    expect((m.sampler as any).timer).toBeNull()
    expect(await readFile(join(m.directory,'config.json'))).toEqual(before)
    const final=await m.core.listRuns();expect(final).toHaveLength(baseline.length);expect(final[0]?.state).toBe('running')
    await m.core.attachTerminal(healthyRef.runId)
    const beforeInput=(await m.sdk.status(healthyRef.runId as any)).applied_input_bytes!
    const ack=await m.core.writeTerminal(healthyRef,{ownerInstanceId:await m.sdk.daemonInstance(),operationId:crypto.randomUUID(),expectedByte:beforeInput,data:'healthy-after-toolkit\n'})
    expect(ack.acceptedThroughByte).toBeGreaterThan(beforeInput)
    const healthReplay=await m.core.readRunReplay(healthyRef)
    expect(healthReplay.replay.map(c=>Buffer.from(c.dataBytes).toString()).join('')).toContain('healthy-after-toolkit')
    await until(()=>expect(scan).toHaveBeenCalled())
    await m.core.stopTerminal(healthyRef)
    await m.core.releaseRunAttachment(healthyRef)
    await m.core.removeTerminal(healthyRef)
    expect(await m.core.listRuns()).toEqual([])
    expect(terminalMetadata(m.core)).toEqual({runPids:[],endedRuns:[],stopRequestedRuns:[]})
    await record('native',{identity:m.core.runtimeIdentity(),script,observations:snapshots.length,external:external.length,cycles:10})
  })
  it('normal registered Main disposal releases a running manual execution and its actual CLI group',async()=>{
    const m=await nativeMain()
    const snapshot=(await oneCli('toolkit','run','performance')).result.snapshot as ToolkitSnapshot
    expect(snapshot.manual).toBe(true);expect(snapshot.run?.runId).toBeTruthy()
    let current!:ToolkitSnapshot
    for(let attempt=0;attempt<150;attempt++){
      const snapshot=(await m.rpc.call('toolkit.inspect',{toolId:'performance'})).snapshot
        expect(snapshot.kind).toBe('metrics')
        if(snapshot.kind!=='metrics')throw new Error('Performance requires its own metrics snapshot')
        current=snapshot
      if(current.sequence>=2)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    expect(current.sequence).toBeGreaterThanOrEqual(2)
    const group=await executionGroup((await m.sdk.status(current.run!.runId as any)).pid!)
    expect(group.length).toBeGreaterThanOrEqual(2)
    await m.dispose()
    expect(await m.sdk.list()).toEqual([])
    await until(()=>expect(group.filter(p=>alive(p.pid))).toEqual([]))
    expect((m.sampler as any).subscribers.size).toBe(0);expect((m.sampler as any).timer).toBeNull()
    await record('execution-group',{phase:'registered-Main-dispose',group,allExited:true})
  })
  it('actual public terminal removal rejects an ended Run held by a slow raw Attachment without tearing down its pin',async()=>{
    const m=await nativeMain(),run=await m.core.createTerminal({createOperationId:crypto.randomUUID(),workspacePath:join(m.directory,'work'),
      command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(512*1024));setInterval(()=>{},1000)"]})
    const ref={runId:run.runId}
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).latest_output_bytes>=512*1024)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).latest_output_bytes).toBeGreaterThanOrEqual(512*1024)
    const socket=createConnection(join(m.directory,'ctxmux.sock'));cleanups.push(()=>{socket.destroy();return Promise.resolve()})
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
    const hello= new Promise<any>((resolve,reject)=>{let text='';const read=(b:Buffer)=>{text+=b.toString();if(text.includes('\n')){socket.off('data',read);socket.pause();resolve(JSON.parse(text.split('\n')[0]!))}};socket.on('data',read);socket.once('error',reject)})
    socket.write(JSON.stringify({type:'hello',hello:{protocol:PROTOCOL_VERSION}})+'\n')
    expect((await hello).type).toBe('hello')
    socket.write(JSON.stringify({type:'request',request:{type:'attach',id:run.runId,after_byte:0,view:'raw'}})+'\n')
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).attachments>0)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).attachments).toBeGreaterThan(0)
    await m.core.stopTerminal(ref)
    await until(async()=>expect((await m.sdk.status(run.runId as any)).state.type).toBe('exited'))
    await expect(m.core.removeTerminal(ref)).rejects.toMatchObject({code:'CTXMUX_backend_unavailable'})
    expect((await m.sdk.status(run.runId as any)).attachments).toBeGreaterThan(0)
    socket.destroy()
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).attachments===0)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).attachments).toBe(0)
    await m.core.removeTerminal(ref)
    expect((await m.sdk.list()).map(v=>v.id)).toEqual([])
    await record('terminal-removal',{runId:run.runId,bytes:512*1024,endedPinnedRefused:true,disconnectThenRemoved:true})
  })
})

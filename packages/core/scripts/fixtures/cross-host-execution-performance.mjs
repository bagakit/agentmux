import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 * 1024;
function deferred() { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; }
const percentile = (samples, fraction) => [...samples].sort((a,b)=>a-b)[Math.min(samples.length-1, Math.ceil(samples.length*fraction)-1)];
const stats = samples => { assert(samples.length > 0); return {count:samples.length, minMs:Math.min(...samples), medianMs:percentile(samples,.5), p95Ms:percentile(samples,.95), maxMs:Math.max(...samples)}; };

// Read only bytes after the exact producer cut. The previous byte lets the first
// newline discard a possible partial old frame without guessing its JSON boundary.
export async function waitForProducerOutput(client,runId,until,release) {
    const subject=await client.runtimeSubject({kind:'terminal-run',runId});
    assert.equal(subject.run.runId,runId);
    let cursor=Math.max(0,subject.run.latestOutputBytes-1),discardPrefix=cursor>0,pending=Buffer.alloc(0);
    const observation={startByte:cursor,endByte:cursor,readCount:0,bytes:0};
    await release();
    await until(async()=>{
        const replay=await client.readRunReplay({runId},cursor,'raw');
        assert.equal(replay.run.runId,runId);assert.equal(replay.gap,null);observation.readCount++;
        const parts=[pending];
        for(const chunk of replay.replay){assert.equal(chunk.startByte,cursor);assert.equal(chunk.endByte-chunk.startByte,chunk.dataBytes.length);parts.push(Buffer.from(chunk.dataBytes));cursor=chunk.endByte;observation.bytes+=chunk.dataBytes.length;}
        const bytes=Buffer.concat(parts);let from=0,found=false;
        for(;;){const end=bytes.indexOf(10,from);if(end<0)break;
            if(discardPrefix)discardPrefix=false;
            else if(end>from){const frame=JSON.parse(bytes.subarray(from,end).toString());if(frame.payload?.method==='process/output'&&frame.payload.params.chunk?.startsWith(Buffer.from('s'.repeat(12)).toString('base64')))found=true;}
            from=end+1;
        }
        pending=bytes.subarray(from);observation.endByte=cursor;return found;
    },'Original producer output underway');
    return observation;
}

export function nativeConcurrencyWindow(producer,samples,commands) {
    const valid=value=>Number.isSafeInteger(value.startedAt)&&Number.isSafeInteger(value.completedAt)&&value.completedAt>=value.startedAt;
    assert(valid(producer)&&producer.completedAt>producer.startedAt&&producer.outputBytes===4*MiB);
    assert(samples.length===6&&commands.length===6&&new Set(commands.map(row=>row.index)).size===6);
    const nativeCommands=samples.map(step=>{const command=commands.find(row=>row.label===step.label&&row.index===step.index);assert(command&&valid(command));return {...command,callId:step.callId};});
    const overlappingCallIds=nativeCommands.filter(value=>value.startedAt>=producer.startedAt&&value.completedAt<=producer.completedAt).map(value=>value.callId);
    assert(overlappingCallIds.length>0,'No healthy native command completed during actual production; concurrent progress is unqualified');
    return {clock:'resource-host-monotonic-ms',scope:'Native command execution through stdout write callback; tool reply timestamps are separate, not full stream delivery times',producer,nativeCommands,totalCount:samples.length,overlapCount:overlappingCallIds.length,overlappingCallIds,
        excludedSamples:samples.filter(step=>!overlappingCallIds.includes(step.callId)).map(({callId,emittedAt,completedAt,roundtripMs})=>({callId,emittedAt,completedAt,roundtripMs}))};
}

// Tool timing is measured at the controlled Responses endpoint: emitted native tool
// instruction to its original call_id output in a subsequent model request. It is
// a full native tool roundtrip, not an inference from terminal presentation text.
export async function performanceModelItem(context, value, tools, quote, receivedAt = performance.now()) {
    const now = receivedAt;
    for (const item of value.input ?? []) {
        if (!['function_call_output','custom_tool_call_output'].includes(item.type)) continue;
        const step=context.steps.find(step=>step.callId===item.call_id);
        if (step && step.completedAt === undefined) {
            assert(step.emittedAt !== undefined, 'Unknown original tool output');
            step.completedAt=now; step.roundtripMs=now-step.emittedAt;
        }
    }
    const step=context.steps.find(step=>step.completedAt===undefined);
    if (!step) {
        context.completedAt=now;
        return {type:'message',id:'complete-'+context.marker,role:'assistant',status:'completed',content:[{type:'output_text',text:'COMPLETE_'+context.marker,annotations:[]}]};
    }
    assert.equal(step.emittedAt, undefined, 'One original native call is still unresolved; do not repeat');
    if (step.gate) { context.waitingAtGate=true; await step.gate; }
    step.emittedAt=performance.now();
    if (step.patch) {
        const tool=tools.find(tool=>tool.name==='apply_patch');
        if (!tool) {
            const execTool=tools.find(tool=>tool.name==='exec_command');assert(execTool);
            return {type:'function_call',call_id:step.callId,name:'exec_command',arguments:JSON.stringify({cmd:"apply_patch <<'PATCH'\n"+step.patch+"\nPATCH",workdir:context.workspace,yield_time_ms:30000,max_output_tokens:1000}),...(execTool.namespace?{namespace:execTool.namespace}:{})};
        }
        return {type:'custom_tool_call',call_id:step.callId,name:'apply_patch',input:step.patch,...(tool.namespace?{namespace:tool.namespace}:{})};
    }
    const tool=tools.find(tool=>tool.name==='exec_command');assert(tool);
    return {type:'function_call',call_id:step.callId,name:'exec_command',arguments:JSON.stringify({cmd:quote(context.nodePath)+' -e '+quote(step.code),workdir:context.workspace,yield_time_ms:30000,max_output_tokens:1000}),...(tool.namespace?{namespace:tool.namespace}:{})};
}

export async function runPerformance(h) {
    const {direction,local,remote,root,remoteNodePath,performanceContexts,xterm,cli,pair,frames,rangedFrames,helperFacts,sameHelpers,until,deadline,save,read,writeResource,ssh,control,errors}=h;
    const {agent,resource,name}=direction;
    const scope = '/tmp/amx-perf-'+randomUUID();
    const collision = join(scope,'same-path.txt');
    // The exact tool path string exists on both physical Hosts. Mac /tmp resolving
    // to /private/tmp does not change the requested native path or waive this check.
    await fs.mkdir(scope,{mode:0o700});
    await ssh([remoteNodePath,'-e','require("node:fs").mkdirSync(process.argv[1],{mode:0o700})',scope]);
    const sentinels={local:'MAC_'+randomUUID(),remote:'LINUX_'+randomUUID()};
    for(const owner of [local,remote]) await writeResource(owner,collision,sentinels[owner.name]+'\n');
    const nodePath=resource.name==='local'?process.execPath:remoteNodePath;
    const contexts=[], terminals=[], gates=[];
    const small = (label,index) => ({label,index,code:`const f=require('node:fs'),clock=()=>Number(process.hrtime.bigint()/1000000n),startedAt=clock();f.appendFileSync('effects-${label}.txt',${JSON.stringify(index+'\n')});process.stdout.write(${JSON.stringify(label+'_'+index+'\n')},()=>f.appendFileSync('command-times.jsonl',JSON.stringify({label:${JSON.stringify(label)},index:${index},startedAt,completedAt:clock()})+'\\n'))`});
    const fileBytes = ('x'.repeat(1023)+'\n').repeat(1024);
    const largePath=join(scope,'one-mib.txt');
    const underLoad=deferred();gates.push(underLoad);
    const createContext = (role, steps) => {
        const marker='PERF_'+role+'_'+randomUUID();
        const context={marker,role,workspace:scope,nodePath,steps:steps.map((step,index)=>({...step,callId:'perf_'+marker+'_'+index})),createdAt:performance.now()};
        contexts.push(context);performanceContexts.push(context);return context;
    };
    const primary=createContext('producer',[
        {label:'collision',code:`const f=require('node:fs');if(f.readFileSync('same-path.txt','utf8')!==${JSON.stringify(sentinels[resource.name]+'\n')})throw Error('wrong resource');f.writeFileSync('same-path.txt',${JSON.stringify('RESOURCE_ONLY\n')});console.log('collision checked')`},
        ...Array.from({length:6},(_,index)=>small('reused',index)),
        {label:'file-1mib',patch:'*** Begin Patch\n*** Add File: '+largePath+'\n'+fileBytes.trimEnd().split('\n').map(line=>'+'+line).join('\n')+'\n*** End Patch'},
        {label:'output-1mib',code:`process.stdout.write('o'.repeat(${MiB}))`},
        {label:'slow-output',code:`const f=require('node:fs'),clock=()=>Number(process.hrtime.bigint()/1000000n);f.writeFileSync('producer-ready','ready');const wait=setInterval(()=>{if(f.existsSync('release-producer')){clearInterval(wait);const startedAt=clock();let count=0;const stream=setInterval(()=>{const last=++count===64;if(last)clearInterval(stream);process.stdout.write('s'.repeat(65536),last?()=>f.writeFileSync('producer-times.json',JSON.stringify({startedAt,completedAt:clock(),outputBytes:4194304})):undefined)},250)}},50)`}
    ]);
    const secondary=createContext('healthy',[
        ...Array.from({length:6},(_,index)=>small('baseline',index)),
        ...Array.from({length:6},(_,index)=>({...small('under-load',index),...(index===0?{gate:underLoad.promise}:{})}))
    ]);
    async function launch(context) {
        const bindingId=randomUUID(), agentSessionId=randomUUID();
        const input={bindingId,agentHostId:agent.name,agentRuntimeId:agent.client.runtimeOwnerIdentity().runtimeId,resourceHostId:resource.name,resourceRuntimeId:resource.client.runtimeOwnerIdentity().runtimeId,resourceWorkspacePath:scope,resourceGrant:{scope:'host-user',bindingId},agent:{agentSessionId,createOperationId:randomUUID(),executorId:agent.configured.executor.executorId,executorRevision:agent.configured.executor.configRevision,workspacePath:join(agent.base,'workspace'),prompt:context.marker+': run the controlled native performance tools.'}};
        const file=join(root,name+'-'+context.role+'-create.json');await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
        context.createStartedAt=performance.now();
        const result=await cli(local,['agent','execution','create','--input',file]);
        assert.equal(result.code,0,JSON.stringify(result.packet));
        const session=result.packet.result.session;assert.equal(session.agentSessionId,agentSessionId);
        context.session=session;context.bindingId=bindingId;context.originalPair=pair(local,bindingId);
        assert.deepEqual(context.originalPair.input,input);
        const terminal=new xterm.Terminal({cols:120,rows:40,allowProposedApi:true});
        terminal.onData(data=>void agent.client.writeAgent({agentSessionId,expectedRun:session.run,data,source:'terminal-protocol'}).catch(error=>errors.push(String(error))));
        const release=agent.client.onRunEvent(session.run.runId,event=>{if(event.type==='terminal-output')terminal.write(event.dataBytes)},{observeMessages:false});
        terminals.push({terminal,release});
        const attached=await agent.client.reattachAgent(agentSessionId,0,'raw');for(const chunk of attached.attachment.replay)terminal.write(chunk.dataBytes);
        context.before=await helperFacts(agent,resource,context.originalPair);
    }
    let slowReader;
    try {
        await save(name+'-load-before.json',{local:await control(local,'sample-processes',{pids:[local.corePid,local.nativePid]}),remote:await control(remote,'sample-processes',{pids:[remote.corePid,remote.nativePid]})});
        await launch(secondary);
        await until(()=>secondary.waitingAtGate,'Healthy binding baseline completed');
        await launch(primary);
        await until(()=>read(resource,join(scope,'producer-ready')).then(()=>true,()=>false),'Producer ready for isolated slow-reader test',120000);
        assert.equal(await read(agent,collision),sentinels[agent.name]+'\n','Same absolute path on Agent Host changed');
        assert.equal(await read(resource,collision),'RESOURCE_ONLY\n','Resource collision target was not changed');
        const written=await read(resource,largePath);assert.equal(Buffer.byteLength(written),MiB);assert.equal(digest(written),digest(fileBytes));
        slowReader=await control(resource,'start-slow-reader',{runId:primary.originalPair.executor.runId});
        const slowInterval={startedAt:performance.now(),reader:slowReader};
        // First original output bytes must exist before healthy requests are sent.
        slowInterval.observation=await waitForProducerOutput(resource.client,primary.originalPair.executor.runId,until,()=>writeResource(resource,join(scope,'release-producer'),'release'));
        underLoad.resolve();
        await until(()=>primary.completedAt!==undefined&&secondary.completedAt!==undefined,'Both controlled native performance turns complete');
        slowInterval.endedAt=performance.now();
        slowInterval.exit=await control(resource,'stop-slow-reader',{pid:slowReader.pid});slowReader=undefined;
        const evidence=[];
        for(const context of contexts){
            const frontendRanges=await rangedFrames(agent,context.originalPair.frontend.runId),frontend=frontendRanges.map(row=>row.frame),executor=await rangedFrames(resource,context.originalPair.executor.runId);
            await save(name+'-'+context.role+'-performance-frontend.json',frontend);await save(name+'-'+context.role+'-performance-executor.json',executor);
            const starts=frontend.filter(frame=>frame.payload?.method==='process/start');
            for(const step of context.steps.filter(step=>step.code)) {
                const originalStarts=starts.filter(frame=>frame.payload.params.metadata?.toolCallId===step.callId);assert.equal(originalStarts.length,1,'Each original native command starts once');
                assert(executor.some(row=>row.frame.payload?.method==='process/exited'&&row.frame.payload.params.processId===originalStarts[0].payload.params.processId&&row.frame.payload.params.exitCode===0),'An original tool reply alone does not prove native process completion');
            }
            const generations=new Set(frontend.filter(frame=>frame.type==='request').map(frame=>frame.generation));assert.equal(generations.size,1,'Reused calls must retain one helper stream generation');
            const initialize=frontend.filter(frame=>frame.payload?.method==='initialize');assert.equal(initialize.length,1,'No per-tool native service recreation');
            const after=await helperFacts(agent,resource,context.originalPair);sameHelpers(context.before,after);
            const retained=await agent.client.refreshAgentSession(context.session.agentSessionId,context.session.run);assert(retained.nativeHandle?.transcriptPath);
            await until(async()=> (await read(agent,retained.nativeHandle.transcriptPath)).includes('COMPLETE_'+context.marker),'True native completion before idle measurement');
            const outputs=[];
            for(const [label,bytes,char] of [['output-1mib',MiB,'o'],['slow-output',4*MiB,'s']]){
                const step=context.steps.find(step=>step.label===label);if(!step)continue;
                const request=starts.find(frame=>frame.payload.params.metadata?.toolCallId===step.callId);assert(request);
                const notifications=executor.filter(row=>row.frame.payload?.method==='process/output'&&row.frame.payload.params.processId===request.payload.params.processId);
                assert(notifications.length>0);const received=Buffer.concat(notifications.map(row=>Buffer.from(row.frame.payload.params.chunk,'base64')));
                assert.equal(received.length,bytes);assert.equal(digest(received),digest(Buffer.alloc(bytes,char)));
                outputs.push({label,bytes,sha256:digest(received),notifications:notifications.length,nativeProcessId:request.payload.params.processId,toolReplyMs:step.roundtripMs,nativeCompletion:'process/exited:0',deliveryDuration:{state:'unknown',reason:'A native tool reply may yield before completion; complete replay bytes prove delivery, not a measured delivery interval'}});
            }
            if(context===primary)assert(frontend.some(frame=>frame.payload?.method==='fs/writeFile'&&frame.payload.params.path===pathToFileURL(largePath).href),'1MiB transfer must use native fs/writeFile');
            evidence.push({role:context.role,bindingId:context.bindingId,agentSessionId:context.session.agentSessionId,nativeHandle:retained.nativeHandle,helpers:after,generations:[...generations],initializeCount:initialize.length,requestCount:frontend.filter(frame=>frame.type==='request').length,requestDigest:digest(JSON.stringify(frontend)),protocolRequestBytes:frontendRanges.at(-1).endByte,protocolOutputBytes:executor.at(-1).endByte,outputs,coldCreateToFirstResultMs:context.steps[0].completedAt-context.createStartedAt,samples:context.steps.map(({label,index,callId,emittedAt,completedAt,roundtripMs})=>({label,index,callId,emittedAt,completedAt,roundtripMs}))});
        }
        for(const [label,count] of [['reused',6],['baseline',6],['under-load',6]])assert.equal(await read(resource,join(scope,'effects-'+label+'.txt')),Array.from({length:count},(_,i)=>i+'\n').join(''),'Original effects occur exactly once');
        const underSamples=secondary.steps.filter(step=>step.label==='under-load');
        const producerTimes=JSON.parse(await read(resource,join(scope,'producer-times.json')));
        const commandTimes=(await read(resource,join(scope,'command-times.jsonl'))).trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.label==='under-load');
        const concurrencyWindow=nativeConcurrencyWindow(producerTimes,underSamples,commandTimes);
        const overlapSamples=underSamples.filter(step=>concurrencyWindow.overlappingCallIds.includes(step.callId));
        const rootsFor=owner=>[owner.corePid,owner.nativePid,...evidence.flatMap(value=>Object.values(value.helpers).filter(fact=>fact.core.runtimeId===owner.owner.runtimeId).map(fact=>fact.run.pid))].filter(value=>Number.isInteger(value));
        // Include both actual Agent TUI PIDs from their original Run facts.
        const agentPids=[];for(const context of contexts)agentPids.push((await agent.client.readRunReplay(context.session.run,0,'raw')).run.pid);
        const samples=[];
        for(const owner of [local,remote])samples.push({owner:owner.name,roots:[...new Set([...rootsFor(owner),...(owner===agent?agentPids:[])])],before:await control(owner,'sample-processes',{pids:[...new Set([...rootsFor(owner),...(owner===agent?agentPids:[])])]})});
        const idleStart=performance.now();await new Promise(resolve=>setTimeout(resolve,10000));
        for(const sample of samples){const owner=sample.owner==='local'?local:remote;sample.after=await control(owner,'sample-processes',{pids:sample.roots});sample.intervalMs=sample.after.observedAt-sample.before.observedAt;
            const beforeMap=new Map(sample.before.processes.map(proc=>[proc.pid,proc]));assert.deepEqual(sample.after.processes.map(proc=>proc.pid).sort(),sample.before.processes.map(proc=>proc.pid).sort(),'Idle process set changed');
            sample.cpuSeconds=sample.after.processes.reduce((sum,proc)=>sum+proc.cpuSeconds-beforeMap.get(proc.pid).cpuSeconds,0);sample.oneCoreCpuPercent=sample.cpuSeconds/(sample.intervalMs/1000)*100;sample.rssKiB=sample.after.processes.reduce((sum,proc)=>sum+proc.rssKiB,0);
        }
        for(let index=0;index<contexts.length;index++){const context=contexts[index];const list=await frames(agent,context.originalPair.frontend.runId);assert.equal(digest(JSON.stringify(list)),evidence[index].requestDigest,'Idle helper generated new native traffic');sameHelpers(context.before,await helperFacts(agent,resource,context.originalPair));}
        const baseline=stats(secondary.steps.filter(step=>step.label==='baseline').slice(1).map(step=>step.roundtripMs)),under=stats(overlapSamples.map(step=>step.roundtripMs));
        const reused=stats(primary.steps.filter(step=>step.label==='reused').map(step=>step.roundtripMs));
        const fileStep=primary.steps.find(step=>step.label==='file-1mib');
        return {name,qualification:{independentBindings:contexts.length,unchangedHelpers:true,oneInitializationPerBinding:true,exactFileAndOutputBytes:true,healthyRequestsDuringProducer:true,noNewIdleNativeRequests:true,noNewIdleProcesses:true},scope,collision:{requestedAbsolutePath:collision,agentSentinelUnchanged:true,resourceChanged:true},candidateCommit:h.candidateCommit,bindings:evidence,reused,healthyBaseline:baseline,healthyWithStoppedIndependentReader:under,medianLatencyRatio:under.medianMs/baseline.medianMs,concurrencyWindow,slowInterval,idle:{durationMs:performance.now()-idleStart,samples,noNewNativeRequests:true,noNewProcesses:true},file:{nativeMethod:'fs/writeFile',bytes:MiB,sha256:digest(fileBytes),roundtripMs:fileStep.roundtripMs,MiBPerSecond:1/(fileStep.roundtripMs/1000)},fsync:{state:'unknown',reason:'No exact per-binding filesystem syscall observer was attached on either Host'},performanceBudgetVerdict:'unassigned: reported measurements do not establish a latency or throughput SLA',network:{transport:'production SSH between actual two Hosts',syntheticLatency:false,model:'controlled Responses endpoint on Mac with reverse SSH forwarding for Linux'}};
    } finally {
        await save(name+'-performance-timings.json',contexts.map(({role,marker,steps})=>({role,marker,steps:steps.map(({label,callId,emittedAt,completedAt,roundtripMs})=>({label,callId,emittedAt,completedAt,roundtripMs}))})));
        for(const context of contexts) if(context.originalPair) {
            await save(name+'-'+context.role+'-last-pair.json',pair(local,context.bindingId)).catch(()=>{});
            for(const [side,owner] of [['frontend',agent],['executor',resource]]) await frames(owner,context.originalPair[side].runId).then(value=>save(name+'-'+context.role+'-last-'+side+'.json',value)).catch(error=>save(name+'-'+context.role+'-'+side+'-observation-error.json',{error:String(error)}));
        }
        for(const gate of gates)gate.resolve();
        if(slowReader)await control(resource,'stop-slow-reader',{pid:slowReader.pid}).catch(error=>errors.push(String(error)));
        for(const {terminal,release} of terminals){release();terminal.dispose();}
        // Outer owner cleanup retains private evidence and stops only these owned Runs.
    }
}

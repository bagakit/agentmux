import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {creationInputOwner} from '../../../packages/core/test/helpers/creation-input-owner.js'
import {AgentMuxSpatialStateStore,spatialCatalog} from '../../../packages/core/src/spatial-state.js'
import {AgentMuxControlServer} from '../../../packages/core/src/public-rpc-server.js'
import {connectAgentMuxRpc} from '../../../packages/core/src/public-rpc-client.js'
import {MoteDialogueStore} from '../../../packages/core/src/mote-dialogue-store.js'
import {moteMainBaseline,spatialAgentOpenRecord,spatialAgentOpenDocument,pendingMoteMainStarts,retainedMoteMainStarts} from '../../../packages/core/src/spatial-agent-open-contract.js'
import {moteQuickBaseline} from '../../../packages/core/src/mote-preferences.js'
import {agentPromptSubmissionOutcome} from '../../../packages/core/src/agent-input-wait.js'
import {runCompiledObjectCli,objectCliEnvironment} from '../../../packages/core/test/helpers/object-cli-rpc.js'
import {createHostContent} from '../src/content-owner.js'
import {createHostMoteMainReader,createHostMoteDialogue} from '../src/mote-dialogue.js'
import {HostMoteQuickPreferences} from '../src/mote-quick-preferences.js'
import {createHostSpatialAgentControl} from '../src/spatial-agent-control.js'
import {ScratchTopics} from '../src/mote-resources.js'
import {directoryIdentity,homeZoneId,serializeMoteQuickMode} from '../src/mote-model.js'
const closes:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllEnvs()})
import {createMoteConversationStartFixture} from './helpers/mote-conversation-start-fixture.js'
async function fixture(){const f=await createMoteConversationStartFixture();closes.push(f.close);return f}
it('actual Host no-input creation retains and submits one frozen Query only after original binding',async()=>{
 const f=await fixture(),before=(await f.spatial.read())!,query='Original first Query with commitments'
 const opened=await f.start('first-start',query)
 expect(opened.outcome).toBe('opened');expect(f.h.started).toHaveLength(1);const bootstrapWrites=f.h.inner.kernel.input.mock.calls.length;expect(JSON.stringify(f.h.started)).not.toContain(query);expect(JSON.stringify(f.h.inner.kernel.input.mock.calls)).not.toContain(query)
 const retained=spatialAgentOpenRecord((await f.spatial.read())!.graph,'first-start')!;expect(retained.moteMain?.deferredInput?.prompt).toBe(query)
 expect((await f.setup('first-start',false)).deferredInput?.route??null).toBeNull();expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(bootstrapWrites)
 const bound=await f.setup('first-start');expect(bound.binding,bound.issue??'').toBe('confirmed')
 expect(agentPromptSubmissionOutcome(bound.deferredInput?.record),bound.issue??JSON.stringify(bound)).toBe('terminal-confirmed')
 const count=f.h.inner.kernel.input.mock.calls.length;expect(count).toBeGreaterThan(0)
 expect(JSON.stringify(bound.deferredInput?.record)).toContain(query)
 expect(await f.setup('first-start')).toEqual(bound);expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count)
 expect((await f.spatial.read())!.graph.regions).toContainEqual(before.graph.regions[0]);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
 expect(await readFile(f.path,'utf8')).toContain('Keep original cooperation notes.')
},45000)
it('original writer records separate role periods and keeps old unknown history factual',async()=>{
 const f=await fixture();await f.start('period-a');await f.setup('period-a');const a=await f.main.readCurrentMoteMain(f.target)
 await f.start('period-b',undefined,true);const b=await f.setup('period-b');expect(b.binding,b.issue??'').toBe('confirmed')
 const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'})
 const periods=page.links.flatMap(link=>link.kind==='main'&&link.period?[link.period]:[])
 expect(new Set(periods.map(p=>p.id)).size).toBe(2)
 const earlier=periods.find(p=>p.roleRevision===a.roleRevision)!;expect(earlier.startedAt).not.toBeNull();expect(earlier.endedAt).not.toBeNull();expect(earlier.end?.kind).toBe('manual-takeover')
 expect(b.handoverInput?.route?.reference,b.issue??JSON.stringify(b)).toEqual(b.reference)
 expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)
it('compiled CLI consumes actual Host period and setup results without performing a second input',async()=>{
 const f=await fixture();await f.start('cli-start');await f.setup('cli-start')
 const count=f.h.inner.kernel.input.mock.calls.length
 const result=await runCompiledObjectCli(['--endpoint','unix:'+f.server.path,'space','mote','dialogue','read','--input','-'],objectCliEnvironment(f.h.root),JSON.stringify({target:f.target,kind:'main'}),45000)
 expect(result.code,result.stderr).toBe(0);const page=JSON.parse(result.stdout).result
 expect(page.links.some((link:any)=>link.period?.startedAt!==null&&link.period?.roleRevision===page.main.roleRevision)).toBe(true)
 expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('a fresh Host owner recovers the original frozen start and input key from durable admissions',async()=>{
 const f=await fixture(),query='Frozen Query survives losing the old component and server'
 await f.start('durable-start',query);const before=(await f.spatial.read())!
 await f.rpc.dispose();await f.server.stop()
 const spatial=new AgentMuxSpatialStateStore(f.spatial.path)
 const content=createHostContent({configurationPath:join(f.h.root,'configuration.json'),spatial}),main=createHostMoteMainReader({configurationPath:join(f.h.root,'configuration.json'),spatial,files:content.files!}),store=new MoteDialogueStore(f.store.path)
 const dialogue=createHostMoteDialogue({main,spatial,store,clientForHost:()=>f.h.client}),quick=new HostMoteQuickPreferences({main,files:content.files!,prepareMainSource:dialogue.prepareMainSource,recordMainSource:dialogue.recordMainSource,catalog:async()=>spatialCatalog((await spatial.read())!.graph),executors:async()=>[{id:'saved',name:'Saved',providerId:'codex'}]})
 const server=new AgentMuxControlServer({socketPath:join(f.h.root,'fresh-start.sock'),...f.options,spatialState:spatial,moteDialogue:dialogue,moteQuickPreferences:quick});await server.start();closes.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});closes.push(()=>rpc.dispose())
 const state=(await rpc.call('space.state',{})).state!,original=spatialAgentOpenRecord(state.graph,'durable-start')!
 expect(original.moteMain?.deferredInput?.prompt).toBe(query)
 const request={target:f.target,creation:{hostId:'local',operationId:'durable-start'}}
 const result=await rpc.call('space.mote.dialogue.setup.advance',request)
 expect(agentPromptSubmissionOutcome(result.deferredInput?.record),result.issue??'').toBe('terminal-confirmed')
 const count=f.h.inner.kernel.input.mock.calls.length
 const inspected=await rpc.call('space.mote.dialogue.setup.inspect',request)
 expect(inspected.deferredInput?.route?.key).toEqual(result.deferredInput?.route?.key)
 await rpc.call('space.mote.dialogue.setup.advance',request);expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count)
 expect(f.h.started).toHaveLength(1);expect((await spatial.read())!.graph.regions).toContainEqual(before.graph.regions[0]);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('a saved CAS with an unavailable source journal keeps healthy input and reconciles only the original source',async()=>{
 const f=await fixture();await f.start('partial-source','Query remains usable despite optional history failure')
 const fail=vi.spyOn(f.store,'confirmTransition').mockRejectedValue(Error('Original journal fsync ACK unavailable'))
 const first=await f.setup('partial-source')
 expect(first.binding).toBe('confirmed');expect(agentPromptSubmissionOutcome(first.deferredInput?.record)).toBe('terminal-confirmed');expect(first.issue).toContain('unconfirmed')
 const count=f.h.inner.kernel.input.mock.calls.length,graph=(await f.spatial.read())!
 const unknown=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'})
 expect(unknown.main.current).toEqual(first.reference);expect(unknown.sourceStatus).toBe('unconfirmed')
 fail.mockRestore()
 const inspected=await f.setup('partial-source',false);expect(inspected.binding).toBe('confirmed');expect((await f.spatial.read())!.revision).toBe(graph.revision)
 const fixed=await f.setup('partial-source'),page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'})
 expect(fixed.binding).toBe('confirmed');expect(page.sourceStatus).toBe('read');expect(page.links.some(l=>l.kind==='main'&&l.period?.startedAt!==null)).toBe(true)
 expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count);expect(f.h.started).toHaveLength(1);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('A to B to the same A Session keeps three role identities and an honest reused-source gap',async()=>{
 const f=await fixture();await f.start('same-a');const a=await f.setup('same-a');await f.start('same-b');await f.setup('same-b')
 const saved=await f.quick.read({kind:'quick',target:f.target}),baseline=moteQuickBaseline(saved)!
 const reference=a.reference!
 const changed=await f.rpc.call('space.mote.preferences.save',{kind:'quick',target:f.target,operationId:'same-a-again',baseline,values:{...baseline.defaults,conversation:reference},destination:{kind:'occurrence',displayWorkspaceId:reference.displayWorkspaceId,groupId:reference.groupId,tabId:reference.tabId,regionId:reference.regionId}})
 expect(changed.status,changed.message??'').toBe('saved')
 const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'}),periods=page.links.flatMap(link=>link.kind==='main'&&link.period?[link.period]:[])
 expect(new Set(periods.map(p=>p.id)).size).toBe(3)
 const returned=periods.find(p=>p.roleRevision===page.main.roleRevision)!
 expect(returned.reference.sessionId).toBe(reference.sessionId);expect(returned.range.kind).toBe('unconfirmed')
 expect(periods.filter(p=>p.reference.sessionId===reference.sessionId).map(p=>p.roleRevision)).toContain(a.bindingReceipt!.source!.defaults.conversationRevision)
 expect(f.h.started).toHaveLength(2);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('a known refused binding is retained for review and stops blocking a new explicit start',async()=>{
 const f=await fixture();await f.start('refused-start','Retained refused Query')
 const saved=await f.quick.read({kind:'quick',target:f.target}),baseline=moteQuickBaseline(saved)!
 await f.quick.save({kind:'quick',target:f.target,operationId:'changed-before-bind',baseline,values:{...baseline.defaults,presence:{enabled:false,intervalMs:60000}},destination:{kind:'occurrence',displayWorkspaceId:'__scratch__',groupId:'group',tabId:'old-tab',regionId:'old-region'}})
 const refused=await f.setup('refused-start');expect(refused.binding).toBe('refused')
 const graph=(await f.spatial.read())!.graph
 expect(pendingMoteMainStarts(graph,f.target)).toEqual([])
 expect(retainedMoteMainStarts(graph,f.target).map(r=>r.moteMain?.deferredInput?.prompt)).toContain('Retained refused Query')
 expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)


it('actual native human input idle produces a lazy rollover decision through the same public owner',async()=>{
 const f=await createMoteConversationStartFixture({providerId:'claude'});closes.push(f.close)
 await f.start('idle-start','First human Query before native idle');const started=await f.setup('idle-start')
 expect(agentPromptSubmissionOutcome(started.deferredInput?.record),started.issue??'').toBe('terminal-confirmed')
 const idle=await f.qualifyMainIdle(1),main=idle.snapshot,reference=main.current!,session=idle.session!
 const before=f.h.inner.kernel.input.mock.calls.length
 const input={agentSessionId:reference.sessionId,operationId:'next_idle_query',prompt:'The new explicit Query',expectedRun:session.run,admissionIntent:{kind:'manual-actor' as const},execution:'immediate' as const}
 const due=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input})
 expect(due.disposition,JSON.stringify(due)).toBe('rollover-required');expect(due.route).toBeNull();expect(due.rollover?.decision?.activity.inputKey.submissionId).toBe('idle-start_query')
 expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(before)
 const second=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input})
 expect(second.rollover?.decision?.creationOperationId).toBe(due.rollover?.decision?.creationOperationId)
 expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('lazy rollover freezes one exact Query, preserves older input and records the automatic cause',async()=>{
 const f=await createMoteConversationStartFixture({providerId:'claude'});closes.push(f.close)
 await f.start('automatic_old','Original human input');const old=await f.setup('automatic_old')
 const idle=await f.qualifyMainIdle(1),main=idle.snapshot,reference=main.current!,session=idle.session!
 const originalIdle=old.deferredInput!.route!.key
 const firstIdle=(await f.rpc.call('agent.input.inspect',{key:originalIdle,activity:true})).record!.semanticIdle!
 // A non-human platform turn gets its own original input and native end. It cannot renew the human clock.
 await f.h.client.submitAgentPrompt({agentSessionId:reference.sessionId,operationId:'platform_heartbeat',prompt:'Original platform maintenance',expectedRun:session.run,admissionIntent:{kind:'manual-actor'},execution:'immediate',authorHuman:false})
 await expect.poll(async()=> (await f.h.client.inspectAgentInput({key:{kind:'prompt',agentSessionId:reference.sessionId,expectedRun:session.run,submissionId:'platform_heartbeat'}}))?.status).toBe('terminal-confirmed')
 await idle.hook('turn.start',3,'platform-heartbeat-turn');await idle.hook('turn.complete',4,'platform-heartbeat-turn')
 expect((await f.rpc.call('agent.input.inspect',{key:originalIdle})).record!.semanticIdle!.observedAt).toBe(firstIdle.observedAt)
 const input={agentSessionId:reference.sessionId,operationId:'automatic_next_query',prompt:'Frozen new Query',expectedRun:session.run,admissionIntent:{kind:'manual-actor' as const},execution:'immediate' as const}
 const activityBeforeDue=await f.rpc.call('agent.input.inspect',{key:originalIdle,activity:true});expect(activityBeforeDue.activity?.state,JSON.stringify(activityBeforeDue)).toBe('idle')
 const due=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input})
 expect(due.disposition,JSON.stringify(due)).toBe('rollover-required');expect(due.rollover!.decision!.activity.idleSince).toBe(firstIdle.observedAt)
 const decision=due.rollover!.decision!,preferences=await f.rpc.call('space.mote.preferences.read',{kind:'quick',target:f.target}),baseline=moteMainBaseline(moteQuickBaseline(preferences)!)
 const opened=await f.rpc.call('agent.open',{operationId:decision.creationOperationId,content:{kind:'new-agent',executorId:'saved'},destination:{spaceId:f.target.spaceId,zoneId:f.target.zoneId,newTab:true},focus:false,moteMain:{target:f.target,baseline,expectedRoleRevision:main.roleRevision,sourceOperationId:decision.creationOperationId+':source',bindOperationId:decision.creationOperationId+':bind',rollover:decision,deferredInput:{operationId:input.operationId,prompt:input.prompt}}})
 expect(opened.outcome).toBe('opened')
 const next=await f.setup(decision.creationOperationId);expect(next.binding,next.issue??'').toBe('confirmed');expect(next.deferredInput!.route!.key.submissionId).toBe(input.operationId)
 expect(next.deferredInput!.route!.key.agentSessionId).not.toBe(reference.sessionId)
 const count=f.h.inner.kernel.input.mock.calls.length
 const retained=await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:'automatic_old_query'})
 expect(retained.route).toEqual(old.deferredInput!.route);expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count)
 const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'}),periods=page.links.flatMap(l=>l.kind==='main'&&l.period?[l.period]:[])
 expect(periods.find(p=>p.roleRevision===main.roleRevision)?.end).toMatchObject({kind:'automatic',decision:{queryOperationId:input.operationId}})
 expect(f.h.inner.kernel.stop).not.toHaveBeenCalled();expect(f.h.started).toHaveLength(2)
},45000)

it('changed policy refuses only a stale automatic creation and keeps the original healthy Main',async()=>{
 const f=await createMoteConversationStartFixture({providerId:'claude'});closes.push(f.close)
 await f.start('stale_start','Original human Query');await f.setup('stale_start');const {snapshot,session}=await f.qualifyMainIdle(1)
 const input={agentSessionId:snapshot.current!.sessionId,operationId:'stale_next_query',prompt:'Retained Query',expectedRun:session!.run,admissionIntent:{kind:'manual-actor' as const},execution:'immediate' as const}
 const due=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:snapshot.roleRevision!,input});const decision=due.rollover!.decision!
 const before=await f.quick.read({kind:'quick',target:f.target}),baseline=moteQuickBaseline(before)!,ref=snapshot.current!
 await f.rpc.call('space.mote.preferences.save',{kind:'quick',target:f.target,operationId:'keep_current_policy',baseline,values:{...baseline.defaults,conversationRollover:{kind:'keep-current'}},destination:{kind:'occurrence',displayWorkspaceId:ref.displayWorkspaceId,groupId:ref.groupId,tabId:ref.tabId,regionId:ref.regionId}})
 const current=await f.quick.read({kind:'quick',target:f.target})
 const rejected=await f.rpc.call('agent.open',{operationId:decision.creationOperationId,content:{kind:'new-agent',executorId:'saved'},destination:{spaceId:f.target.spaceId,zoneId:f.target.zoneId,newTab:true},focus:false,moteMain:{target:f.target,baseline:moteMainBaseline(moteQuickBaseline(current)!),expectedRoleRevision:snapshot.roleRevision,sourceOperationId:'stale-source',bindOperationId:'stale-bind',rollover:decision,deferredInput:{operationId:input.operationId,prompt:input.prompt}}}).then(()=>null,error=>error);expect(rejected).toMatchObject({code:'MOTE_MAIN_CHANGED'})
 expect(f.h.started).toHaveLength(1);expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(ref);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
 const available=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:snapshot.roleRevision!,input})
 expect(available.rollover?.status).toBe('keep-current');expect(available.route?.reference).toEqual(ref)
},45000)

it('unknown activity preserves the exact healthy input instead of manufacturing expiry',async()=>{
 const f=await createMoteConversationStartFixture({providerId:'claude'});closes.push(f.close)
 await f.start('unknown_activity','Original human Query');await f.setup('unknown_activity');const {snapshot,session}=await f.qualifyMainIdle(1)
 vi.spyOn(f.h.client,'readAgentInputActivity').mockResolvedValue({key:{kind:'prompt',agentSessionId:snapshot.current!.sessionId,expectedRun:session!.run,submissionId:'unknown_activity_query'},state:'unconfirmed',source:'unconfirmed',sourceId:null,sourceNow:Date.now(),issue:'Native source temporarily unreadable'})
 const available=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:snapshot.roleRevision!,input:{agentSessionId:snapshot.current!.sessionId,operationId:'healthy_unknown_query',prompt:'Existing ability is healthy',expectedRun:session!.run,admissionIntent:{kind:'manual-actor'},execution:'immediate'}})
 expect(available.rollover?.status).toBe('unconfirmed');expect(available.route?.reference).toEqual(snapshot.current);expect(agentPromptSubmissionOutcome(available.record)).toBe('terminal-confirmed');expect(f.h.started).toHaveLength(1);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('original native-status end retains per-input idle across later platform turns and public activity reads',async()=>{
 const {nativeTurnEndFixture}=await import('../../../packages/core/test/fixtures/native-turn-end.js')
 const h=await nativeTurnEndFixture();closes.push(h.close)
 const run={runId:'run-recipient'},key={kind:'prompt' as const,agentSessionId:'recipient',expectedRun:run,submissionId:'native_human'}
 const plan={kind:'native-rpc' as const,protocolId:'fixture-original-protocol',operation:'start-or-steer' as const,sourceId:'original-source',actorId:'original-peer',threadId:'native-original'}
 const admission=(id:string,turnId:string,authorHuman:boolean)=>({operationId:id,submissionId:id,transport:'native' as const,acknowledged:true,native:{plan,outcome:'admitted' as const,turnId},inputKey:{...key,submissionId:id},intent:{run,ownerInstanceId:'original-runtime',prompt:'Original source '+id,plan,execution:'immediate' as const,message:{userContent:'Original source '+id,authorHuman}}})
 await h.change(s=>({...s,promptCompletionAdmission:admission('native_human','native-human-turn',true)}))
 await h.observe({state:'done',recordId:'human-end-record',nativeTurnId:'native-human-turn',sequence:2})
 const server=new AgentMuxControlServer({socketPath:join(h.root,'native-source.sock'),coreClients:h.coreClients});await server.start();closes.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});closes.push(()=>rpc.dispose())
 const first=await rpc.call('agent.input.inspect',{key})
 expect(first.record?.semanticIdle).toMatchObject({source:'native-status',recordId:'human-end-record',sequence:2,promptSubmissionId:'native_human'})
 await h.change(s=>({...s,promptCompletionAdmission:admission('native_platform','native-platform-turn',false)}))
 await h.observe({state:'done',recordId:'platform-end-record',nativeTurnId:'native-platform-turn',sequence:4})
 expect((await rpc.call('agent.input.inspect',{key})).record?.semanticIdle).toEqual(first.record!.semanticIdle)
 h.provider.readPromptExecutionEvidence=async()=>({id:'exact-native-working',nativeTurnId:'native-next-turn',state:'working'})
 expect((await rpc.call('agent.input.inspect',{key,activity:true})).activity).toMatchObject({state:'active',source:'native-provider',sourceId:'exact-native-working'})
 h.provider.readPromptExecutionEvidence=async()=>({id:'exact-native-end',nativeTurnId:'native-next-turn',state:'ended',endReason:'completed'})
 expect((await rpc.call('agent.input.inspect',{key,activity:true})).activity).toMatchObject({state:'idle',source:'native-provider',sourceId:'exact-native-end'})
 h.provider.readPromptExecutionEvidence=async()=>{throw Error('Original source unavailable')}
 expect((await rpc.call('agent.input.inspect',{key,activity:true})).activity?.state).toBe('unconfirmed')
 expect(await h.client.readAgentSession('recipient')).toMatchObject({agentSessionId:'recipient',run});expect(h.inner.kernel.input).not.toHaveBeenCalled();expect(h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('independent input-journal cuts exclude an old Query captured late and a new Query beyond the upper bound',async()=>{
 const f=await fixture();await f.start('input_cut_start');await f.setup('input_cut_start')
 const main=await f.main.readCurrentMoteMain(f.target),reference=main.current!,session=(await f.h.client.readAgentSession(reference.sessionId))!
 const submit=(operationId:string,prompt:string)=>f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input:{agentSessionId:reference.sessionId,operationId,prompt,expectedRun:session.run,admissionIntent:{kind:'manual-actor'},execution:'immediate'}})
 const projection=vi.spyOn(f.h.client as any,'writeInputConversation').mockRejectedValue(Error('Temporary capture failure; original input journal remains'))
 await submit('input_cut_old','OLD_INPUT_BORN_BEFORE_RANGE')
 const lower=(await f.rpc.call('agent.conversation.checkpoint',{hostId:'local',agentSessionId:reference.sessionId})).checkpoint
 const capturedBefore=await f.h.store.readCapturedHistory(reference.sessionId,{})
 expect(JSON.stringify(capturedBefore)).not.toContain('OLD_INPUT_BORN_BEFORE_RANGE')
 projection.mockRestore()
 await submit('input_cut_inside','INSIDE_INPUT_BORN_IN_RANGE')
 const upper=(await f.rpc.call('agent.conversation.checkpoint',{hostId:'local',agentSessionId:reference.sessionId})).checkpoint
 await submit('input_cut_after','NEW_INPUT_BORN_AFTER_RANGE')
 let checkpoint=lower,cursor:string|undefined,contents=''
 for(let frame=0;frame<20;frame++){
  const page=await f.rpc.call('agent.conversation.changes',{hostId:'local',agentSessionId:reference.sessionId,checkpoint,through:upper,...(cursor?{cursor}:{}),limit:20})
  contents+=JSON.stringify(page.items)
  if(page.nextCursor){cursor=page.nextCursor;continue}
  cursor=undefined;checkpoint=page.checkpoint;if(!page.more)break
  if(frame===19)throw Error('Actual bounded input reader did not finish')
 }
 expect(contents).toContain('INSIDE_INPUT_BORN_IN_RANGE');expect(contents).not.toContain('OLD_INPUT_BORN_BEFORE_RANGE');expect(contents).not.toContain('NEW_INPUT_BORN_AFTER_RANGE')
 expect(JSON.stringify(upper.frontier)).toContain('inputJournal');expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

it('another Mote reusing a bind operation and SID cannot lend its creation-qualified source',async()=>{
 const f=await fixture(),workspace={id:f.target.expectedResource.workspaceId,hostId:'local',path:f.target.expectedResource.workspacePath,name:'Original'}
 const topic=await new ScratchTopics().ensureMote(workspace,'launcher:foreign-provenance'),spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId)
 await writeFile(join(topic.physicalDirectoryPath!,'MOTE.md'),serializeMoteQuickMode('',{executorId:'saved'})+'\nKeep original cooperation notes.\n')
 const initial=(await f.spatial.read())!,graph=structuredClone(initial.graph)
 graph.spaces.push({spaceId,kind:'mote',topicId:topic.id,name:'Foreign',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null})
 graph.zones.push({zoneId,kind:'home',workspaceId:workspace.id,hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null});graph.bindings.push({spaceId,zoneId})
 await f.spatial.commit({expectedRevision:initial.revision,graph})
 const target={spaceId,zoneId,expectedResource:f.target.expectedResource},preferences=await f.rpc.call('space.mote.preferences.read',{kind:'quick',target}),main=(await f.rpc.call('space.mote.dialogue.read',{target})).main
 await f.rpc.call('agent.open',{operationId:'foreign_created',content:{kind:'new-agent',executorId:'saved'},destination:{spaceId,zoneId,newTab:true},focus:false,moteMain:{target,baseline:moteMainBaseline(moteQuickBaseline(preferences)!),expectedRoleRevision:main.roleRevision,sourceOperationId:'foreign_source',bindOperationId:'reused_bind_operation'}})
 const foreign=await f.rpc.call('space.mote.dialogue.setup.advance',{target,creation:{hostId:'local',operationId:'foreign_created'}})
 expect(foreign.binding,foreign.issue??'').toBe('confirmed')
 // An allowed second spatial occurrence keeps the same real original Host/SID, in this Mote's workface.
 const current=(await f.spatial.read())!,projection=structuredClone(current.graph),session=(await f.h.client.readAgentSession(foreign.reference!.sessionId))!
 const region=projection.regions.find(r=>r.regionId==='old-region')!
 Object.assign(region,{agentSessionId:session.agentSessionId,runId:session.run.runId,execution:{hostId:'local',cwd:session.workspacePath}})
 await f.spatial.commit({expectedRevision:current.revision,graph:projection})
 const reference={...foreign.reference!,tabId:'old-tab',regionId:'old-region',groupId:'group',displayWorkspaceId:workspace.id},baseline=moteQuickBaseline(await f.quick.read({kind:'quick',target:f.target}))!
 const selected=await f.rpc.call('space.mote.preferences.save',{kind:'quick',target:f.target,operationId:'reused_bind_operation',baseline,values:{...baseline.defaults,conversation:reference},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId:'group',tabId:'old-tab',regionId:'old-region'}})
 expect(selected.status,selected.message??'').toBe('saved')
 const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'}),selectedMain=page.links.find(link=>link.kind==='main'&&link.roleRevision===page.main.roleRevision)
 expect(selectedMain?.kind==='main'&&selectedMain.period?.range.kind).toBe('unconfirmed')
 expect(page.main.current).toEqual(reference);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
},45000)

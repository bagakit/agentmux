import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {creationInputOwner} from '../../../../packages/core/test/helpers/creation-input-owner.js'
import {AgentMuxSpatialStateStore,spatialCatalog} from '../../../../packages/core/src/spatial-state.js'
import {AgentMuxControlServer} from '../../../../packages/core/src/public-rpc-server.js'
import {connectAgentMuxRpc} from '../../../../packages/core/src/public-rpc-client.js'
import {MoteDialogueStore} from '../../../../packages/core/src/mote-dialogue-store.js'
import {moteMainBaseline,spatialAgentOpenRecord} from '../../../../packages/core/src/spatial-agent-open-contract.js'
import {moteQuickBaseline} from '../../../../packages/core/src/mote-preferences.js'
import {agentPromptSubmissionOutcome} from '../../../../packages/core/src/agent-input-wait.js'
import {runCompiledObjectCli,objectCliEnvironment} from '../../../../packages/core/test/helpers/object-cli-rpc.js'
import {createHostContent} from '../../src/content-owner.js'
import {createHostMoteMainReader,createHostMoteDialogue} from '../../src/mote-dialogue.js'
import {HostMoteQuickPreferences} from '../../src/mote-quick-preferences.js'
import {createHostSpatialAgentControl} from '../../src/spatial-agent-control.js'
import {ScratchTopics,readConfiguredExecutorChoices} from '../../src/mote-resources.js'
import {directoryIdentity,homeZoneId,serializeMoteQuickMode} from '../../src/mote-model.js'
import {fixtureHostExecutorOptions} from './configured-executor-owner.js'
export async function createMoteConversationStartFixture(input:{providerId?:'codex'|'claude'|'grok';extraClients?:import('../../../../packages/core/src/public-rpc-service.js').AgentMuxRpcCoreClient[]}={}){
 const closes:Array<()=>unknown|Promise<unknown>>=[]
 let configurationPath=''
 const h=await creationInputOwner(true,fixtureHostExecutorOptions(()=>configurationPath));closes.push(h.close)
 const providerId=input.providerId??'codex'
 if(providerId==='grok'){
  const provider=h.client.providers.get('grok')
  h.probe.mockResolvedValue({providerId:'grok',executable:'grok',installed:true,capabilities:provider.catalog.capabilities})
 }
 if(providerId==='claude'){
  const provider=h.client.providers.get('claude')
  // This Runtime port models the supported current-terminal launch, with a native
  // process witness/Hook but no independent native socket. Do not advertise a
  // machine channel that its synthetic PID does not implement.
  const {prepareNativeInput:_nativeInput,...terminalProvider}=provider
  const {nativeConversationInput:_nativeInputCatalog,asyncQuestionReply:_nativeQuestionCatalog,...terminalCapabilities}=provider.catalog.capabilities
  // This deterministic Runtime must supply the same original process witness
  // that native Hook and conversation consumers now qualify through the Provider.
  const runtimeStatus=h.inner.kernel.status
  h.inner.kernel.status=vi.fn(async(runId:string)=>({...await runtimeStatus(runId),pid:20000+Number(runId.replace('fixture-run-',''))}))
  const discoverNativeSession:NonNullable<typeof provider.discoverNativeSession>=async context=>{
   const session=h.client.agentSessions().find(value=>20000+Number(value.run.runId.replace('fixture-run-',''))===context.processId)
   if(!session||session.workspacePath!==context.workspacePath)return null
   return {handle:{kind:'provider',providerId:'claude',sessionId:'native-'+session.agentSessionId},assertCurrent:async()=>{
    const run=await h.inner.kernel.status(session.run.runId)
    expect(run.pid).toBe(context.processId);expect(run.state.type).toBe('running')
   }}
  }
  h.client.providers.replace({...terminalProvider,discoverNativeSession,catalog:{...provider.catalog,capabilities:terminalCapabilities,promptDelivery:'post-launch-only'},prepareManagedLaunch:async(plan:any)=>({plan}),planPromptInput:(prompt:string)=>({kind:'single-phase',data:prompt+'\r'}),readPromptExecutionEvidence:async()=>({state:'idle',id:'fixture-execution-idle',sourceId:'fixture-native-execution'}),verifyPromptExecutionTransport:async()=>true})
  h.probe.mockResolvedValue({providerId:'claude',executable:'claude',installed:true,capabilities:provider.catalog.capabilities})
 }
 const workspace={id:'__scratch__',hostId:'local',path:join(h.root,'scratch'),name:'Original'};await mkdir(workspace.path)
 const topic=await new ScratchTopics().ensureMote(workspace,'launcher:start-fixture'),spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId),path=join(topic.physicalDirectoryPath!,'MOTE.md')
 await writeFile(path,serializeMoteQuickMode('',{executorId:'saved'})+'\nKeep original cooperation notes.\n')
 const graph={spaces:[{spaceId,kind:'mote' as const,topicId:topic.id,name:'Original Mote',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null}],zones:[{zoneId,kind:'home' as const,workspaceId:workspace.id,hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[{tabId:'old-tab',zoneId,workspaceId:workspace.id,name:null,regionIds:['old-region']}],regions:[{tabId:'old-tab',regionId:'old-region',kind:'agent' as const,agentSessionId:'source',runId:'run-source',execution:{hostId:'local',cwd:h.root}}],layouts:{__scratch__:{groups:[{id:'group',tabOrder:['old-tab'],activeTabId:'old-tab',recentTabIds:[]}],activeGroupId:'group',root:{type:'leaf' as const,groupId:'group'}}},tabLayouts:{'old-tab':{root:{type:'leaf' as const,regionId:'old-region'},activeRegionId:'old-region'}},resources:{'tab:old-tab':{draft:'original draft'}}}
 const spatial=new AgentMuxSpatialStateStore(join(h.root,'spatial.json'));await spatial.commit({expectedRevision:0,graph})
 configurationPath=join(h.root,'configuration.json');await writeFile(configurationPath,JSON.stringify({workspaces:[workspace],executors:{saved:{label:'Saved',providerId,command:providerId,args:[],env:{},injectAgentMuxGuide:false}}}))
 const content=createHostContent({configurationPath,spatial}),main=createHostMoteMainReader({configurationPath,spatial,files:content.files!}),store=new MoteDialogueStore(join(h.root,'dialogue.sqlite'))
 const dialogue=createHostMoteDialogue({main,spatial,store,clientForHost:()=>h.client})
 const quickPorts={main,files:content.files!,prepareMainSource:dialogue.prepareMainSource,recordMainSource:dialogue.recordMainSource,catalog:async()=>spatialCatalog((await spatial.read())!.graph),executors:()=>readConfiguredExecutorChoices(configurationPath)}
 const quick=new HostMoteQuickPreferences(quickPorts)
 const createSpatial=createHostSpatialAgentControl({configurationPath,spatial,runtime:()=>({client:h.client}) as never})
 const startedNativeRuns=new Set<string>()
 const creator:typeof createSpatial=async(request,context)=>{
  const result=await createSpatial(request,context)
  if(providerId==='claude'&&result?.operation==='agent.open'&&result.agent){
   const session=await h.client.readAgentSession(result.agent.agentSessionId)
   if(session&&!startedNativeRuns.has(session.run.runId)){
    startedNativeRuns.add(session.run.runId)
    // The deterministic launch port has completed. Publish this original Run's
    // native start before its first Query; later idle Hooks cannot stand in for it.
    await h.inner.acceptHookEvent({agentSessionId:session.agentSessionId,providerId:'claude',runId:session.run.runId,
     receiptId:'mote-start-'+session.run.runId,eventName:'SessionStart',payload:{hook_event_name:'SessionStart',source:'startup',
      session_id:'native-'+session.agentSessionId,cwd:session.workspacePath,sourceId:'mote-native-'+session.agentSessionId,sequence:0}},AbortSignal.timeout(5000))
   }
  }
  return result
 }
 const options={coreClients:()=>[...h.coreClients(),...(input.extraClients??[])],spatialState:spatial,spatialAgentControl:creator,moteDialogue:dialogue,moteQuickPreferences:quick}
 const server=new AgentMuxControlServer({socketPath:join(h.root,'main-start.sock'),...options});await server.start();closes.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});closes.push(()=>rpc.dispose())
 const target={spaceId,zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:workspace.path}}
 const start=async(operationId:string,prompt?:string,handover=false)=>{
  const preferences=await rpc.call('space.mote.preferences.read',{kind:'quick',target}),baseline=moteQuickBaseline(preferences),source=await rpc.call('space.mote.dialogue.read',{target})
  if(!baseline)throw Error('Actual original MOTE baseline missing: '+JSON.stringify(preferences))
  return await rpc.call('agent.open',{operationId,content:{kind:'new-agent',executorId:'saved'},destination:{spaceId,zoneId,newTab:true},focus:false,moteMain:{target,baseline:moteMainBaseline(baseline),expectedRoleRevision:source.main.roleRevision,sourceOperationId:operationId+':source',bindOperationId:operationId+':bind',...(prompt?{deferredInput:{operationId:operationId+'_query',prompt}}:{}),...(handover?{handover:true as const}:{})}})
 }
 const qualifyMainIdle=async(idleMs=1)=>{
  if(providerId!=='claude')throw Error('This fixture uses the real Claude native activity protocol; choose providerId:claude')
  const snapshot=await main.readCurrentMoteMain(target),reference=snapshot.current!
  const session=(await h.client.readAgentSession(reference.sessionId))!,nativeSessionId=session.nativeHandle?.kind==='provider'?session.nativeHandle.sessionId:'native-'+reference.sessionId
  const hook=async(eventName:string,sequence:number,turnId='main-human-'+reference.sessionId)=>await h.inner.acceptHookEvent({agentSessionId:reference.sessionId,providerId:'claude',runId:session.run.runId,receiptId:'mote-idle-'+sequence+'-'+reference.sessionId,eventName,payload:{hook_event_name:eventName,session_id:nativeSessionId,sourceId:'mote-native-'+reference.sessionId,sequence,turnId,...(eventName==='turn.complete'?{reason:'answer',isAborted:false,backgroundWork:'none'}:{})}},AbortSignal.timeout(5000))
  await hook('turn.start',1);await hook('turn.complete',2)
  const preferences=await quick.read({kind:'quick',target}),baseline=moteQuickBaseline(preferences)!
  const saved=await rpc.call('space.mote.preferences.save',{kind:'quick',target,operationId:'idle-policy-'+reference.sessionId,baseline,values:{...baseline.defaults,conversationRollover:{kind:'idle',idleMs}},destination:{kind:'occurrence',displayWorkspaceId:reference.displayWorkspaceId,groupId:reference.groupId,tabId:reference.tabId,regionId:reference.regionId}})
  if(saved.status!=='saved')throw Error(saved.message??'Original policy CAS missing')
  await new Promise(done=>setTimeout(done,Math.max(2,idleMs)))
  return {snapshot:await main.readCurrentMoteMain(target),session:await h.client.readAgentSession(reference.sessionId),hook}
 }
 const setup=(operationId:string,advance=true)=>rpc.call(advance?'space.mote.dialogue.setup.advance':'space.mote.dialogue.setup.inspect',{target,creation:{hostId:'local',operationId}})
 const settledSetup=async(operationId:string,advance=true)=>{
  let result=await setup(operationId,advance)
  // The real controlled input returns its durable receipt before its worker
  // settles. Await that original worker in positive protocol fixtures only;
  // a genuine initialization wait or unknown receipt is returned unchanged.
  if(advance&&providerId==='claude')await vi.waitFor(async()=>{
   const inFlight=[result.deferredInput,result.handoverInput].some(value=>value?.input?.status==='waiting'&&!value.input.control.waiting)
   if(!inFlight)return
   result=await rpc.call('space.mote.dialogue.setup.inspect',{target,creation:{hostId:'local',operationId}})
   expect([result.deferredInput,result.handoverInput].some(value=>value?.input?.status==='waiting'&&!value.input.control.waiting)).toBe(false)
  },{timeout:5000})
  return result
 }
 return {h,spatial,store,main,dialogue,quick,quickPorts,options,server,rpc,target,path,start,setup,settledSetup,qualifyMainIdle,close:async()=>{for(const close of closes.splice(0).reverse())await close()}}
}

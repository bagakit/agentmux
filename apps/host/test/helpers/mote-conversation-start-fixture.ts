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
import {ScratchTopics} from '../../src/mote-resources.js'
import {directoryIdentity,homeZoneId,serializeMoteQuickMode} from '../../src/mote-model.js'
export async function createMoteConversationStartFixture(input:{providerId?:'codex'|'claude';extraClients?:import('../../../../packages/core/src/public-rpc-service.js').AgentMuxRpcCoreClient[]}={}){
 const closes:Array<()=>unknown|Promise<unknown>>=[]
 const h=await creationInputOwner(true);closes.push(h.close)
 const providerId=input.providerId??'codex'
 if(providerId==='claude'){
  const provider=h.client.providers.get('claude')
  h.client.providers.replace({...provider,catalog:{...provider.catalog,promptDelivery:'post-launch-only'},prepareManagedLaunch:async(plan:any)=>({plan}),planPromptInput:(prompt:string)=>({kind:'single-phase',data:prompt+'\r'}),readPromptExecutionEvidence:async()=>({state:'idle',id:'fixture-execution-idle',sourceId:'fixture-native-execution'}),verifyPromptExecutionTransport:async()=>true})
  h.probe.mockResolvedValue({providerId:'claude',executable:'claude',installed:true,capabilities:provider.catalog.capabilities})
 }
 const workspace={id:'__scratch__',hostId:'local',path:join(h.root,'scratch'),name:'Original'};await mkdir(workspace.path)
 const topic=await new ScratchTopics().ensureMote(workspace,'launcher:start-fixture'),spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId),path=join(topic.physicalDirectoryPath!,'MOTE.md')
 await writeFile(path,serializeMoteQuickMode('',{executorId:'saved'})+'\nKeep original cooperation notes.\n')
 const graph={spaces:[{spaceId,kind:'mote' as const,topicId:topic.id,name:'Original Mote',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null}],zones:[{zoneId,kind:'home' as const,workspaceId:workspace.id,hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[{tabId:'old-tab',zoneId,workspaceId:workspace.id,name:null,regionIds:['old-region']}],regions:[{tabId:'old-tab',regionId:'old-region',kind:'agent' as const,agentSessionId:'source',runId:'run-source',execution:{hostId:'local',cwd:h.root}}],layouts:{__scratch__:{groups:[{id:'group',tabOrder:['old-tab'],activeTabId:'old-tab',recentTabIds:[]}],activeGroupId:'group',root:{type:'leaf' as const,groupId:'group'}}},tabLayouts:{'old-tab':{root:{type:'leaf' as const,regionId:'old-region'},activeRegionId:'old-region'}},resources:{'tab:old-tab':{draft:'original draft'}}}
 const spatial=new AgentMuxSpatialStateStore(join(h.root,'spatial.json'));await spatial.commit({expectedRevision:0,graph})
 const configurationPath=join(h.root,'configuration.json');await writeFile(configurationPath,JSON.stringify({workspaces:[workspace],executors:{saved:{label:'Saved',providerId,command:providerId,args:[],env:{},injectAgentMuxGuide:false}}}))
 const content=createHostContent({configurationPath,spatial}),main=createHostMoteMainReader({configurationPath,spatial,files:content.files!}),store=new MoteDialogueStore(join(h.root,'dialogue.sqlite'))
 const dialogue=createHostMoteDialogue({main,spatial,store,clientForHost:()=>h.client})
 const quick=new HostMoteQuickPreferences({main,files:content.files!,prepareMainSource:dialogue.prepareMainSource,recordMainSource:dialogue.recordMainSource,catalog:async()=>spatialCatalog((await spatial.read())!.graph),executors:async()=>[{id:'saved',name:'Saved',providerId}]})
 const creator=createHostSpatialAgentControl({configurationPath,spatial,runtime:()=>({client:h.client}) as never})
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
  const hook=async(eventName:string,sequence:number,turnId='main-human-'+reference.sessionId)=>await h.inner.acceptHookEvent({agentSessionId:reference.sessionId,providerId:'claude',runId:session.run.runId,receiptId:'mote-idle-'+sequence+'-'+reference.sessionId,eventName,payload:{hook_event_name:eventName,session_id:nativeSessionId,sourceId:'mote-native-'+reference.sessionId,sequence,turnId,...(eventName==='turn.complete'?{reason:'answer',isAborted:false}:{})}},AbortSignal.timeout(5000))
  await hook('turn.start',1);await hook('turn.complete',2)
  const preferences=await quick.read({kind:'quick',target}),baseline=moteQuickBaseline(preferences)!
  const saved=await rpc.call('space.mote.preferences.save',{kind:'quick',target,operationId:'idle-policy-'+reference.sessionId,baseline,values:{...baseline.defaults,conversationRollover:{kind:'idle',idleMs}},destination:{kind:'occurrence',displayWorkspaceId:reference.displayWorkspaceId,groupId:reference.groupId,tabId:reference.tabId,regionId:reference.regionId}})
  if(saved.status!=='saved')throw Error(saved.message??'Original policy CAS missing')
  await new Promise(done=>setTimeout(done,Math.max(2,idleMs)))
  return {snapshot:await main.readCurrentMoteMain(target),session:await h.client.readAgentSession(reference.sessionId),hook}
 }
 const setup=(operationId:string,advance=true)=>rpc.call(advance?'space.mote.dialogue.setup.advance':'space.mote.dialogue.setup.inspect',{target,creation:{hostId:'local',operationId}})
 return {h,spatial,store,main,dialogue,quick,options,server,rpc,target,path,start,setup,qualifyMainIdle,close:async()=>{for(const close of closes.splice(0).reverse())await close()}}
}

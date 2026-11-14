import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createMoteInputFixture } from './mote-input-owner.js'
import { createHostContent } from '../../../../apps/host/src/content-owner.js'
import { createHostMoteMainReader } from '../../../../apps/host/src/mote-dialogue.js'
import { HostMoteQuickPreferences } from '../../../../apps/host/src/mote-quick-preferences.js'
import { parseMoteQuickMode, serializeMoteQuickMode, scratchTopicDirectoryName, directoryIdentity, homeZoneId } from '../../../../apps/host/src/mote-model.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { spatialCatalog } from '../../src/spatial-state.js'
import { moteQuickBaseline } from '../../src/mote-preferences.js'
import { runSourceObjectCli } from './source-object-cli.js'
import { objectCliEnvironment } from './object-cli-rpc.js'
export async function createMotePreferencesPlacementFixture() {
  const f=await createMoteInputFixture({directoryAddress:true}),configurationPath=join(f.root,'configuration.json')
  const cleanup:Array<()=>Promise<unknown>>=[f.close]
  try {
  const target={spaceId:directoryIdentity('local',dirname(f.motePath)),zoneId:homeZoneId(directoryIdentity('local',dirname(f.motePath))),expectedResource:{hostId:'local',workspaceId:'__scratch__',workspacePath:join(f.root,'scratch')}}
  const previous=parseMoteQuickMode(await readFile(f.motePath,'utf8'));if(previous.status!=='valid')throw Error('Original MOTE source required')
  const marker={operationId:'original-role-boundary',intentDigest:'original-role-digest',effectiveAt:100}
  const defaults={...previous.defaults,executorId:'original',conversationRevision:'original-role-generation',conversationTransition:marker,presence:{enabled:true,intervalMs:1800000}}
  const notes='\n# Original cooperation\nKeep my original note.\n';await writeFile(f.motePath,serializeMoteQuickMode('---\nversion: 1\nextra: kept\ndefaults: {}\n---\n'+notes,defaults))
  // No display occurrence is confirmed; the original Mote/home identity remains.
  const original=(await f.spatial.read())!,graph=structuredClone(original.graph);graph.layouts={};await f.spatial.commit({expectedRevision:original.revision,graph})
  const content=createHostContent({configurationPath,spatial:f.spatial}),main=createHostMoteMainReader({configurationPath,spatial:f.spatial,files:content.files!})
  const paused={loopId:'original-paused',hostId:'local',agentSessionId:defaults.conversation!.sessionId,providerId:'generic',workspacePath:f.root,prompt:'Original paused maintenance',intervalMs:1800000,everyMs:1800000,nextCheckAt:1900000,status:'paused',lastOutcome:'unknown',lastTickId:'original-unknown-tick',lastTickAt:1000000} as const
  const transitions:unknown[]=[],changed:unknown[]=[]
  const quick=new HostMoteQuickPreferences({main,files:content.files!,catalog:async()=>spatialCatalog((await f.spatial.read())!.graph),executors:async()=>[{id:'original',name:'Original',providerId:'generic'},{id:'next',name:'Next',providerId:'generic'}],maintenance:()=>({status:'paused',schedule:structuredClone(paused) as never,issue:null}),changed:target=>{changed.push(target)},prepareMainSource:async(...args)=>{transitions.push(args);return marker},recordMainSource:async(...args)=>{transitions.push(args)}})
  const server=new AgentMuxControlServer({socketPath:join(f.root,'preferences.sock'),spatialState:f.spatial,coreClients:f.coreClients,moteQuickPreferences:quick});await server.start()
  cleanup.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  cleanup.push(()=>rpc.dispose())
  const read=async()=>{const result=await rpc.call('space.mote.preferences.read',{kind:'quick',target});if(result.kind!=='quick'||result.status!=='ready'||!result.source||result.source.result.status!=='read'||!result.defaults)throw Error('Original read required: '+JSON.stringify(result));return result}
  const input=async(operationId:string,values?:unknown)=>{const reading=await read();return{kind:'quick' as const,target,operationId,baseline:moteQuickBaseline(reading)!,values:(values??{...reading.defaults,presence:{enabled:true,intervalMs:3600000}}) as typeof defaults}}
  const cli=async(value:unknown)=>{const result=await runSourceObjectCli(['--endpoint','unix:'+server.path,'space','mote','preferences','save','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_RESUMED_INBOX_CLI_LOADED:process.env.MOTE_SETTINGS_CLI_LOADED}),JSON.stringify(value),30000,new URL('../fixtures/a2a-resumed-inbox/source-loader.mjs',import.meta.url));return{...result,envelope:result.stdout.trim()?JSON.parse(result.stdout):null}}
  return{...f,async witness(kind:string,facts:unknown){if(process.env.MOTE_SETTINGS_FACTS)await appendFile(process.env.MOTE_SETTINGS_FACTS,JSON.stringify({kind,facts})+'\n')},async confirmDisplay(){const state=(await f.spatial.read())!;await f.spatial.commit({expectedRevision:state.revision,graph:{...state.graph,layouts:original.graph.layouts}})},target,main,quick,rpc,paused,defaults,marker,notes,transitions,changed,read,input,cli,scope:{workspace:{id:'__scratch__',hostId:'local',path:target.expectedResource.workspacePath,name:'Original Mote',kind:'folder' as const},topic:{id:'AbCdEfGh1234',title:'Original Mote',summary:'',collaborators:[],directoryPath:join(target.expectedResource.workspacePath,scratchTopicDirectoryName('AbCdEfGh1234')),topicPath:join(target.expectedResource.workspacePath,scratchTopicDirectoryName('AbCdEfGh1234'),'topic.md'),soul:{path:'SOUL.md',content:'# Original identity',version:'original'}},rootPath:scratchTopicDirectoryName('AbCdEfGh1234')},async close(){for(const close of cleanup.splice(0).reverse())await close()}}
  } catch(error) {for(const close of cleanup.splice(0).reverse())await close();throw error}
}

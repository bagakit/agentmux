import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath, defineAgentProvider, AgentMuxError } from '../../src/index.ts'
import { startAgentMuxHost } from '../../../../apps/host/src/host.ts'
const executable=join(import.meta.dirname,'executor-origin-cli.mjs'),providerId='origin-fixture'
async function witness(context){
  const path=join(context.workspacePath,'.origin-protocol',context.processId+'.json')
  const text=await readFile(path,'utf8'),value=JSON.parse(text)
  if(value.pid!==context.processId||!value.sid||context.nativeHandle&&value.sid!==context.nativeHandle.sessionId)throw new AgentMuxError('Original machine source changed','PRIVATE_SOURCE_CHANGED')
  const assertCurrent=async()=>{if(await readFile(path,'utf8')!==text)throw new AgentMuxError('Original process witness changed','PRIVATE_SOURCE_CHANGED')}
  return {value,assertCurrent}
}
const provider=defineAgentProvider({catalog:{id:providerId,label:'Private origin protocol',executable,expectedProcess:'node',promptDelivery:'positional-argv',readySignal:{kind:'foreground-process',expectedProcess:'node'},hookStrategy:{kind:'none'},resumeStrategy:{kind:'provider-native',locator:'session-id'},acpStrategy:{kind:'none'},capabilities:{terminal:true,timeline:'complete-events',permission:'none',providerResume:true,replyCorrelation:'none'}},
  hook:{rules:[]},buildArgs:(prompt,args)=>[...args,...prompt?[prompt]:[]],buildResumeArgs:(id,_path,prompt,args)=>[...args,'resume',id,...prompt?[prompt]:[]],
  discoverNativeSession:async context=>{const {value,assertCurrent}=await witness(context);return {handle:{kind:'provider',providerId,sessionId:value.sid,transcriptPath:join(value.root,value.sid+'.json')},assertCurrent}},
  readSessionHistoryPage:async context=>{
    const root=context.env.ORIGIN_PROFILE_ROOT,secret=context.env.ORIGIN_PRIVATE_SENTINEL
    if(!root||!secret)throw new AgentMuxError('Original private reader invocation unavailable','PRIVATE_ORIGIN_ENV_MISSING')
    const path=join(root,context.source.nativeSessionId+'.json'),history=JSON.parse(await readFile(path,'utf8'))
    if(history.secret!==secret||history.sid!==context.source.nativeSessionId||context.transcriptPath&&resolve(context.transcriptPath)!==resolve(path))throw new AgentMuxError('Original profile source mismatch','PRIVATE_SOURCE_CHANGED')
    await appendFile(join(root,'consumers.ndjson'),JSON.stringify({consumer:'history',command:context.command,args:context.args,matched:true})+'\n')
    return {source:{...context.source},items:history.records,nextCursor:null}
  }})
const path=defaultAgentMuxControlSocketPath(),root=dirname(process.env.AGENTMUX_AGENT_SESSION_STORE),configurationPath=join(root,'original-configuration.json')
try{await readFile(configurationPath)}catch{await writeFile(configurationPath,JSON.stringify({workspaces:[],executors:{},appearance:{}}))}
const host=await startAgentMuxHost({store:new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE),configurationPath,socketPath:path,desktopSocketPath:path+'.desktop',providers:[provider]})
const {owner}=await host.hosted.call('runtime.owner.identity',{});process.stdout.write(JSON.stringify({owner,socketPath:path})+'\n')
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void host.dispose().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)})})

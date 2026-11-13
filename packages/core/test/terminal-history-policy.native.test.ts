import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

it('the public RPC and real CLI read the original private p25 Run policy and raw history without replacing it', async () => {
  const root=await mkdtemp(join(tmpdir(),'amx-history-policy-public-'))
  for(const [key,name]of Object.entries({HOME:'home',CODEX_HOME:'codex',CLAUDE_CONFIG_DIR:'claude',AGENTMUX_RUNTIME_DIRECTORY:'runtime',AGENTMUX_STATE_DIRECTORY:'state',AGENTMUX_MESSAGE_QUEUE_PATH:'messages.ndjson'})) {
    const path=join(root,name);if(!name.includes('.'))await mkdir(path,{recursive:true});vi.stubEnv(key,path)
  }
  const base=new AgentProviderRegistry().get('codex')
  const provider=defineAgentProvider({catalog:{...base.catalog,id:'history-fixture',hookStrategy:{kind:'none'},resumeStrategy:{kind:'none'},
    capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:false,replyCorrelation:'none'}},hook:{rules:[]},buildArgs:(_prompt,args)=>[...args]})
  const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json')),client=new AgentMuxClient({store,providers:[provider]})
  let original:Awaited<ReturnType<AgentMuxClient['createAgent']>>|undefined
  const socket=join(root,'control.sock'),server=new AgentMuxControlServer({socketPath:socket,coreClients:()=>[{hostId:'local',client}]})
  let rpc:Awaited<ReturnType<typeof connectAgentMuxRpc>>|undefined
  try {
    const worker=join(root,'worker.mjs')
    await writeFile(worker,"process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('ORIGINAL-PUBLIC-HISTORY\\r\\n');setInterval(()=>process.stdout.write('LIVE\\r\\n'),100)")
    await client.connect()
    original=await client.createAgent({providerId:'history-fixture',executorId:'history-fixture',workspacePath:root,commandOverride:process.execPath,args:[worker],injectAgentMuxGuide:false,cols:80,rows:24})
    const run=original.run
    await vi.waitFor(async()=>expect((await client.readRunReplay(run,0,'raw')).replay.map(c=>c.data).join('')).toContain('ORIGINAL-PUBLIC-HISTORY'))
    const before=(await client.listRuns()).find(r=>r.runId===run.runId)!
    const terminal=await client.readRunReplay(run,0,'terminal')
    expect(terminal.terminal).toMatchObject({type:'basic-vt',checkpoint:{runId:run.runId,historyPolicy:{status:'observed'}}})
    await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socket}})
    const policy=await rpc.call('system.storage',{hostId:'local',runId:run.runId})
    expect(policy.status).toBe('observed')
    if(policy.status!=='observed'||terminal.terminal.type!=='basic-vt')throw Error('Original owner policy must remain observable')
    expect(terminal.terminal.checkpoint.historyPolicy).toEqual({status:'observed',scrollbackRows:policy.storage.policy.terminalHistoryRows})
    const env=objectCliEnvironment(root)
    const cli=await runSourceObjectCli(['--endpoint','unix://'+socket,'system','storage','--host','local','--run',run.runId],env)
    expect(cli.code,cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toMatchObject({status:'observed',run,runtime:{instanceId:policy.runtime.instanceId},storage:{policy:{terminalHistoryRows:policy.storage.policy.terminalHistoryRows}}})
    const raw=await runSourceObjectCli(['--endpoint','unix://'+socket,'agent','output','--session',original.agentSessionId],env)
    expect(raw.code,raw.stderr).toBe(0)
    const frames=raw.stdout.trim().split('\n').map(line=>JSON.parse(line))
    const bytes=frames.map(f=>f.params?.event).filter(e=>e?.type==='output').flatMap(e=>[...Buffer.from(e.data.dataBase64,'base64')])
    expect(Buffer.from(bytes).toString()).toContain('ORIGINAL-PUBLIC-HISTORY')
    const after=(await client.listRuns()).find(r=>r.runId===run.runId)!
    expect({runId:after.runId,pid:after.pid,state:after.state}).toEqual({runId:before.runId,pid:before.pid,state:'running'})
    expect((await store.readMetadata(original.agentSessionId))?.run).toEqual(run)
  } finally {
    await rpc?.dispose();await server.stop()
    try {if(original)await client.stopAgent(original.agentSessionId,original.run)}finally{await client.dispose()}
    const {stopProbeProcesses,listProbeProcesses}=await import(new URL('../../../apps/desktop/scripts/probe-process.mjs',import.meta.url).href) as { stopProbeProcesses(group:number,root:string):Promise<void>; listProbeProcesses(group:number,root:string):Promise<number[]> }
    await stopProbeProcesses(process.pid+1_000_000_000,root)
    expect(await listProbeProcesses(process.pid+1_000_000_000,root)).toEqual([])
    await rm(root,{recursive:true,force:true});vi.unstubAllEnvs()
  }
},30_000)

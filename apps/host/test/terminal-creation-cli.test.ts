import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { activateRuntime, createOperationKey } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
vi.mock('electron', () => ({ app: { getPath: () => '/private-unused' } }))
const restartMode=process.env.AGENTMUX_TERMINAL_CREATION_RESTART
const publicConsumer = process.env.AGENTMUX_TERMINAL_CREATION_CONSUMER === '1'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const root = process.env.AGENTMUX_TERMINAL_CREATION_ROOT??await mkdtemp('/tmp/tcc-'); if(!restartMode)cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = objectCliEnvironment(root)
  for (const [key, value] of Object.entries(env)) if (key.startsWith('AGENTMUX_')) vi.stubEnv(key, value!)
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'), socketPath: join(root, 'ctxmux.sock'),
    stateDir: join(root, 'state/ctxmux'), childDisposition: { mode: 'detached', stderr: 'pipe' } })
  cleanup.push(() => native.dispose({ shutdown: !restartMode }))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const host = await startAgentMuxHost({ store, socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'desktop.sock'), mobileBuildDirectory: join(root, 'no-mobile') })
  cleanup.push(() => host.dispose()); await host.client.connect()
  const cliEnv = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${join(root, 'control.sock')}` })
  const cli = (operationId: string, runtimeId?: string) => runCompiledObjectCli(['terminal', 'creation', 'inspect', '--host', 'local', '--operation-id', operationId, ...(runtimeId ? ['--runtime', runtimeId] : [])], cliEnv)
  return { root, host, store, native, cli }
}
it.runIf(!publicConsumer)('compiled creation inspect reads the actual private SDK admission and exact Native Run through the actual Host', async () => {
  const f = await fixture(), cwd = join(f.root, 'literal\nback\\slash'); await mkdir(cwd)
  const prepared = await f.host.client.prepareTerminal({ createOperationId: 'actual-initial-op', workspacePath: cwd, command: '/bin/cat', env: { PRIVATE_INITIAL_SENTINEL: 'not-in-public-result' } })
  const run = await f.host.client.createPreparedTerminal(prepared)
  await expect(f.host.client.inspectPreparedTerminal(prepared)).resolves.toMatchObject({ runId: run.runId })
  await expect((f.host.client as any).kernel.inspectRetainedStart(prepared.createOperationId)).resolves.not.toBeNull()
  const result = await f.cli(prepared.createOperationId)
  expect(result.code, result.stderr).toBe(0)
  const value = JSON.parse(result.stdout).result
  expect(value).toMatchObject({ hostId: 'local', operationId: prepared.createOperationId, known: true,
    admission: { workspacePath: cwd, phase: 'published', run: { runId: run.runId, state: 'running' }, observation: { availability: 'retained' } } })
  expect(result.stdout).not.toMatch(/not-in-public-result|PRIVATE_INITIAL_SENTINEL|"launch"|"prepared"|"env"/)
  expect((await f.cli(prepared.createOperationId, 'another-runtime')).code).toBe(1)
  expect(JSON.parse((await f.cli('never-admitted')).stdout).result).toMatchObject({ known: false, admission: null })
  await f.host.client.writeTerminalBytes({ runId: run.runId }, 'healthy-after-inspect')
  expect((await f.native.client.status(run.runId)).state.type).toBe('running')
})
it.runIf(!publicConsumer)('compiled creation inspect reads pending disk facts while the Native client is disconnected without activation or Start', async () => {
  const f = await fixture(), prepared = await f.host.client.prepareTerminal({ createOperationId: 'pending-native-offline', workspacePath: f.root, command: '/bin/cat' })
  const kernel = (f.host.client as any).kernel
  const start = vi.spyOn(kernel, 'startPrepared').mockRejectedValueOnce(Error('Controlled Core pending Start endpoint; no Native ACK'))
  await expect(f.host.client.createPreparedTerminal(prepared)).rejects.toThrow('pending Start')
  await f.host.client.dispose()
  const result = await f.cli(prepared.createOperationId)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ known: true, admission: { phase: 'dispatched', run: null, observation: { availability: 'unavailable' } } })
  expect(start).toHaveBeenCalledOnce()
})
it.runIf(!publicConsumer)('the real Host rejects a creation receipt for another original operation instead of accepting a carrier-shaped result', async () => {
  const f = await fixture()
  vi.spyOn(f.host.client, 'inspectTerminalCreation').mockResolvedValue({ hostId: 'local', operationId: 'foreign-op', known: false, admission: null })
  const result = await f.cli('requested-op')
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
})

it.runIf(!publicConsumer)('consumes the original terminal.open Main and Renderer producer in an isolated private Native process', async () => {
  const result = await new Promise<{code: number|null; text: string}>((yes, no) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/host/test/vitest.terminal-creation.config.mts'], {
      cwd: process.cwd(), env: {...process.env, AGENTMUX_TERMINAL_CREATION_CONSUMER: '1'}, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Private terminal creation consumer deadline.')) }, 60000)
    child.stdout.on('data', b => { text += b }); child.stderr.on('data', b => { text += b })
    child.once('error', no); child.once('close', code => { clearTimeout(timer); yes({code, text}) })
  })
  expect(result.code, result.text).toBe(0); expect(result.text).toMatch(/1 passed/)
}, 65000)
it.runIf(publicConsumer&&!restartMode)('terminal.open preserves its original operation through real Main/Renderer and an unknown Native ACK is queried without Start replay', async () => {
  const f = await fixture()
  const [{RuntimeController}, {connectDesktopAgentMuxHost, callOriginalDesktopHost}, {desktopRpcMethods}, core,
    {useAppStore: state}, {api}, {createWorkbenchTab}, {createWorkspaceLayout}] = await Promise.all([
    import('../../desktop/src/main/runtime-controller.js'), import('../../desktop/src/main/desktop-host.js'), import('../../desktop/src/main/desktop-rpc-exposure.js'),
    import('@agentmux/core'), import('../../desktop/src/renderer/src/store.js'), import('../../desktop/src/renderer/src/lib/api.js'),
    import('../../desktop/src/renderer/src/lib/workbench-tabs.js'), import('@agentmux/layout') ])
  const config: any = {version:9, hosts:[{id:'local',kind:'local',label:'Private initial'}],executors:{},workspaces:[{id:'W',name:'Original',hostId:'local',path:f.root,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{}}}
  const runtime = new RuntimeController(f.store, connectDesktopAgentMuxHost)
  runtime.commit(await runtime.prepare(config)); cleanup.push(() => runtime.dispose())
  state.setState({ config, tabs: {'original-tab':createWorkbenchTab('original-tab',{regionId:'original-launcher',kind:'launcher',workspaceId:'W'})},
    layouts:{W:createWorkspaceLayout('G',['original-tab'])}, sessions:[],activeWorkspaceId:'W',loading:false })
  const launch = vi.spyOn(api.sessions,'launchTerminal').mockImplementation(input => runtime.launchTerminal(input,config))
  const server = new core.AgentMuxControlServer({socketPath:join(f.root,'desktop.sock'),exposedMethods:desktopRpcMethods(),forwardingPeer:{authoritySocketPath:join(f.root,'control.sock')},
    coreClients:()=>[{hostId:'local',client:f.host.client}],execute:request=>state.getState().executeControl(request),
    callOriginalCore:(_host,method,input,context)=>callOriginalDesktopHost(f.host.client as any,method,input,context)})
  await server.start();cleanup.push(()=>server.stop())
  const env = objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:`unix:${join(f.root,'control.sock')}`})
  const open = (op:string) => runCompiledObjectCli(['terminal','open','--tab','original-tab','--new-tab','--command','exec /bin/cat','--operation-id',op],env)
  const first = await open('public-original-terminal')
  expect(first.code,first.stderr).toBe(0)
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({createOperationId:'public-original-terminal',workspacePath:f.root}))
  const observed = await f.cli('public-original-terminal')
  expect(observed.code,observed.stderr).toBe(0)
  const run = JSON.parse(observed.stdout).result.admission.run
  expect(state.getState().sessions.some(s=>s.control.kind==='terminal' && s.control.run.runId===run.runId)).toBe(true)
  const kernel=(f.host.client as any).kernel, original=kernel.startPrepared.bind(kernel)
  const start=vi.spyOn(kernel,'startPrepared').mockImplementation(async (...args:any[])=>{await original(...args);throw Error('Controlled loss after the actual Native Start ACK')})
  const lost = await open('public-lost-ack')
  expect(lost.code).toBe(1)
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({createOperationId:'public-lost-ack'}))
  const recovered = await f.cli('public-lost-ack')
  expect(recovered.code,recovered.stderr).toBe(0)
  const retained = JSON.parse(recovered.stdout).result.admission
  expect(retained).toMatchObject({phase:'published',observation:{availability:'retained'},run:{state:'running'}})
  await f.host.client.writeTerminalBytes({runId:retained.run.runId},'healthy-after-lost-ack')
  expect((await f.native.client.status(run.runId)).state.type).toBe('running')
  expect((await f.native.client.status(retained.run.runId)).state.type).toBe('running')
  expect(start).toHaveBeenCalledOnce()
})
it.runIf(!publicConsumer)('compiled explicit retirement preserves a retained healthy Run and fences an actual Native not_applied Start exactly once',async()=>{
  const f=await fixture(),prepared=await f.host.client.prepareTerminal({createOperationId:'retained-cli-key',workspacePath:f.root,command:'/bin/cat'}),run=await f.host.client.createPreparedTerminal(prepared)
  const runtime=f.host.client.terminalCreationRuntimeIdentity(),kernel=(f.host.client as any).kernel
  const retire=vi.spyOn(kernel,'retireOriginalCreationKey'),stop=vi.spyOn(kernel,'stop')
  const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:`unix:${join(f.root,'control.sock')}`})
  const cliRetire=(op:string)=>runCompiledObjectCli(['terminal','creation','retire','--host','local','--operation-id',op,'--runtime',runtime.runtimeId],env)
  const retained=await cliRetire(prepared.createOperationId)
  expect(retained.code,retained.stderr).toBe(0)
  expect(JSON.parse(retained.stdout).result).toMatchObject({admission:{retirement:{native:{outcome:'retained',run:{runId:run.runId}}}}})
  await f.host.client.writeTerminalBytes({runId:run.runId},'original-still-healthy')
  expect((await f.native.client.status(run.runId)).state.type).toBe('running');expect(stop).not.toHaveBeenCalled()
  const failed=await f.host.client.prepareTerminal({createOperationId:'actual-not-applied',workspacePath:f.root,command:'/bin/cat'})
  // Actual Native prior retirement produces its authoritative not_applied refusal.
  await f.native.client.retireCreation(createOperationKey(failed.createOperationId))
  await expect(f.host.client.createPreparedTerminal(failed)).rejects.toMatchObject({creationFailure:{operationId:failed.createOperationId,disposition:'not_applied'}})
  const negative=await f.cli(failed.createOperationId)
  expect(JSON.parse(negative.stdout).result).toMatchObject({admission:{phase:'dispatched',startFailure:{operationId:failed.createOperationId,disposition:'not_applied'}}})
  const fenced=await cliRetire(failed.createOperationId)
  expect(fenced.code,fenced.stderr).toBe(0)
  expect(JSON.parse(fenced.stdout).result).toMatchObject({admission:{phase:'retired',run:null,retirement:{native:{outcome:'retired'}}}})
  expect((await cliRetire(failed.createOperationId)).code).toBe(0)
  expect(retire).toHaveBeenCalledTimes(2)
  const draft=await f.host.client.prepareTerminal({createOperationId:'actual-unknown-spawn',workspacePath:f.root,command:'/bin/cat'})
  const launch=JSON.parse(draft.launch);launch.request.program=join(f.root,'no-native-executable');launch.request.args=[]
  await expect(f.host.client.createPreparedTerminal({...draft,launch:JSON.stringify(launch)})).rejects.toMatchObject({creationFailure:{operationId:draft.createOperationId,disposition:'unknown'}})
  expect(JSON.parse((await f.cli(draft.createOperationId)).stdout).result).toMatchObject({admission:{phase:'dispatched',startFailure:{disposition:'unknown'}}})
  expect(stop).not.toHaveBeenCalled()
})

it.runIf(!publicConsumer)('reopens the original initial creation in two OS processes without replaying its lost Native Start',async()=>{
  const root=await mkdtemp('/tmp/tcr-');cleanup.push(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'state/ctxmux'),{recursive:true,mode:0o700})
  const activation=await activateRuntime({executable:resolve('packages/core/vendor/ctxmux',`${process.platform}-${process.arch}`,'bin/ctxmuxd'),socketPath:join(root,'ctxmux.sock'),stateDir:join(root,'state/ctxmux'),childDisposition:{mode:'detached',stderr:'pipe'}})
  cleanup.push(()=>activation.dispose({shutdown:true}))
  for(const mode of ['writer','reader']) {
    const result=await new Promise<{code:number|null;text:string}>((yes,no)=>{
      const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','apps/host/test/vitest.terminal-creation.config.mts'],{cwd:process.cwd(),env:{...process.env,AGENTMUX_TERMINAL_CREATION_CONSUMER:'1',AGENTMUX_TERMINAL_CREATION_RESTART:mode,AGENTMUX_TERMINAL_CREATION_ROOT:root},stdio:['ignore','pipe','pipe']})
      let text='';const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('Private initial creation restart deadline'))},60000)
      child.stdout.on('data',b=>{text+=b});child.stderr.on('data',b=>{text+=b});child.once('error',no);child.once('close',code=>{clearTimeout(timer);yes({code,text})})
    });expect(result.code,result.text).toBe(0);expect(result.text).toMatch(/1 passed/)
  }
},130000)
it.runIf(!!restartMode)('consumes the persisted original raw creation after OS restart and only observes the original key',async()=>{
  const f=await fixture(),kernel=(f.host.client as any).kernel
  if(restartMode==='writer') {
    const prepared=await f.host.client.prepareTerminal({createOperationId:'two-os-original',workspacePath:f.root,command:'/bin/cat'})
    const original=kernel.startPrepared.bind(kernel);let nativeRun:any
    const start=vi.spyOn(kernel,'startPrepared').mockImplementation(async(...args:any[])=>{nativeRun=await original(...args);throw Error('actual private Native ACK withheld from Core')})
    await expect(f.host.client.createPreparedTerminal(prepared)).rejects.toThrow('ACK withheld')
    expect(start).toHaveBeenCalledOnce()
    await writeFile(join(f.root,'two-os.json'),JSON.stringify({prepared,runId:nativeRun.runId,pid:nativeRun.pid,writerPid:process.pid,runtimeId:f.host.client.terminalCreationRuntimeIdentity().runtimeId}))
    expect(await (f.host.client as any).terminalRecoveryOwner().retainedExecutionDirectories()).toEqual([f.root])
  } else {
    const saved=JSON.parse(await readFile(join(f.root,'two-os.json'),'utf8'))
    expect(saved.writerPid).not.toBe(process.pid)
    const start=vi.spyOn(kernel,'startPrepared')
    expect(await (f.host.client as any).terminalRecoveryOwner().retainedExecutionDirectories()).toEqual([f.root])
    const result=await f.cli(saved.prepared.createOperationId,saved.runtimeId)
    expect(result.code,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result).toMatchObject({admission:{phase:'published',run:{runId:saved.runId,pid:saved.pid,state:'running'}}})
    expect(await f.host.client.createPreparedTerminal(saved.prepared)).toMatchObject({runId:saved.runId,pid:saved.pid})
    await f.host.client.writeTerminalBytes({runId:saved.runId},'same-original-two-os-run')
    expect(start).not.toHaveBeenCalled()
    expect((await f.native.client.status(saved.runId)).state.type).toBe('running')
  }
})
it.runIf(!publicConsumer)('an exact selected retirement owner change after durable admission does not dispatch to Native',async()=>{
  const f=await fixture(),prepared=await f.host.client.prepareTerminal({createOperationId:'retire-selected-owner',workspacePath:f.root,command:'/bin/cat'}),inner=f.host.client as any,kernel=inner.kernel,owner=inner.terminalRecoveryOwner()
  vi.spyOn(kernel,'startPrepared').mockRejectedValueOnce(Error('controlled pending initial Start'))
  await expect(f.host.client.createPreparedTerminal(prepared)).rejects.toThrow('pending initial')
  const source=f.host.client.terminalCreationRuntimeIdentity(),save=owner.saveRetirement.bind(owner)
  const nativeRetire=vi.spyOn(kernel.client,'retireCreation'),identity=vi.spyOn(kernel,'creationRuntimeIdentity')
  vi.spyOn(owner,'saveRetirement').mockImplementation(async(id:string,value:any)=>{const saved=await save(id,value);if(value.phase==='dispatched')identity.mockReturnValue({...source,instanceId:'different-selected-owner'});return saved})
  const result=await f.host.client.retireTerminalCreation({hostId:'local',operationId:prepared.createOperationId,runtimeId:source.runtimeId})
  expect(result).toMatchObject({admission:{retirement:{native:null,request:{dispatchRuntime:source}}}})
  expect(nativeRetire).not.toHaveBeenCalled()
})
it.runIf(!publicConsumer)('compiled creation inspection refuses a published result without its original Run identity',async()=>{
  const f=await fixture(),runtime=f.host.client.terminalCreationRuntimeIdentity()
  vi.spyOn(f.host.client,'inspectTerminalCreation').mockResolvedValue({hostId:'local',operationId:'incomplete-published',known:true,admission:{runtime,workspacePath:f.root,phase:'published',run:null,observation:{availability:'unavailable',runtime:null},diskDurability:'confirmed'}})
  const result=await f.cli('incomplete-published')
  expect(result.code).toBe(1);expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
})
it.runIf(!publicConsumer)('actual managed CLI credentials cannot inspect or retire a raw creation and preserve the original Agent binding',async()=>{
  const f=await fixture(),{issueAgentCapability,hashAgentCapability}=await import('@agentmux/core')
  const run=await f.host.client.createTerminal({createOperationId:'credential-agent-run',workspacePath:f.root,command:'/bin/cat'}),capability=issueAgentCapability()
  const actor:any={kind:'agent',agentSessionId:'original-managed',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:f.root,run:{runId:run.runId},retiredRuns:[],hookBindingId:'hook',hookToken:'token',capabilityHash:hashAgentCapability(capability),createdAt:1,updatedAt:1}
  await f.store.compareAndSwap(null,actor)
  const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:`unix:${join(f.root,'control.sock')}`,AGENTMUX_AGENT_SESSION_ID:actor.agentSessionId,AGENTMUX_AGENT_CAPABILITY:capability})
  const runtime=f.host.client.terminalCreationRuntimeIdentity(),inspect=vi.spyOn(f.host.client,'inspectTerminalCreation'),retire=vi.spyOn(f.host.client,'retireTerminalCreation')
  const before=await readFile(join(f.root,'sessions.json'))
  for(const action of ['inspect','retire']) {
    const result=await runCompiledObjectCli(['terminal','creation',action,'--host','local','--operation-id','not-an-agent-permission','--runtime',runtime.runtimeId],env)
    expect(result.code).toBe(1);expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  }
  expect(inspect).not.toHaveBeenCalled();expect(retire).not.toHaveBeenCalled()
  expect(await readFile(join(f.root,'sessions.json'))).toEqual(before)
  expect((await f.native.client.status(run.runId)).state.type).toBe('running')
})
it.runIf(!publicConsumer)('the actual Hosted owner reads the same cold creation and never repeats its retained retirement action',async()=>{
  const f=await fixture(),{connectHostedAgentMux}=await import('@agentmux/core')
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:join(f.root,'control.sock')}});cleanup.push(()=>rpc.dispose())
  const sdk=await connectHostedAgentMux({rpc,connectOnDemand:true});cleanup.push(()=>sdk.dispose())
  const prepared=await f.host.client.prepareTerminal({createOperationId:'hosted-initial-owner',workspacePath:f.root,command:'/bin/cat'}),run=await f.host.client.createPreparedTerminal(prepared),runtime=f.host.client.terminalCreationRuntimeIdentity()
  const retire=vi.spyOn((f.host.client as any).kernel,'retireOriginalCreationKey')
  expect(await sdk.inspectTerminalCreation({hostId:'local',operationId:prepared.createOperationId})).toMatchObject({admission:{run:{runId:run.runId}}})
  expect(await sdk.retireTerminalCreation({hostId:'local',operationId:prepared.createOperationId,runtimeId:runtime.runtimeId})).toMatchObject({admission:{retirement:{native:{outcome:'retained',run:{runId:run.runId}}}}})
  expect(await sdk.retireTerminalCreation({hostId:'local',operationId:prepared.createOperationId,runtimeId:runtime.runtimeId})).toMatchObject({admission:{run:{runId:run.runId}}})
  expect(retire).toHaveBeenCalledOnce()
  await f.host.client.dispose()
  expect(await sdk.inspectTerminalCreation({hostId:'local',operationId:prepared.createOperationId})).toMatchObject({admission:{run:{runId:run.runId},observation:{availability:'unavailable'}}})
})

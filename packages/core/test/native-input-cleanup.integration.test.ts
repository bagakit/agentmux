import { fixtureDisplayPath as reshapeFixtureDisplayPath, fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
// @ts-expect-error The existing runtime dependency has no bundled declaration.
import { WebSocketServer } from 'ws'

// Each consumer imports the real compiled owners. Observation calls original
// spawn and returns its original object; no helper, close or error is replaced.
const consumerSource = String.raw`
import cp from 'node:child_process';import {syncBuiltinESMExports,registerHooks} from 'node:module';import {readFile} from 'node:fs/promises';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';
const c=JSON.parse(await readFile(process.argv[2],'utf8')),events=[],owners=[],probes=[],controller=new AbortController(),loaded={};let nativeReady=false;
registerHooks({load(url,context,next){const result=next(url,context);if(url.startsWith(pathToFileURL(c.dist+'/').href)){const path=fileURLToPath(url);loaded[path]=createHash('sha256').update(readFileSync(path)).digest('hex')}return result}});
const emit=(kind,detail={})=>events.push({kind,at:Date.now(),...detail}),serialize=e=>({name:e?.name,code:e?.code,message:e?.message,detail:e?.detail,controlFailure:e?.controlFailure,logId:e?.logId});
const {AgentMuxError}=await import(pathToFileURL(c.dist+'/errors.js'));
const original=c.primaryKind==='type-error'?new TypeError('original ordinary caller reason'):c.primaryKind==='dom-exception'?new DOMException('original DOM caller reason','AbortError'):new AgentMuxError(c.primaryKind?.startsWith('long')?'long original message '.repeat(400):'original frozen caller reason','ORIGINAL_FAILURE',c.primaryKind?.startsWith('long')?JSON.stringify({payload:c.primaryKind==='long-escaped'?'\\\"\u0000'.repeat(700):'x'.repeat(8178)}):'{"exact":"original"}',{disposition:'unknown',confirmedInputBytes:7},'aBcD2345EfGh');const originalDetail=original.detail;
Object.defineProperty(original,'cause',{value:new Error('original cause')});if(c.frozen)Object.freeze(original);
const spawn=cp.spawn;cp.spawn=function(command,args,options){const child=Reflect.apply(spawn,this,[command,args,options]);if(command===c.dist+'/native-socket-peer-darwin'&&args?.length===4&&args[0]===String(c.tuiPid)){
const owner={child,pid:child.pid,stdout:'',stderr:'',exit:null};owner.closed=new Promise(resolve=>child.once('close',(code,signal)=>{owner.exit={code,signal};emit('observer-close',{pid:child.pid,code,signal});if(c.mode==='transport-before-cancel')queueMicrotask(()=>{emit('caller-cancel-after-transport-close');controller.abort(original)});resolve()}));
child.stdout.on('data',bytes=>{owner.stdout+=String(bytes);if(String(bytes).includes('"type":"native-socket-ready"')){nativeReady=true;if(c.mode==='cancel-after-ready-os')emit('ready-before-os-await')}if(c.mode==='cancel'&&String(bytes).includes('"type":"native-socket-ready"'))queueMicrotask(()=>controller.abort(original));if(c.mode==='transport-before-cancel'&&String(bytes).includes('"type":"native-socket-ready"')){emit('ready-before-transport-close');child.kill('SIGTERM')}});
child.stderr.on('data',bytes=>{owner.stderr+=String(bytes)});child.stdin.once('finish',()=>{emit('stdin-finish',{pid:child.pid});if(c.stallMs){const at=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,c.stallMs);emit('loop-resumed',{elapsed:Date.now()-at})}});owners.push(owner);emit('observer-created',{command,args,pid:child.pid,sha256:createHash('sha256').update(readFileSync(command)).digest('hex')})}
if(c.mode==='cancel-after-ready-os'&&nativeReady&&command==='lsof'&&args?.join(' ')===['-nP','-a','-p',String(c.tuiPid),'-d','txt','-F0pftnDi'].join(' ')&&probes.length===0){const probe={child,pid:child.pid,exit:null};probe.closed=new Promise(resolve=>child.once('close',(code,signal)=>{probe.exit={code,signal};emit('os-probe-close',{pid:child.pid,code,signal});resolve()}));probes.push(probe);emit('os-probe-created',{command,args,pid:child.pid});queueMicrotask(()=>{emit('caller-cancel-during-os-await');controller.abort(original)})}return child};syncBuiltinESMExports();
let client,rpc,server,inputWrites=0;
const attempt=async(label,run)=>{const result=await run().then(()=>({ok:true}),error=>({ok:false,error}));emit('result',{label,ok:result.ok,...(!result.ok?{error:serialize(result.error),sameOriginal:result.error===original,causeSameOriginal:result.error.cause===original,isAgentMuxError:result.error instanceof AgentMuxError,originalUnchanged:original.detail===originalDetail&&original.cause.message==='original cause'}:{})})};
try{if((c.mode==='cancel'||c.mode==='transport-before-cancel'||c.mode==='cancel-after-ready-os')&&!c.provider&&!c.public){const {openNativeSocketChannel}=await import(pathToFileURL(c.dist+'/agent-native-socket.js'));await attempt('socket',()=>openNativeSocketChannel(c.tuiPid,c.endpoint,controller.signal))}
else if(!c.public){const {prepareCodexNativePromptInput}=await import(pathToFileURL(c.dist+'/providers/codex-native-prompt.js'));await attempt('provider',()=>prepareCodexNativePromptInput({processId:c.tuiPid,args:['--remote','unix://'+c.endpoint],nativeHandle:{kind:'provider',providerId:'codex',sessionId:'private-thread',transcriptPath:c.root+'/unread'},signal:c.mode==='cancel'||c.mode==='transport-before-cancel'?controller.signal:AbortSignal.timeout(15000),onPreparationPhase:phase=>emit('phase',{phase})}))}
else{process.env.AGENTMUX_RUNTIME_DIRECTORY=c.root;process.env.AGENTMUX_STATE_DIRECTORY=c.root+'/state';process.env.AGENTMUX_MESSAGE_QUEUE_PATH=c.root+'/messages.ndjson';
const core=await import(pathToFileURL(c.dist+'/index.js'));const store=new core.AgentMuxFileAgentSessionStore(c.root+'/sessions.json');await store.compareAndSwap(null,{kind:'agent',agentSessionId:'recipient',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:c.root,run:{runId:'private-run'},retiredRuns:[],hookBindingId:'fixture',hookToken:'fixture',createdAt:${reshapeFixtureEpoch(0, 0, 1)},updatedAt:${reshapeFixtureEpoch(0, 0, 1)},nativeHandle:{kind:'provider',providerId:'codex',sessionId:'private-thread',transcriptPath:c.root+'/unread'}});
client=new core.AgentMuxClient({store});await client.registry.load('local');client.connected=true;client.kernel.isConnected=()=>true;client.kernel.identity=()=>({daemonInstanceId:'private-controlled-runtime'});
client.kernel.status=async runId=>({runId,lifecycleOperationId:null,program:'codex',args:['--remote','unix://'+c.endpoint],workspacePath:c.root,pid:c.tuiPid,state:{type:'running'},cols:80,rows:24,latestOutputBytes:0,firstAvailableByte:0,acceptedInputBytes:0,nativeService:null});client.kernel.input=async()=>{inputWrites++;throw new Error('Unexpected input')};
await attempt('sdk',()=>client.submitAgentPrompt({agentSessionId:'recipient',expectedRun:{runId:'private-run'},afterSubmissionId:null,operationId:'sdk-cleanup',execution:'immediate',prompt:'original body',authorHuman:true,sourceChannel:'api',allowUncertainTurn:true,...(c.mode==='cancel'?{signal:controller.signal}:{})}));if(c.mode==='cancel'){const {deliveryFailure}=await import(pathToFileURL(c.dist+'/delivery-attempt.js'));const sdk=events.find(e=>e.kind==='result'&&e.label==='sdk');emit('delivery-dto',{error:deliveryFailure(sdk.error)})}
const {AgentMuxControlServer}=await import(pathToFileURL(c.dist+'/public-rpc-server.js'));const {connectAgentMuxRpc}=await import(pathToFileURL(c.dist+'/public-rpc-client.js'));
server=new AgentMuxControlServer({socketPath:c.root+'/control.sock',coreClients:()=>[{hostId:'local',client}]});await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});
const input={target:{kind:'agent-session',agentSessionId:'recipient'},text:'original body',sourceChannel:'cli',execution:'immediate',operationId:'original-cleanup-control',messageId:'original-cleanup-message'};
await attempt('rpc',()=>rpc.call('agent.send',input));
const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')));
const cli=cp.spawn(process.execPath,[c.cli,'--endpoint','unix://'+server.path,'agent','send','--to-session','recipient','--text',input.text,'--execution','immediate','--operation-id',input.operationId,'--message-id',input.messageId],{env:{...clean,AGENTMUX_RUNTIME_DIRECTORY:c.root,AGENTMUX_STATE_DIRECTORY:c.root+'/state',AGENTMUX_AGENT_SESSION_STORE:c.root+'/sessions.json',AGENTMUX_MESSAGE_QUEUE_PATH:c.root+'/messages.ndjson'},stdio:['ignore','pipe','pipe']});let out='',err='';cli.stdout.on('data',b=>out+=String(b));cli.stderr.on('data',b=>err+=String(b));const exit=await new Promise(resolve=>cli.once('close',(code,signal)=>resolve({code,signal})));emit('cli',{exit,stdout:out,stderr:err});emit('input-writes',{count:inputWrites})}}
finally{if(rpc)await rpc.dispose();if(server)await server.stop();if(client)await client.dispose();cp.spawn=spawn;syncBuiltinESMExports();for(const o of [...owners,...probes]){let escalation;try{if(!o.exit){o.child.stdin.end();o.child.kill('SIGTERM');escalation=setTimeout(()=>{if(!o.exit)o.child.kill('SIGKILL')},500)}await o.closed}finally{clearTimeout(escalation)}emit(probes.includes(o)?'os-probe-retired':'retired',{pid:o.pid,exit:o.exit,...(!probes.includes(o)?{stdout:o.stdout,stderr:o.stderr}:{})})}console.log(JSON.stringify({events,loaded}));}
`
type Mode = 'endpoint' | 'image' | 'protocol' | 'cancel' | 'transport-before-cancel' | 'cancel-after-ready-os'
async function consume(mode: Mode, stallMs: number, options: { public?: boolean; provider?: boolean; frozen?: boolean; primaryKind?: 'type-error' | 'dom-exception' | 'long' | 'long-escaped' } = {}) {
  const root = await realpath(await mkdtemp(reshapeFixtureDisplayPath("tmp/am-ic-"))), identity = await lstat(root, { bigint: true }), endpoint = join(root, 'rpc.sock')
  const server = createServer(), wss = new WebSocketServer({ server }), require = createRequire(import.meta.url)
  let originalSocket: unknown, ready!: () => void
  const originalReady = new Promise<void>(resolve => { ready = resolve })
  wss.on('connection', (socket: { pause(): void; on(event: string, handler: (data: Buffer) => void): void }) => {
    if (originalSocket) socket.pause() // Original producer deliberately delays this private close handshake.
    socket.on('message', data => { if (JSON.parse(String(data)).original === root) { originalSocket = socket; ready() } })
  })
  server.listen(endpoint); await once(server, 'listening'); await chmod(endpoint, mode === 'endpoint' ? 0o666 : 0o600)
  let executable = process.execPath
  if (mode === 'image') { executable = join(root, 'tui-image'); await copyFile(process.execPath, executable); await chmod(executable, 0o500) }
  const tui = spawn(executable, ['-e', `const WS=require(${JSON.stringify(require.resolve('ws'))}),net=require('net');const s=new WS('ws://localhost/',{createConnection:()=>net.connect(${JSON.stringify(endpoint)})});s.on('open',()=>{s.send(JSON.stringify({original:${JSON.stringify(root)}}));console.log('ready')});setInterval(()=>{},1000)`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const tuiClose = once(tui, 'close')
  let child: ReturnType<typeof spawn> | undefined, childClose: ReturnType<typeof once> | undefined, primary: unknown
  try {
    await Promise.all([once(tui.stdout!, 'data'), originalReady])
    const script = join(root, 'consumer.mjs'), config = join(root, 'config.json')
    const dist = fileURLToPath(new URL('../dist', import.meta.url)), cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
    await writeFile(script, consumerSource); await writeFile(config, JSON.stringify({ mode, stallMs, ...options, root, endpoint, tuiPid: tui.pid, dist, cli }))
    child = spawn(process.execPath, [script, config], { stdio: ['ignore', 'pipe', 'pipe'] }); childClose = once(child, 'close')
    let stdout = '', stderr = ''; child.stdout!.on('data', bytes => { stdout += String(bytes) }); child.stderr!.on('data', bytes => { stderr += String(bytes) })
    const [code, signal] = await childClose
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    const result = JSON.parse(stdout) as { events: any[] }
    const receipt = { schema: 'agentmux.native-input-cleanup-consumer.v1', mode, stallMs, options, diagnostics: stderr, ...result }
    if (process.env.DURABLE_WAIT_NATIVE_CONSUMER_RECEIPT && ['transport-before-cancel', 'cancel-after-ready-os'].includes(mode)) await writeFile(process.env.DURABLE_WAIT_NATIVE_CONSUMER_RECEIPT, JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt))
    expect(result.events.filter(event => event.kind === 'retired').length).toBe(options.public ? 3 : 1)
    expect(tui.exitCode).toBeNull()
    return result.events
  } catch (error) { primary = error; throw error }
  finally {
    const failures: unknown[] = []
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await childClose }
    if (tui.exitCode === null && tui.signalCode === null) tui.kill('SIGTERM')
    const [code, signal] = await tuiClose
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>(resolve => wss.close(resolve)); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const current = await lstat(root, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) failures.push(new Error('Private namespace changed'))
    if (signal !== 'SIGTERM') failures.push(new Error('Original TUI exit unconfirmed'))
    if (!failures.length) await rm(root, { recursive: true })
    console.log(JSON.stringify({ schema: 'agentmux.native-input-cleanup-exit.v1', root, originalTui: { pid: tui.pid, code, signal }, consumer: { pid: child?.pid, code: child?.exitCode, signal: child?.signalCode }, directory: { dev: String(identity.dev), ino: String(identity.ino) }, removed: failures.length === 0 }))
    if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures], 'Private original cleanup unconfirmed')
  }
}
function nativeDetail(error: { detail: string }) {
  const parse = (detail: unknown) => {
    expect(detail).toBeTypeOf('string')
    let value: any, error: unknown
    try { value = JSON.parse(detail as string) } catch (failure) { error = failure }
    expect(error).toBeUndefined() // Invalid wire JSON is a business assertion, not setup failure.
    return value
  }
  let value = parse(error.detail)
  if (value.cause) value = parse(value.cause.detail)
  if (value.observation) value = parse(value.observation.detail)
  return value
}
function originalReason(value: any, mode: Mode) {
  if (mode === 'endpoint') expect(value).toMatchObject({ phase: 'native-peer', reason: 'endpoint-owner', observation: { reason: 'permissions-mismatch', errno: null, stat: { mode: 0o666 } } })
  if (mode === 'image') expect(value).toEqual({ phase: 'native-actor', reason: 'peer-image-mismatch' })
  if (mode === 'protocol') expect(value).toEqual({ phase: 'native-protocol', reason: 'native-error-contract-unsupported' })
}

it.runIf(process.platform === 'darwin').each(['endpoint', 'image', 'protocol'] as const)('original %s failure survives successful and unconfirmed close through Builtin Provider', async mode => {
  const normal = await consume(mode, 0), delayed = await consume(mode, 2000)
  const before = normal.find(e => e.kind === 'result'), after = delayed.find(e => e.kind === 'result')
  expect(before.ok).toBe(false); expect(after.ok).toBe(false)
  originalReason(nativeDetail(before.error), mode)
  const both = nativeDetail(after.error)
  expect(both).toHaveProperty('primary'); expect(both).toHaveProperty('cleanup')
  originalReason(JSON.parse(both.primary.detail), mode)
  expect(JSON.parse(both.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
  const rejected = delayed.find(e => e.kind === 'result'), retired = delayed.find(e => e.kind === 'retired')
  expect(retired.at).toBeGreaterThanOrEqual(rejected.at)
}, 60000)

it.runIf(process.platform === 'darwin').each([false, true])('normal close rethrows exact original caller Error (frozen=%s)', async frozen => {
  const events = await consume('cancel', 0, { frozen }), result = events.find(e => e.kind === 'result')
  expect(result.ok).toBe(false); expect(result.sameOriginal).toBe(true); expect(result.originalUnchanged).toBe(true)
  expect(result.error).toMatchObject({ code: 'ORIGINAL_FAILURE', detail: '{"exact":"original"}', controlFailure: { disposition: 'unknown', confirmedInputBytes: 7 }, logId: 'aBcD2345EfGh' })
}, 30000)

it.runIf(process.platform === 'darwin')('frozen original failure retains primary and cleanup facts without mutation', async () => {
  const events = await consume('cancel', 2000, { frozen: true }), result = events.find(e => e.kind === 'result')
  expect(result.originalUnchanged).toBe(true); expect(result.causeSameOriginal).toBe(true)
  expect(result.error).toMatchObject({ code: 'ORIGINAL_FAILURE', controlFailure: { disposition: 'unknown', confirmedInputBytes: 7 }, logId: 'aBcD2345EfGh' })
  const detail = nativeDetail(result.error)
  expect(detail).toHaveProperty('primary'); expect(detail).toHaveProperty('cleanup')
  expect(detail.primary).toMatchObject({ code: 'ORIGINAL_FAILURE', detail: '{"exact":"original"}', cause: { message: 'original cause' } })
  expect(JSON.parse(detail.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
}, 30000)

it.runIf(process.platform === 'darwin')('original endpoint and cleanup remain visible through actual SDK, public RPC and compiled CLI', async () => {
  const events = await consume('endpoint', 2000, { public: true })
  expect(events.find(e => e.kind === 'input-writes').count).toBe(0)
  const failures = events.filter(e => e.kind === 'result')
  expect(failures.map(e => e.label)).toEqual(['sdk', 'rpc'])
  const cli = events.find(e => e.kind === 'cli'); expect(cli.exit).toEqual({ code: 1, signal: null })
  for (const error of [...failures.map(e => e.error), JSON.parse(cli.stderr).error]) {
    const both = nativeDetail(error)
    expect(both).toHaveProperty('primary'); expect(both).toHaveProperty('cleanup')
    originalReason(JSON.parse(both.primary.detail), 'endpoint')
    expect(JSON.parse(both.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
  }
}, 60000)


it.runIf(process.platform === 'darwin').each(['type-error', 'dom-exception'] as const)('ordinary %s remains a service error when original observer close is unconfirmed', async primaryKind => {
  const events = await consume('cancel', 2000, { primaryKind }), result = events.find(e => e.kind === 'result')
  expect(result.isAgentMuxError).toBe(false); expect(result.error.code).toBeUndefined()
  const both = nativeDetail(result.error)
  expect(both.primary.name).toBe(primaryKind === 'type-error' ? 'TypeError' : 'AbortError')
  expect(JSON.parse(both.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
}, 30000)

it.runIf(process.platform === 'darwin')('original Provider projection preserves ordinary primary and cleanup diagnostics', async () => {
  const events = await consume('cancel', 2000, { provider: true, primaryKind: 'type-error' }), result = events.find(e => e.kind === 'result')
  expect(result.error.code).toBe('AGENT_NATIVE_INPUT_WAITING') // Existing Provider observation, never caller classification.
  const both = nativeDetail(result.error)
  expect(both.primary.name).toBe('TypeError'); expect(both.primary.code).toBeUndefined()
  expect(JSON.parse(both.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
}, 30000)

it.runIf(process.platform === 'darwin').each(['long', 'long-escaped'] as const)('%s original diagnostics preserve valid bounded roles through actual Provider, Core and DeliveryFailure DTO', async primaryKind => {
  const events = await consume('cancel', 2000, { public: true, primaryKind })
  const error = events.find(e => e.kind === 'delivery-dto').error
  expect(error.detail.length).toBeLessThanOrEqual(8192)
  const both = nativeDetail(error)
  expect(both.primary).toMatchObject({ code: 'ORIGINAL_FAILURE', truncated: true })
  expect(JSON.parse(both.cleanup.detail)).toEqual({ phase: 'native-cleanup', reason: 'observer-exit-unconfirmed' })
  expect(events.find(e => e.kind === 'input-writes').count).toBe(0)
}, 60000)


it.runIf(process.platform === 'darwin')('an original transport failure recorded after ready stays first when the caller later cancels an OS await', async () => {
  const events = await consume('transport-before-cancel', 0), result = events.find(e => e.kind === 'result')
  expect(result.ok).toBe(false); expect(result.sameOriginal).toBe(false)
  expect(result.error.code).toBe('AGENT_NATIVE_INPUT_UNCONFIRMED')
  expect(nativeDetail(result.error)).toEqual({ phase: 'native-rpc', reason: 'connection-closed' })
  const ordered = events.filter(e => ['ready-before-transport-close', 'observer-close', 'caller-cancel-after-transport-close', 'result'].includes(e.kind))
  expect(ordered.map(e => e.kind)).toEqual(['ready-before-transport-close', 'observer-close', 'caller-cancel-after-transport-close', 'result'])
}, 30000)

it.runIf(process.platform === 'darwin')('normal caller cancellation during the original post-ready OS await preserves its exact reason after both original children close', async () => {
  const events = await consume('cancel-after-ready-os', 0), result = events.find(e => e.kind === 'result')
  expect(result.ok).toBe(false); expect(result.sameOriginal).toBe(true); expect(result.originalUnchanged).toBe(true)
  const ordered = events.filter(e => ['ready-before-os-await', 'os-probe-created', 'caller-cancel-during-os-await', 'os-probe-close', 'result'].includes(e.kind))
  expect(ordered.map(e => e.kind)).toEqual(['ready-before-os-await', 'os-probe-created', 'caller-cancel-during-os-await', 'os-probe-close', 'result'])
  expect(events.find(e => e.kind === 'observer-close').at).toBeLessThanOrEqual(result.at)
  expect(events.find(e => e.kind === 'os-probe-retired').exit.signal).toBe('SIGTERM')
}, 30000)

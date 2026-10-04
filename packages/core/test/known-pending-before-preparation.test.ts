import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner, hostedTestFence, logicalHostedEvents } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
type Phase = 'handshake' | 'verify' | 'read' | 'none'

// Actual public Client/Coordinator/FileStore/Screen and RPC; only Runtime bytes and Provider facts are controlled.
async function fixture(phase: Phase, execution: 'default' | 'immediate' = 'immediate', memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-observation-continuity-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: 'controlled-steer', executorId: 'controlled-steer',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  const store = memory ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')); await store.compareAndSwap(null, record)
  const template = new AgentProviderRegistry().get('codex')
  let cursor = 0, output = 0, text = '', ready = true, closed = false, cols = 80, rows = 24, revision = 0
  let source = 'original-source', pid = 123, fault = '', readCount = 0, verifyCount = 0
  const nativeEvidence = { sourceId: source, id: 'idle', state: 'idle' as const }
  const verifying = defer(), reading = defer()
  let readFailure: (() => Promise<void>) | undefined
  const preparation = vi.fn(async () => { throw new Error('Direct input must not use interrupt preparation.') })
  const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'controlled-steer', capabilities: { ...template.catalog.capabilities, promptExecution: { immediate: 'native-steer' } }, hookStrategy: { kind: 'none' } },
    hook: { rules: [] }, buildArgs: (_, args) => [...args], terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
    planPromptInput: text => ({ kind: 'render-then-submit', payload: text, renderedText: text, submit: '\r' }),
    readPromptExecutionEvidence: async () => { await readFailure?.(); readCount++; if (phase === 'read') { reading.resolve(); await release.promise }
      return nativeEvidence },
    preparePromptExecutionTransport: preparation,
    verifyPromptExecutionTransport: async context => { verifyCount++; if (phase === 'verify') { verifying.resolve(); await release.promise }
      return fault !== 'verify' && context.nativeSourceId === source },
    inspectPromptExecution: snapshot => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() === '>' ? 'idle' : 'unavailable' })
  const client = new AgentMuxClient({ store, providers: [provider] }), owner = client as any
  await owner.registry.load('local'); owner.connected = true
  const entered = defer(), release = defer(), waiting = defer(), listeners: Array<(event: any) => void> = [], writes: string[] = []
  const run = () => ({ nativeService: null, lifecycleOperationId: null, runId: record.run.runId, program: 'controlled-steer', args: [], workspacePath: root, pid,
    state: { type: 'running' }, cols, rows, firstAvailableByte: 0, latestOutputBytes: output, acceptedInputBytes: cursor })
  const frame = () => Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H${ready ? '> ' + text : 'NOT_READY'}\x1b[10;${ready ? 3 + text.length : 1}H\x1b[?2026l`)
  let current = frame(); output = current.length
  const history = [{ startByte: 0, endByte: output, dataBytes: current }]
  const draw = () => { current = frame(); const startByte = output; output += current.length; history.push({ startByte, endByte: output, dataBytes: current }); for (const accept of listeners) accept({ type: 'data', runId: record.run.runId, startByte, endByte: output, dataBytes: current, data: current.toString() }) }
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'controlled-owner', protocolVersion: 18, buildIdentity: 'controlled' })
  owner.kernel.status = async () => run()
  owner.kernel.disconnect = () => {}; owner.kernel.stop = vi.fn()
  owner.kernel.resize = async (_id: string, c: number, r: number) => { cols = c; rows = r; revision++; ready = true; draw(); return { cols, rows } }
  const receipts = new Map<string, { startByte: number; endByte: number }>()
  owner.kernel.input = async (_id: string, input: { expectedByte: number; operationId: string; data: string }) => {
    const prior = receipts.get(input.operationId); if (prior) return { run: run(), appliedByteRange: prior }
    expect(input.expectedByte).toBe(cursor); writes.push(input.data)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(input.data) }; cursor = range.endByte; receipts.set(input.operationId, range)
    if (input.data === 'ORIGINAL_BODY') { text = input.data; draw() }
    if (input.data === 'ORIGINAL_BODY' && fault === 'body-ack') throw new AgentMuxError('Original payload ACK unknown.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown', { disposition: 'unknown', confirmedInputBytes: null })
    if (input.data.startsWith('\x1b[')) {
      if (fault === 'source') { source = 'other-source'; nativeEvidence.sourceId = source }
      if (fault === 'pid') pid++
      if (fault === 'cursor') cursor++
      if (fault === 'unknown') throw new AgentMuxError('Protocol ACK unknown.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown')
      if (fault === 'partial') return { run: run(), appliedByteRange: { ...range, endByte: range.endByte - 1 } }
    }
    return { run: run(), appliedByteRange: range }
  }
  let observations = 0, scans = 0
  owner.kernel.observeOutput = async (_id: string, _after: number, listener: (event: any) => void, view: string) => {
    expect(_id).toBe(record.run.runId); expect(view).toBe('terminal'); listeners.push(listener); const first = ++observations === 1
    if (first && phase === 'handshake') { entered.resolve(); await release.promise }
    const bytes = frame(), endByte = output
    if (!first) setImmediate(draw) // Controlled Runtime's natural redraw; no Core refresh/input.
    return { run: run(), resizeRevision: revision, gap: null, close: async () => {},
      terminal: !first ? { type: 'basic-vt', checkpoint: { runId: record.run.runId, throughByte: endByte, resizeRevision: revision,
        size: { cols, rows }, restoreSize: { cols, rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: bytes, resizes: [] } : { type: 'not-requested' },
      replay: !first ? [] : [...history] }
  }
  owner.kernel.replay = async () => {
    scans++
    return { run: run(), gap: null, replay: [...history] }
  }
  const request = { agentSessionId: record.agentSessionId, expectedRun: record.run, afterSubmissionId: null,
    operationId: 'original-operation', prompt: 'ORIGINAL_BODY', execution, authorHuman: true }
  const send = (signal?: AbortSignal) => client.submitAgentPrompt({ ...request, ...(signal ? { signal } : {}) })
  const resize = async (changed = false) => { await client.resizeAgent(record.agentSessionId, record.run, changed ? 100 : 80, changed ? 30 : 24); release.resolve() }
  return { client, owner, root, store, record, request, entered: entered.promise, verifying: verifying.promise, reading: reading.promise, release, send, resize, writes, draw, preparation,
    readFailure: (read: () => Promise<void>) => { readFailure = read },
    change: (value: string) => { fault = value }, statistics: () => ({ readCount, verifyCount }),
    allow: () => { ready = true }, listener: () => listeners.at(-1)!, counts: () => ({ observations, scans }),
    close: async () => { closed = true; release.resolve(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }) } }
}



function request(kind: 'permission' | 'question', run: {runId: string}) {
  const option = { id: 'allow', label: 'Allow', kind: 'allow-once' as const }
  return { request: { kind, id: 'current-request', agentSessionId: 'original-session',
    ...(kind === 'permission' ? { title: 'Current permission', options: [option] } :
      { questions: [{id:'question',prompt:'Current question',options:[{id:'yes',label:'Yes'}]}] }),
    evidence: { source: 'native-hook', observedAt: 2, run, hookReceiptId: 'current-request' } } } as NonNullable<AgentMuxStoredAgentSession['pendingInteraction']>
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, kind: 'permission' | 'question' = 'permission') {
  await f.owner.registry.update(f.record.agentSessionId, f.record.run, (state: AgentMuxStoredAgentSession) =>
    ({ ...state, pendingInteraction: request(kind, f.record.run), updatedAt: Date.now() }))
}
it.each(['permission','question'] as const)('rejects known fresh %s before native preparation, with the original queryable pending cause', async kind => {
  const f = await fixture('none')
  const screen = vi.spyOn(f.owner.screenEvidence, 'wait')
  try {
    await pending(f,kind)
    const error = await f.send().then(()=>null,error=>error)
    expect(error).toMatchObject({code:'AGENT_INTERACTION_PENDING'})
    expect(error.logId).toMatch(/^delivery-/)
    expect((await f.client.readDeliveryAttempt(error.logId))).toMatchObject({availability:'found',record:{operationId:f.request.operationId,error:{code:'AGENT_INTERACTION_PENDING'}}})
    expect(f.statistics()).toEqual({readCount:0,verifyCount:0})
    expect(screen).not.toHaveBeenCalled();expect(f.preparation).not.toHaveBeenCalled()
    expect(f.writes).toEqual([]);expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
  } finally {await f.close()}
})
it('rechecks a new pending interaction after qualification and before the ordinary composer wait',async()=>{
 const f=await fixture('none');const screen=vi.spyOn(f.owner.screenEvidence,'wait')
 let first=true
 f.readFailure(async()=>{if(first){first=false;await pending(f)}})
 try{
  const error=await f.send().then(()=>null,error=>error)
  expect(error).toMatchObject({code:'AGENT_INTERACTION_PENDING'})
  expect(f.statistics().readCount).toBe(1);expect(screen).not.toHaveBeenCalled()
  expect(f.writes).toEqual([]);expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
 }finally{await f.close()}
})
it('allows a supported new request when no interaction is pending',async()=>{
 const f=await fixture('none')
 try{await f.send();expect(f.writes).toEqual(['ORIGINAL_BODY','\r']);expect(f.statistics().readCount).toBe(1)}
 finally{await f.close()}
})
it('recovers the exact acknowledged operation during a pending interaction without preparing or writing again',async()=>{
 const f=await fixture('none')
 try{
  await f.send();const before=structuredClone(f.client.agentSession(f.record.agentSessionId).terminalPromptSubmission)
  const counts=f.statistics();await pending(f);await expect(f.send()).resolves.toBeUndefined()
  expect(f.statistics()).toEqual(counts);expect(f.writes).toEqual(['ORIGINAL_BODY','\r'])
  expect(f.client.agentSession(f.record.agentSessionId).terminalPromptSubmission).toEqual(before)
  expect(f.client.agentSession(f.record.agentSessionId).pendingInteraction?.request.id).toBe('current-request')
 }finally{await f.close()}
})
it('keeps an unknown original payload and its frozen ranges owned while a request awaits an answer',async()=>{
 const f=await fixture('none')
 try{
  f.change('body-ack');expect(await f.send().then(()=>null,error=>error)).toBeTruthy()
  const state=f.client.agentSession(f.record.agentSessionId),before=structuredClone(state.promptCompletionAdmission),submission=structuredClone(state.terminalPromptSubmission)
  const counts=f.statistics();await pending(f)
  expect(await f.send().then(()=>null,error=>error)).toMatchObject({code:'AGENT_INTERACTION_PENDING'})
  expect(f.statistics()).toEqual(counts);expect(f.writes).toEqual(['ORIGINAL_BODY'])
  expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toEqual(before)
  expect(f.client.agentSession(f.record.agentSessionId).terminalPromptSubmission).toEqual(submission)
 }finally{await f.close()}
})
it('keeps the existing default pending boundary without new bytes',async()=>{
 const f=await fixture('none','default')
 try{await pending(f);expect(await f.send().then(()=>null,error=>error)).toMatchObject({code:'AGENT_INTERACTION_PENDING'});expect(f.writes).toEqual([])}
 finally{await f.close()}
})
it('retains the final atomic pending guard after the early no-pending check',async()=>{
 const f=await fixture('none','immediate',true)
 const cas=f.store.compareAndSwap.bind(f.store);let injected=false
 f.store.compareAndSwap=async(expected,next)=>{
  if(!injected && !expected?.promptCompletionAdmission && next?.promptCompletionAdmission && expected){
   injected=true;await cas(expected,{...expected,pendingInteraction:request('permission',f.record.run),updatedAt:Date.now()})
  }
  return await cas(expected,next)
 }
 try{
  expect(await f.send().then(()=>null,error=>error)).toMatchObject({code:'AGENT_INTERACTION_PENDING'})
  expect(injected).toBe(true);expect(f.writes).toEqual([]);expect(f.client.agentSession(f.record.agentSessionId).promptCompletionAdmission).toBeUndefined()
 }finally{await f.close()}
})
it('preserves pending refusal through the actual Hosted service and public diagnostic RPC',async()=>{
 const f=await fixture('none'),server=new AgentMuxControlServer({socketPath:join(f.root,'control.sock'),coreClients:()=>[{hostId:'local',client:f.client}]})
 const service=new AgentMuxHostedRuntimeService(f.client,null,()=>hostedTestOwner(f.client))
 let rpc:Awaited<ReturnType<typeof connectAgentMuxRpc>>|undefined,subscription:Awaited<ReturnType<typeof service.subscribe>>|undefined
 try{
  await pending(f);subscription=await service.subscribe('runtime.events',{fence:hostedTestFence,consumerId:'original-consumer'},logicalHostedEvents(()=>{}));await subscription.start?.()
  const error=await service.call('runtime.invoke',{fence:hostedTestFence,consumerId:'original-consumer',invocation:{method:'submitAgentPrompt',args:[f.request]}}).then(()=>null,error=>error)
  expect(error).toMatchObject({code:'AGENT_INTERACTION_PENDING'});expect(error.logId).toMatch(/^delivery-/)
  await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  expect(await rpc.call('message.delivery.inspect',{hostId:'local',logId:error.logId})).toEqual(await f.client.readDeliveryAttempt(error.logId))
  const cli=await runCompiledObjectCli(['--endpoint','unix://'+server.path,'message','delivery','inspect','--host-id','local','--logid',error.logId],objectCliEnvironment(f.root))
  expect(cli.code,cli.stderr).toBe(0);expect(cli.stderr).toBe('')
  expect(JSON.parse(cli.stdout).result).toEqual(await f.client.readDeliveryAttempt(error.logId))
  expect(f.writes).toEqual([]);expect(f.statistics().readCount).toBe(0)
 }finally{await rpc?.dispose();await server.stop();await subscription?.dispose();await service.dispose();await f.close()}
})

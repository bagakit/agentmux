import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TerminalRecoveryOwner } from '../src/terminal-recovery-owner.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxPreparedTerminal } from '../src/terminal-preparation.js'
import type { AgentMuxRun } from '../src/types.js'
import { fixture as preparedAgentFixture, core as preparedCore, cleanups as preparedCleanups } from './helpers/prepared-resume-fixture.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
const source = { runtimeId: 'persistent-native', instanceId: 'first-serving-owner', buildIdentity: 'private-build', protocolVersion: 23 }
const prepared = (cwd: string, id = 'initial-original'): AgentMuxPreparedTerminal => ({ createOperationId: id, workspacePath: cwd,
  launch: JSON.stringify({ createOperationId: id, request: { program: '/bin/cat', args: [], cwd, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: id, PRIVATE_PROOF: 'never-public' }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) })
const run = (cwd: string, state: AgentMuxRun['state'] = 'running'): AgentMuxRun => ({ runId: 'original-run', state, workspacePath: cwd, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
  pid: 123, cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null })
async function fixture() {
  const root = await mkdtemp('/tmp/tic-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let current = source, retained: AgentMuxRun | null = null, retired = false, frozen: AgentMuxPreparedTerminal | null = null
  const port = { runtime: () => current, original: vi.fn(async () => null), prepare: vi.fn(async (id: string, cwd: string) => prepared(cwd, id)),
    start: vi.fn(async (value: AgentMuxPreparedTerminal) => { frozen = value; return retained = run(value.workspacePath) }), inspect: vi.fn(async () => retained),
    inspectCreation: vi.fn(async () => retained && frozen ? { prepared: frozen, runtime: current, run: retained } : null), notice: vi.fn(),
    retire: vi.fn(async () => retained ? { runtime: current, outcome: 'retained' as const, run: retained } : (retired = true, { runtime: current, outcome: 'retired' as const })),
    observeRetirement: vi.fn(async () => ({ runtime: current, outcome: retired ? 'retired' as const : 'not_retired' as const })) }
  Object.assign(port,{assertNoAgentKey:vi.fn(async()=>{}),retireKey:vi.fn(async()=>retained?{runtime:current,outcome:'retained',prepared:frozen!,run:retained}:(retired=true,{runtime:current,outcome:'retired'})),observeRetirementKey:vi.fn(async()=>({runtime:current,outcome:retired?'retired':'not_retired'}))})
  const directory = join(root, 'terminal-recoveries'), owner = () => new TerminalRecoveryOwner(directory, port as any)
  return { root, directory, port, owner, setRun: (value: AgentMuxRun | null, valuePrepared?: AgentMuxPreparedTerminal) => { retained = value; if (valuePrepared) frozen = valuePrepared }, setRuntime: (value: typeof source) => { current = value } }
}
it('initial pending Start survives SDK rejection and a reconstructed owner without catalog ordering or replay', async () => {
  const f = await fixture(), value = prepared(f.root), owner = f.owner()
  f.port.start.mockRejectedValueOnce(Error('Controlled Core Start reply unavailable; Native admission remains pending'))
  await expect(owner.createInitial(value)).rejects.toThrow('unavailable')
  expect(await owner.retainedExecutionDirectories()).toEqual([f.root])
  const cold = f.owner(), before = f.port.start.mock.calls.length
  expect(await cold.inspectInitial(value.createOperationId)).toMatchObject({ known: true, admission: { phase: 'dispatched', run: null, observation: { availability: 'not-observed' }, diskDurability: 'unconfirmed' } })
  await expect(cold.createInitial(value)).rejects.toThrow('not submitted again')
  expect(f.port.start).toHaveBeenCalledTimes(before)
  expect(await cold.retainedExecutionDirectories()).toEqual([f.root])
  f.setRun(run(f.root), value)
  expect(await cold.inspectInitial(value.createOperationId)).toMatchObject({ admission: { phase: 'published', run: { runId: 'original-run' } } })
  expect(await cold.retainedExecutionDirectories()).toEqual([])
  expect(JSON.stringify(await cold.inspectInitial(value.createOperationId))).not.toContain('never-public')
})
it.each(['member', 'namespace'])('cold initial %s loss keeps the durable original admission and cannot create again', async lost => {
  const f = await fixture(), value = prepared(f.root)
  f.port.start.mockRejectedValueOnce(Error('reply lost'))
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  if (lost === 'namespace') await rm(f.directory, { recursive: true })
  else for (const file of await readdir(f.directory)) if (file.endsWith('.initial.json')) await rm(join(f.directory, file))
  const cold = f.owner()
  expect(await cold.retainedExecutionDirectories()).toEqual([f.root])
  expect(await cold.inspectInitial(value.createOperationId)).toMatchObject({ known: true, admission: { phase: 'unconfirmed' } })
  await expect(cold.createInitial(value)).rejects.toThrow()
  expect(f.port.start).toHaveBeenCalledOnce()
})
it('published and retired tombstones hand off cwd without replaying or losing a legitimate exited result', async () => {
  const f = await fixture(), value = prepared(f.root), owner = f.owner()
  expect(await owner.createInitial(value)).toMatchObject({ runId: 'original-run' })
  expect(await owner.retainedExecutionDirectories()).toEqual([])
  f.setRun(run(f.root, 'exited'), value)
  expect(await f.owner().createInitial(value)).toMatchObject({ runId: 'original-run', state: 'exited' })
  f.setRun(null)
  await expect(f.owner().createInitial(value)).rejects.toThrow('not submitted again')
  expect(await owner.retireInitialPrepared(value, source)).toMatchObject({ outcome: 'retired' })
  expect(await owner.retainedExecutionDirectories()).toEqual([])
  await expect(f.owner().createInitial(value)).rejects.toMatchObject({ code: 'CTXMUX_creation_retired' })
  expect(f.port.start).toHaveBeenCalledOnce()
})
it('initial preparation keeps literal newline cwd and rejects a changed same-key preparation before another Start', async () => {
  const f = await fixture(), value = prepared(join(f.root, 'newline\nback\\slash'))
  await mkdir(value.workspacePath)
  expect(await f.owner().createInitial(value)).toMatchObject({ workspacePath: value.workspacePath })
  await expect(f.owner().createInitial(prepared(f.root))).rejects.toMatchObject({ code: 'TERMINAL_INITIAL_CREATION_CONFLICT' })
  expect(f.port.start).toHaveBeenCalledOnce()
})
it.each(['instanceId', 'buildIdentity', 'protocolVersion'] as const)('initial dispatch rechecks %s after durable admission in the original Client', async field => {
  const f = await fixture(), client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')), controlSocketPath: join(f.root, 'control.sock') })
  cleanup.push(() => client.dispose())
  const inner = client as any, kernel = inner.kernel
  inner.connected = true
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  let identity = source
  vi.spyOn(kernel, 'creationRuntimeIdentity').mockImplementation(() => identity)
  const start = vi.spyOn(kernel, 'startPrepared').mockImplementation(async () => ({ ...run(f.root), lifecycleOperationId: 'initial-original', program: '/bin/cat', args: [], firstAvailableByte: 0, state: { type: 'running' } }) as any)
  const owner = inner.terminalRecoveryOwner(), save = owner.saveInitial.bind(owner)
  vi.spyOn(owner, 'saveInitial').mockImplementationOnce(async (record: unknown) => { await save(record); identity = { ...source, [field]: field === 'protocolVersion' ? source.protocolVersion + 1 : 'changed' } })
  await expect(client.createPreparedTerminal(prepared(f.root))).rejects.toMatchObject({ code: 'TERMINAL_INITIAL_RUNTIME_CHANGED' })
  expect(start).not.toHaveBeenCalled()
  expect(await owner.retainedExecutionDirectories()).toEqual([f.root])
})
it('handoff write failure keeps the obtained Run, owner ACK custody and original Core diagnostic without replay', async () => {
  const f = await fixture(), owner = f.owner() as any, save = owner.saveInitial.bind(owner), value = prepared(f.root)
  vi.spyOn(owner, 'saveInitial').mockImplementation(async (record: any) => { if (record.phase === 'published') throw Error('Private handoff write failed'); await save(record) })
  expect(await owner.createInitial(value)).toMatchObject({ runId: 'original-run', state: 'running' })
  expect(f.port.notice).toHaveBeenCalledOnce()
  expect(await owner.retainedExecutionDirectories()).toEqual([f.root])
  expect(await owner.inspectInitial(value.createOperationId)).toMatchObject({ admission: { run: { runId: 'original-run' }, diskDurability: 'unconfirmed' } })
  expect(f.port.start).toHaveBeenCalledOnce()
  const stored = JSON.parse(await readFile(join(f.directory, (await readdir(f.directory)).find(x => x.endsWith('.initial.json'))!), 'utf8'))
  expect(stored.phase).toBe('dispatched')
})
it('the original Core handoff diagnostic is consumed as a Terminal observation notice without changing healthy Run facts', async () => {
  const f = await fixture(), client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')), controlSocketPath: join(f.root, 'control.sock') })
  cleanup.push(() => client.dispose())
  const inner = client as any, kernel = inner.kernel
  inner.connected = true
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'creationRuntimeIdentity').mockReturnValue(source)
  vi.spyOn(kernel, 'startPrepared').mockResolvedValue({ ...run(f.root), lifecycleOperationId: 'initial-original', program: '/bin/cat', args: [], firstAvailableByte: 0, state: { type: 'running' } } as any)
  const owner = inner.terminalRecoveryOwner(), save = owner.saveInitial.bind(owner), events: any[] = []
  client.onEvent(event => events.push(event))
  vi.spyOn(owner, 'saveInitial').mockImplementation(async (record: any) => { if (record.phase === 'published') throw Error('Controlled storage failure after Native ACK'); await save(record) })
  const original = await client.createPreparedTerminal(prepared(f.root))
  expect(original).toMatchObject({ runId: 'original-run', state: 'running' })
  const diagnostic = events.find(event => event.type === 'agent-error' && event.code === 'TERMINAL_CREATION_SAVE_UNCONFIRMED')
  expect(diagnostic).toMatchObject({ evidence: { source: 'agentmux', run: { runId: original.runId } } })
  expect(diagnostic.agentSessionId).toBeUndefined()
  const { runtimeDiagnosticNotice } = await import('../../../apps/desktop/src/renderer/src/lib/session-state.js')
  const control = { kind: 'terminal', hostId: 'local', run: { runId: original.runId } }
  const notice = runtimeDiagnosticNotice({ sessions: [{ id: 'original-terminal-view', kind: 'terminal', hostId: 'local', label: 'Original Terminal', processState: 'running', control } as any] }, { hostId: 'local', event: diagnostic })
  expect(notice?.subject).toEqual(control)
  expect(notice?.message).toContain('this creation handoff save observation was unconfirmed')
  expect(notice?.message).toContain('Last confirmed Run state: running')
  expect(inner.connected).toBe(true)
})
it('cold directory projection filters exact marker cwd before loading an unrelated opaque launch', async () => {
  const f = await fixture(), owner = f.owner() as any
  f.port.start.mockRejectedValueOnce(Error('pending'))
  await expect(owner.createInitial(prepared(f.root))).rejects.toThrow()
  const read = vi.spyOn(owner, 'readInitial')
  expect(await owner.retainedExecutionDirectories(async () => false)).toEqual([])
  expect(read).not.toHaveBeenCalled()
})
it('a completed old publication cannot erase a queued retirement ACK or combine it with another phase and writer confirmation', async () => {
  const f = await fixture(), owner = f.owner() as any, value = prepared(f.root), save = owner.saveInitial.bind(owner)
  let releaseA!: () => void, releaseB!: () => void, enteredA = false, enteredB = false
  const a = new Promise<void>(r => { releaseA = r }), b = new Promise<void>(r => { releaseB = r })
  vi.spyOn(owner, 'saveInitial').mockImplementation(async (record: any) => {
    if (record.phase === 'published') { enteredA = true; await a }
    if (record.phase === 'retired') { enteredB = true; await b }
    await save(record)
  })
  const first = owner.createInitial(value)
  await vi.waitFor(() => expect(enteredA).toBe(true))
  f.setRun(null)
  const retirement = owner.retireInitialPrepared(value, source)
  try {
    await vi.waitFor(() => expect(owner.initialObserved.get(value.createOperationId)?.phase).toBe('retired'))
    releaseA(); await first
    await vi.waitFor(() => expect(enteredB).toBe(true))
    vi.spyOn(f.port, 'runtime').mockImplementation(() => { throw Error('private Native now offline') })
    const observed = await owner.inspectInitial(value.createOperationId)
    expect(observed).toMatchObject({ admission: { phase: 'retired', run: null, observation: { availability: 'unavailable' }, diskDurability: 'unconfirmed' } })
    // The new original retirement record already holds its exact Native fence, independently of B's pending initial-member save.
    expect(await owner.retainedExecutionDirectories()).toEqual([])
    const { parseTerminalCreationInspection } = await import('../src/terminal-creation.js')
    expect(parseTerminalCreationInspection(observed, { hostId: 'local', operationId: value.createOperationId })).toEqual(observed)
    expect(() => parseTerminalCreationInspection({ ...observed, admission: { ...observed.admission, phase: 'published' } }, { hostId: 'local', operationId: value.createOperationId })).toThrow()
    expect(() => parseTerminalCreationInspection({ ...observed, admission: { ...observed.admission, workspacePath: '' } }, { hostId: 'local', operationId: value.createOperationId })).toThrow()
  } finally { releaseA(); releaseB(); await Promise.allSettled([first, retirement]) }
  expect(await owner.retainedExecutionDirectories()).toEqual([])
  expect(f.port.start).toHaveBeenCalledOnce()
})
it('retirement is admitted once, a lost ACK is only observed after owner reconstruction, and an empty old witness never becomes a new action', async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner()
  f.port.start.mockRejectedValueOnce(Error('unknown Start'))
  await expect(owner.createInitial(value)).rejects.toThrow()
  const keyRetire=(f.port as any).retireKey
  const real=keyRetire.getMockImplementation()
  keyRetire.mockImplementationOnce(async(...args:any[])=>{await real(...args);throw Error('actual retirement ACK lost')})
  expect(await owner.retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{phase:'retired',retirement:{native:{outcome:'retired'}}}})
  expect(await f.owner().retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{phase:'retired'}})
  expect(keyRetire).toHaveBeenCalledOnce();expect(await owner.retainedExecutionDirectories()).toEqual([])
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  expect(f.port.start).toHaveBeenCalledOnce()
  const g=await fixture(),other=prepared(g.root),admission=new (await import('../src/native-creation-admission.js')).NativeCreationAdmission(g.root)
  g.port.start.mockRejectedValueOnce(Error('unknown'))
  await expect(g.owner().createInitial(other)).rejects.toThrow()
  const {writeFile}=await import('node:fs/promises');await writeFile(admission.retirementPath(other.createOperationId),'')
  await expect(g.owner().retireInitial(other.createOperationId,source.runtimeId)).rejects.toThrow()
  expect((g.port as any).retireKey).not.toHaveBeenCalled()
})
it('an offline new retirement does not publish a claim or activate Native; old SDK retirement prevents a later initial Start without inventing an initial admission',async()=>{
  const f=await fixture(),value=prepared(f.root)
  f.port.start.mockRejectedValueOnce(Error('unknown'))
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  const runtime=vi.spyOn(f.port,'runtime').mockImplementation(()=>{throw Error('Native offline')})
  await expect(f.owner().retireInitial(value.createOperationId,source.runtimeId)).rejects.toThrow('offline')
  expect((await readdir(f.root)).some(x=>x.endsWith('.claim'))).toBe(false)
  runtime.mockRestore()
  const g=await fixture(),legacy=prepared(g.root,'historical-sdk-key')
  expect(await g.owner().retireInitialPrepared(legacy,source)).toMatchObject({outcome:'retired'})
  expect(await g.owner().inspectInitial(legacy.createOperationId)).toMatchObject({known:false})
  await expect(g.owner().createInitial(legacy)).rejects.toThrow('retirement admission')
  expect(g.port.start).not.toHaveBeenCalled();expect((g.port as any).retireKey).toHaveBeenCalledOnce()
})
it('a pending Agent reservation excludes raw retirement before any Native Run exists',async()=>{
  const f=await fixture(),store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')}),inner=client as any,value=prepared(f.root,'colliding-pending-agent')
  await inner.registry.reserveNew('original-agent',value.createOperationId)
  f.port.start.mockRejectedValueOnce(Error('raw Start could not obtain the reserved key'))
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  ;(f.port as any).assertNoAgentKey=async(key:string)=>{if(await store.agentCreationKeyRole(key)==='agent')throw Error('original Agent key')}
  const before=await readFile(join(f.root,'sessions.json'))
  await expect(f.owner().retireInitial(value.createOperationId,source.runtimeId)).rejects.toThrow('Agent key')
  expect((f.port as any).retireKey).not.toHaveBeenCalled();expect(await readFile(join(f.root,'sessions.json'))).toEqual(before)
})
it.each(['agent-first','raw-first'] as const)('the original key admission serializes %s without Native waits inside the lock or a Store writer self-wait',async(order)=>{
  const f=await fixture(),store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')}),inner=client as any,value=prepared(f.root,'racing-original-key')
  await store.load()
  f.port.start.mockRejectedValueOnce(Error('pending'))
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  ;(f.port as any).assertNoAgentKey=async(key:string)=>{if(await store.agentCreationKeyRole(key)==='agent')throw Error('original Agent key')}
  let release!:()=>void,entered=false;const gate=new Promise<void>(r=>{release=r})
  const write=vi.spyOn(store,'reserveLifecycle')
  if(order==='agent-first') {
    const original=Object.getPrototypeOf(store).reserveLifecycle.bind(store)
    write.mockImplementation(async r=>{entered=true;await gate;return await original(r)})
    const agent=inner.registry.reserveNew('race-agent',value.createOperationId)
    await vi.waitFor(()=>expect(entered).toBe(true))
    const raw=f.owner().retireInitial(value.createOperationId,source.runtimeId)
    release();await agent
    await expect(raw).rejects.toThrow('Agent key');expect((f.port as any).retireKey).not.toHaveBeenCalled()
  } else {
    ;(f.port as any).assertNoAgentKey=async(key:string)=>{expect(await store.agentCreationKeyRole(key)).toBe('unclaimed');entered=true;await gate}
    const raw=f.owner().retireInitial(value.createOperationId,source.runtimeId)
    await vi.waitFor(()=>expect(entered).toBe(true))
    const agent=inner.registry.reserveNew('race-agent',value.createOperationId).then((value:any)=>({value,error:null}),(error:any)=>({error}))
    release();await raw
    expect((await agent).error).toMatchObject({code:'NATIVE_CREATION_KEY_RETIRED'})
    expect(write).not.toHaveBeenCalled();expect(await store.readLifecycleReservation('race-agent')).toBeNull()
  }
})
it.each(['create','resume','restart','reopen','handoff'] as const)('the real Client %s adoption refuses a retired key before its original Store writer',async kind=>{
  const f=await fixture(),store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'));await store.load()
  const client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')}),registry=(client as any).registry,key='already-retiring-key',sid='original-agent',ref={runId:'healthy-agent-run'}
  const admission=new (await import('../src/native-creation-admission.js')).NativeCreationAdmission(f.root)
  const {writeFile}=await import('node:fs/promises');await writeFile(admission.retirementPath(key),'')
  const session:any={kind:'agent',agentSessionId:sid,providerId:'codex',executorId:'codex',hostId:'local',workspacePath:f.root,run:ref,retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1}
  registry.sessions.set(sid,session)
  const reserve=vi.spyOn(store,'reserveLifecycle'),handoff=vi.spyOn(store,'handoffResumeResolution')
  vi.spyOn(store,'loadRetiredAgentSessions').mockResolvedValue([{agentSessionId:sid,observedAt:12} as any])
  const call=kind==='create'?()=>registry.reserveNew(sid,key):kind==='resume'?()=>registry.reserveExisting('resume',sid,ref,key):kind==='restart'?()=>registry.reserveRestart(sid,ref,key,{}):kind==='reopen'?()=>registry.reserveReopen(sid,12,key,'original-reopen'):
    ()=>registry.handoffResumeResolution({kind:'resume',agentSessionId:sid,expectedRun:ref},session,{prepared:prepared(f.root,key)},source)
  await expect(call()).rejects.toMatchObject({code:'NATIVE_CREATION_KEY_RETIRED'})
  expect(reserve).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();expect(await store.readLifecycleReservation(sid)).toBeNull()
})
it('old authoritative Agent keys win over a fake raw claim, while a custom Store without the optional predicate keeps normal adoption and Stop',async()=>{
  const f=await fixture(),store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')}),registry=(client as any).registry
  await registry.reserveNew('original-agent','old-agent-key')
  const admission=new (await import('../src/native-creation-admission.js')).NativeCreationAdmission(f.root),{writeFile}=await import('node:fs/promises')
  await writeFile(admission.retirementPath('old-agent-key'),'')
  const write=vi.spyOn(store,'reserveLifecycle').mockResolvedValue(undefined)
  Object.defineProperty(store,'agentCreationKeyRole',{value:undefined,configurable:true})
  await expect(registry.reserveNew('original-agent','old-agent-key')).resolves.toMatchObject({kind:'create',operationId:'old-agent-key'})
  await expect(registry.reserveNew('another-agent','unrelated-new-key')).resolves.toMatchObject({kind:'create'})
  const ref={runId:'healthy-existing-run'}
  registry.sessions.set('original-agent',{agentSessionId:'original-agent',run:ref})
  await writeFile(admission.retirementPath('ordinary-stop-key'),'')
  await expect(registry.reserveExisting('stop','original-agent',ref,'ordinary-stop-key',{daemonInstance:'original-native',operationKey:'ordinary-stop-key',runId:ref.runId})).resolves.toMatchObject({kind:'stop'})
  expect(write).toHaveBeenCalledTimes(3)
  ;(f.port as any).assertNoAgentKey=async()=>{throw Error('custom Store has no exact key predicate')}
  await expect(f.owner().retireInitialPrepared(prepared(f.root,'unsupported-raw-retirement'),source)).rejects.toThrow('no exact key predicate')
  expect((f.port as any).retireKey).not.toHaveBeenCalled()
})
it('the original Native wait holds neither the key admission lock nor the unrelated key',async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner();f.port.start.mockRejectedValueOnce(Error('unknown'))
  await expect(owner.createInitial(value)).rejects.toThrow()
  let release!:()=>void,entered=false;const gate=new Promise<void>(r=>{release=r}),retire=(f.port as any).retireKey,actual=retire.getMockImplementation()
  retire.mockImplementationOnce(async()=>{entered=true;await gate;return {runtime:source,outcome:'retired'}})
  const pending=owner.retireInitial(value.createOperationId,source.runtimeId)
  try {
    await vi.waitFor(()=>expect(entered).toBe(true))
    const admission=new (await import('../src/native-creation-admission.js')).NativeCreationAdmission(f.root)
    expect(await admission.locked(value.createOperationId,async()=>true)).toBe(true)
    const other=await owner.createInitial(prepared(f.root,'unrelated-key'))
    expect(other.state).toBe('running')
  } finally {release();await pending}
})
it.each(['memory','file'] as const)('the %s original metadata owner recognizes active and retired Agent creation keys without loading cumulative history',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore,agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js'),{AgentMuxAgentSessionRegistry}=await import('../src/agent-session-registry.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'))
  const session:any={kind:'agent',agentSessionId:'metadata-agent',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:f.root,run:{runId:'original-agent-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1,creation:{createOperationId:'original-caller-key',initialPrompt:'not-requested'}}
  const key=agentLifecycleOperationIdentity('create',session.agentSessionId,session.creation.createOperationId)
  await store.compareAndSwap(null,session)
  const full=vi.spyOn(store,'load'),history=vi.spyOn(store,'loadRetiredAgentSessions')
  expect(await store.agentCreationKeyRole(key)).toBe('agent');expect(await store.agentCreationKeyRole(key,'another-agent')).toBe('unclaimed')
  expect(await store.agentCreationKeyRole('unrelated-key')).toBe('unknown')
  expect(full).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled()
  const registry=new AgentMuxAgentSessionRegistry(store);await registry.load('local')
  const stop=await registry.reserveExisting('stop',session.agentSessionId,session.run,'original-stop',{daemonInstance:source.instanceId,operationKey:'original-stop',runId:session.run.runId})
  await registry.commitLifecycle(stop,null)
  const reader=kind==='file'?new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')):store
  expect(await reader.agentCreationKeyRole(key)).toBe('agent')
})
it.each(['not_applied','unknown'] as const)('the original structured %s Start failure survives reconstruction independently of the immutable admission identity',async disposition=>{
  const f=await fixture(),value=prepared(f.root),{AgentMuxError}=await import('../src/errors.js')
  const error=new AgentMuxError('Controlled exact Native failure envelope','CTXMUX_original_failure')
  // Use the actual typed Error property, not its human-readable message.
  Object.defineProperty(error,'creationFailure',{value:{operationId:value.createOperationId,disposition}})
  f.port.start.mockRejectedValueOnce(error)
  await expect(f.owner().createInitial(value)).rejects.toBe(error)
  expect(await f.owner().inspectInitial(value.createOperationId)).toMatchObject({admission:{phase:'dispatched',startFailure:{operationId:value.createOperationId,disposition}}})
  expect(await f.owner().retainedExecutionDirectories()).toEqual([f.root])
})
it('lost retirement members and a cold Core never readmit the original action; a later exact Native fence restores its own thin record',async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner();f.port.start.mockRejectedValueOnce(Error('unknown Start'))
  await expect(owner.createInitial(value)).rejects.toThrow()
  ;(f.port as any).retireKey.mockRejectedValueOnce(Error('retirement outcome unknown'))
  expect(await owner.retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{retirement:{native:null}}})
  await rm(f.directory,{recursive:true})
  const cold=f.owner()
  expect(await cold.retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{phase:'unconfirmed',retirement:{native:null,diskDurability:'unconfirmed'}}})
  expect((f.port as any).retireKey).toHaveBeenCalledOnce();expect(await cold.retainedExecutionDirectories()).toEqual([f.root])
  ;(f.port as any).observeRetirementKey.mockResolvedValue({runtime:source,outcome:'retired'})
  expect(await cold.inspectInitial(value.createOperationId)).toMatchObject({admission:{phase:'retired',retirement:{native:{outcome:'retired'}}}})
  expect(await cold.retainedExecutionDirectories()).toEqual([])
  expect((f.port as any).retireKey).toHaveBeenCalledOnce();expect(f.port.start).toHaveBeenCalledOnce()
})
it('the pre-effect Native observation does not hold the original key lock and the subsequent Agent role recheck still protects a new reservation',async()=>{
  const f=await fixture(),store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'));await store.load()
  const client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')}),registry=(client as any).registry,value=prepared(f.root,'outside-native-observation')
  f.port.start.mockRejectedValueOnce(Error('unknown'))
  await expect(f.owner().createInitial(value)).rejects.toThrow()
  let release!:()=>void,entered=false,saved=false;const gate=new Promise<void>(r=>{release=r})
  f.port.inspectCreation.mockImplementationOnce(async()=>{entered=true;await gate;return null})
  ;(f.port as any).assertNoAgentKey=async(key:string)=>{if(await store.agentCreationKeyRole(key)==='agent')throw Error('Agent adopted during Native observation')}
  const raw=f.owner().retireInitial(value.createOperationId,source.runtimeId).then(value=>({value,error:null}),error=>({error}))
  try {
    await vi.waitFor(()=>expect(entered).toBe(true))
    const adoption=registry.reserveNew('original-agent',value.createOperationId).then(()=>{saved=true},error=>({error}))
    await vi.waitFor(()=>expect(saved).toBe(true))
    release();await adoption
    expect((await raw).error?.message).toContain('Agent adopted')
    expect((f.port as any).retireKey).not.toHaveBeenCalled()
  } finally {release();await raw}
})
it('missing or partial prior retirement claims cannot borrow an older member writer ACK to dispatch another action',async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner() as any
  expect(await owner.retireInitialPrepared(value,source)).toMatchObject({outcome:'retired'})
  const path=new (await import('../src/native-creation-admission.js')).NativeCreationAdmission(f.root).retirementPath(value.createOperationId)
  await rm(path)
  expect(await owner.retireInitialPrepared(value,source)).toMatchObject({outcome:'retired'})
  expect((f.port as any).retireKey).toHaveBeenCalledOnce()
  await rm(f.directory,{recursive:true})
  vi.spyOn(f.port,'runtime').mockImplementation(()=>{throw Error('Native now offline')})
  await expect(owner.retireInitialPrepared(value,source)).rejects.toThrow('unconfirmed')
  expect((f.port as any).retireKey).toHaveBeenCalledOnce()
})
it('the old SDK captures its exact Runtime argument before any admission await',async()=>{
  const f=await fixture(),owner=f.owner() as any,value=prepared(f.root),runtime={...source},read=owner.readInitialMarker.bind(owner)
  let release!:()=>void,entered=false;const gate=new Promise<void>(r=>{release=r})
  vi.spyOn(owner,'readInitialMarker').mockImplementationOnce(async(id:string)=>{entered=true;await gate;return await read(id)})
  const action=owner.retireInitialPrepared(value,runtime)
  await vi.waitFor(()=>expect(entered).toBe(true));runtime.runtimeId='caller-mutated-after-submission';release()
  expect(await action).toMatchObject({outcome:'retired',runtime:source})
  expect((f.port as any).retireKey).toHaveBeenCalledWith(value.createOperationId,source)
})
it('a post-Native retirement save that has not quiesced returns its exact retained ACK with owner custody and an accurate service window',async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner() as any,original=await owner.createInitial(value),write=owner.writeRetirement.bind(owner)
  let release!:()=>void,entered=false;const gate=new Promise<void>(r=>{release=r})
  vi.spyOn(owner,'writeRetirement').mockImplementation(async(id:string,image:string)=>{
    if(JSON.parse(image).native?.outcome==='retained'){entered=true;await gate}
    await write(id,image)
  })
  const action=owner.retireInitialPrepared(value,source)
  try {
    await vi.waitFor(()=>expect(entered).toBe(true))
    const result=await action
    expect(result).toMatchObject({outcome:'retained',run:{runId:original.runId,state:'running'}})
    expect(owner.retirementWrites.size).toBe(1)
    expect(f.port.notice).toHaveBeenCalledWith(value.createOperationId,expect.objectContaining({runId:original.runId}),expect.any(Number),'retirement')
    const inspected=await owner.inspectInitial(value.createOperationId)
    expect(inspected).toMatchObject({admission:{run:{runId:original.runId},retirement:{native:{outcome:'retained'},diskDurability:'unconfirmed'}}})
    expect((f.port as any).retireKey).toHaveBeenCalledOnce();expect(f.port.start).toHaveBeenCalledOnce()
  } finally {release();await action}
  await vi.waitFor(()=>expect(owner.retirementWrites.size).toBe(0))
  expect(await owner.inspectInitial(value.createOperationId)).toMatchObject({admission:{retirement:{diskDurability:'confirmed'}}})
},15000)
it.each(['memory','file'] as const)('the %s original reservation, resume, Stop and generic reopen producers preserve every private key across cold reads',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore,agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js'),{AgentMuxAgentSessionRegistry}=await import('../src/agent-session-registry.js'),{cloneSession}=await import('../src/agent-session-identity.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),registry=new AgentMuxAgentSessionRegistry(store)
  const sid='full-lifecycle-agent',keys:string[]=[]
  const key=(type:'create'|'resume'|'reopen',id:string)=>{const value=agentLifecycleOperationIdentity(type,sid,id);keys.push(value);return value}
  let current:any={kind:'agent',agentSessionId:sid,providerId:'generic-native',executorId:'generic-native',hostId:'local',workspacePath:f.root,run:{runId:'first-native-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1,creation:{createOperationId:'first-create',createdRun:{runId:'first-native-run'},initialPrompt:'not-requested'}}
  current={...current,capabilityHash:'private-capability-hash',creation:{...current.creation,intentDigest:'a'.repeat(64)}}
  const creation=await registry.reserveNew(sid,key('create','first-create')), {run:_run,retiredRuns:_runs,...seed}=current, {createdRun:_createdRun,...creationIntent}=current.creation
  const prepared=await registry.prepareCreate(creation,{...seed,creation:creationIntent})
  await registry.commitLifecycle(prepared,current)
  expect((await store.readMetadata(sid))?.nativeCreationKeys).toEqual({keys:[...keys],coverage:'complete'})
  for(let index=0;index<2;index++) {
    const old=current,operation=key('resume',`resume-${index}`),reservation=await registry.reserveExisting('resume',sid,old.run,operation)
    current={...old,run:{runId:`resumed-${index}`},retiredRuns:[...old.retiredRuns,old.run],updatedAt:index+2}
    await registry.commitLifecycle(reservation,current)
  }
  for(let index=0;index<2;index++) {
    const stop=await registry.reserveExisting('stop',sid,current.run,`stop-${index}`,{daemonInstance:source.instanceId,operationKey:`stop-${index}`,runId:current.run.runId})
    await registry.commitLifecycle(stop,null)
    const retired=await store.readRetiredAgentSession(sid)
    expect(retired?.nativeCreationKeys).toEqual({keys:[...keys],coverage:'complete'})
    const operation=key('reopen',`generic-reopen-${index}`),reservation=await registry.reserveReopen(sid,retired!.observedAt,operation,`generic-reopen-${index}`)
    const first={runId:'first-native-run'},closed=retired!.run
    current={...current,run:{runId:`reopened-${index}`},retiredRuns:[...(closed.runId===first.runId?[]:[first]),closed],reopenedFrom:{run:closed,source:retired!.source,observedAt:retired!.observedAt},updatedAt:index+5}
    // No managed nativeActor or continuity is synthesized for the generic Provider.
    await registry.commitLifecycle(reservation,current)
  }
  const finalStop=await registry.reserveExisting('stop',sid,current.run,'final-stop',{daemonInstance:source.instanceId,operationKey:'final-stop',runId:current.run.runId})
  await registry.commitLifecycle(finalStop,null)
  const retired=await store.readRetiredAgentSession(sid)
  expect(retired?.nativeCreationKeys).toEqual({keys:[...keys],coverage:'complete'})
  const reader=kind==='file'?new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')):store
  for(const value of keys)expect(await reader.agentCreationKeyRole(value)).toBe('agent')
  expect(cloneSession({...current,nativeCreationKeys:retired!.nativeCreationKeys})).not.toHaveProperty('nativeCreationKeys')
  expect((await reader.readHistorySource(sid))?.history).not.toHaveProperty('nativeCreationKeys')
})
it.each(['memory','file'] as const)('the %s original Store keeps legacy and unbound sources unknown and ignores incoming role claims during ordinary CAS',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore}=await import('../src/agent-session-store.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'))
  const session:any={kind:'agent',agentSessionId:'legacy-private',providerId:'generic',executorId:'generic',hostId:'local',workspacePath:f.root,run:{runId:'legacy-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1,nativeCreationKeys:{keys:['caller-invented'],coverage:'complete'}}
  await store.compareAndSwap(null,session)
  expect((await store.readMetadata(session.agentSessionId))?.nativeCreationKeys).toBeUndefined()
  expect(await store.agentCreationKeyRole('caller-invented')).toBe('unknown')
  await store.retireRuns([{runId:'original-unbound-agent'}])
  expect(await store.agentCreationKeyRole('another-opaque-key')).toBe('unknown')
})
it.each(['memory','file'] as const)('the %s canonical keys survive old-reader CAS and cannot be replaced or upgraded by incoming metadata',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore}=await import('../src/agent-session-store.js'),{AgentMuxAgentSessionRegistry}=await import('../src/agent-session-registry.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),registry=new AgentMuxAgentSessionRegistry(store),sid='canonical-key-agent'
  const session:any={kind:'agent',agentSessionId:sid,providerId:'generic',executorId:'generic',hostId:'local',workspacePath:f.root,run:{runId:'canonical-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1}
  await registry.commitLifecycle(await registry.reserveNew(sid,'original-canonical-key'),session)
  const canonical=(await store.readMetadata(sid))!,{nativeCreationKeys:_private,...oldReader}=canonical
  await store.compareAndSwap(oldReader,{...oldReader,updatedAt:2,nativeCreationKeys:{keys:['incoming-forged-key'],coverage:'complete'}})
  const saved=(await store.readMetadata(sid))!
  expect(saved.nativeCreationKeys).toEqual({keys:['original-canonical-key'],coverage:'complete'})
  const {nativeCreationKeys:_privateAgain,...oldMetadata}=saved
  await store.compareAndSwapMetadata(oldMetadata,{...oldMetadata,updatedAt:3,nativeCreationKeys:{keys:['other-forged-key'],coverage:'partial'}})
  expect((await store.readMetadata(sid))?.nativeCreationKeys).toEqual(canonical.nativeCreationKeys)
  expect(await store.agentCreationKeyRole('incoming-forged-key')).toBe('unclaimed')
})
it.each(['memory','file'] as const)('an isolated %s Store with only original unbound Agent Run facts never grants a creation-key negative',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore}=await import('../src/agent-session-store.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'))
  await store.retireRuns([{runId:'unbound-original-agent-run'}])
  expect(await store.readMetadata('absent-session')).toBeNull()
  expect(await store.agentCreationKeyRole('unattributed-opaque-key')).toBe('unknown')
})
it('the actual private Native resume resolution hands the first and successor keys into canonical metadata without upgrading legacy coverage',async()=>{
  const f=await preparedAgentFixture()
  f.start.mockRejectedValueOnce(Error('Controlled missing original Native Start ACK'))
  await expect(f.resume()).rejects.toMatchObject({code:'AGENT_RESUME_UNCONFIRMED'})
  const original=(await f.correlation())!
  const result=await f.client.ensureAgentContinuity({agentSessionId:f.previous.agentSessionId,expectedRun:f.previous.run,operationId:'native-key-resolution',trigger:'manual',args:f.request.args,env:f.request.env,policy:{reminderMode:'default',continuationEnabled:true}})
  expect(result.kind).toBe('resumed')
  const {agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js'),next=agentLifecycleOperationIdentity('resume',f.previous.agentSessionId,'native-key-resolution')
  const current=await f.store.readMetadata(f.previous.agentSessionId)
  expect(current?.nativeCreationKeys).toEqual({keys:[original.operationId,next],coverage:'partial'})
  expect(await f.store.agentCreationKeyRole(original.operationId)).toBe('agent')
  expect(await f.store.agentCreationKeyRole(next)).toBe('agent')
  expect(await f.store.agentCreationKeyRole('legacy-negative-cannot-be-proven')).toBe('unknown')
  expect(await f.client.readAgentSession(f.previous.agentSessionId)).not.toHaveProperty('nativeCreationKeys')
  if(result.kind==='resumed')await f.write(result.session)
},25000)
it('the actual Native Stop producer keeps its exact superseded-resume key readable from a legacy-shaped retirement before a raw fence',async()=>{
  const f=await preparedAgentFixture()
  f.start.mockRejectedValueOnce(Error('Controlled unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({code:'AGENT_RESUME_UNCONFIRMED'})
  const original=(await f.correlation())!
  await f.client.stopAgent(f.previous.agentSessionId,f.previous.run,{operationId:'native-key-stop'})
  const retired=await f.store.readRetiredAgentSession(f.previous.agentSessionId)
  expect(retired?.stop?.supersededResume?.lifecycleOperationId).toBe(original.operationId)
  await f.client.dispose()
  // Only remove the new private collection in this private fixture to model the
  // previously shipped retirement shape. The exact Stop fact came from Native.
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.store.path)
  try {db.prepare("UPDATE retired_sessions SET json=json_remove(json,'$.nativeCreationKeys') WHERE id=?").run(f.previous.agentSessionId)}finally{db.close()}
  const cold=new AgentMuxFileAgentSessionStore(f.store.path)
  expect(await cold.agentCreationKeyRole(original.operationId)).toBe('agent')
  expect(await cold.agentCreationKeyRole('unproven-key')).toBe('unknown')
},25000)
it('one malformed private fact preserves the actual Agent load, input and Stop, but cannot authorize a raw creation fence',async()=>{
  const f=await preparedAgentFixture(),resumed=await f.resume()
  await f.client.dispose()
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.store.path)
  try {db.prepare("UPDATE sessions SET json=json_set(json,'$.nativeCreationKeys',json(?)) WHERE id=?").run(JSON.stringify({keys:'unsupported-shape',coverage:'complete'}),f.previous.agentSessionId)}finally{db.close()}
  const cold=await f.reader(),readFact=()=>{
    const db=new DatabaseSync(f.store.path);try{return db.prepare("SELECT json_extract(json,'$.nativeCreationKeys') AS fact FROM sessions WHERE id=?").get(f.previous.agentSessionId)?.fact}finally{db.close()}
  }
  const before=readFact()
  expect(await cold.client.readAgentSession(f.previous.agentSessionId)).toMatchObject({agentSessionId:f.previous.agentSessionId,run:resumed.run})
  expect(await cold.client.readAgentSession(f.previous.agentSessionId)).not.toHaveProperty('nativeCreationKeys')
  await expect(cold.store.agentCreationKeyRole('unproved-raw-key')).rejects.toMatchObject({code:'AGENT_CREATION_ROLE_UNCONFIRMED'})
  expect(readFact()).toEqual(before)
  const pending=await cold.client.prepareTerminal({createOperationId:'malformed-fact-pending-raw',workspacePath:f.root,command:'/bin/cat'})
  cold.start.mockRejectedValueOnce(Error('Controlled pending raw Start'))
  await expect(cold.client.createPreparedTerminal(pending)).rejects.toThrow('pending raw')
  const retirement=vi.spyOn(cold.inner.kernel,'retireOriginalCreationKey')
  await expect(cold.client.retireTerminalCreation({hostId:'local',operationId:pending.createOperationId,runtimeId:cold.client.terminalCreationRuntimeIdentity().runtimeId})).rejects.toMatchObject({code:'AGENT_CREATION_ROLE_UNCONFIRMED'})
  expect(retirement).not.toHaveBeenCalled()
  const raw=await cold.client.createTerminal({createOperationId:'healthy-raw-amid-malformed',workspacePath:f.root,command:'/bin/cat'})
  await expect(cold.client.retireTerminalCreation({hostId:'local',operationId:'healthy-raw-amid-malformed',runtimeId:cold.client.terminalCreationRuntimeIdentity().runtimeId})).rejects.toMatchObject({code:'AGENT_CREATION_ROLE_UNCONFIRMED'})
  Object.defineProperty(cold.store,'agentCreationKeyRole',{value:undefined,configurable:true})
  await expect(cold.client.retireTerminalCreation({hostId:'local',operationId:'healthy-raw-amid-malformed',runtimeId:cold.client.terminalCreationRuntimeIdentity().runtimeId})).rejects.toMatchObject({code:'AGENT_CREATION_ROLE_UNCONFIRMED'})
  delete (cold.store as any).agentCreationKeyRole
  expect(retirement).not.toHaveBeenCalled()
  await cold.client.writeTerminalBytes({runId:raw.runId},'raw-input-remains-available')
  const server=new preparedCore.AgentMuxControlServer({socketPath:join(f.root,'public.sock'),coreClients:()=>[{hostId:'local',client:cold.client}]})
  await server.start();preparedCleanups.push(()=>server.stop())
  const {objectCliEnvironment,runCompiledObjectCli}=await import('./helpers/object-cli-rpc.js')
  const result=await runCompiledObjectCli(['agent','inspect','--session',f.previous.agentSessionId],objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:`unix:${join(f.root,'public.sock')}`}))
  expect(result.code,result.stderr).toBe(0);expect(result.stdout).not.toContain('nativeCreationKeys')
  await f.write(resumed,cold)
  await cold.client.stopAgent(f.previous.agentSessionId,resumed.run,{operationId:'still-available-stop'})
  expect(await cold.store.readRetiredAgentSession(f.previous.agentSessionId)).toMatchObject({run:resumed.run})
},25000)
it.each(['memory','file'] as const)('the %s complete create→unknown K1→resolution K2→Stop takeover keeps every adopted key after a cold retirement',async owner=>{
  const f=await preparedAgentFixture('positional-argv',false,owner),{agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js')
  const sid='complete-takeover-agent',first=agentLifecycleOperationIdentity('create',sid,'complete-create'),reservation=await f.inner.registry.reserveNew(sid,first)
  const native=await f.inner.kernel.start({operationKey:first,program:process.execPath,args:['-e','process.exit(0)'],cwd:f.root,env:{AGENTMUX_LIFECYCLE_OPERATION_ID:first}})
  await vi.waitFor(async()=>expect((await f.inner.kernel.status(native.runId)).state.type).toBe('exited'))
  const session={...f.previous,agentSessionId:sid,run:{runId:native.runId},hookBindingId:'complete-binding',hookToken:'complete-token',nativeHandle:{...f.previous.nativeHandle,sessionId:'complete-private-native'},creation:{createOperationId:'complete-create',createdRun:{runId:native.runId},initialPrompt:'not-requested'}}
  await f.inner.registry.commitLifecycle(reservation,session)
  const k1=agentLifecycleOperationIdentity('resume',sid,'unknown-first'),k2=agentLifecycleOperationIdentity('resume',sid,'unknown-second')
  f.start.mockRejectedValueOnce(Error('controlled unknown K1'))
  await expect(f.client.resumeAgent({...f.request,agentSessionId:sid,operationId:'unknown-first'})).rejects.toMatchObject({code:'AGENT_RESUME_UNCONFIRMED'})
  f.start.mockRejectedValueOnce(Error('controlled unknown K2'))
  await f.client.ensureAgentContinuity({agentSessionId:sid,expectedRun:session.run,operationId:'unknown-second',trigger:'manual',args:f.request.args,env:f.request.env,policy:{reminderMode:'default',continuationEnabled:true}})
  expect((await f.store.readMetadata(sid))?.nativeCreationKeys).toEqual({keys:[first,k1,k2],coverage:'complete'})
  const pending=await f.store.readLifecycleReservation(sid)
  expect(pending?.nativeCreationKeys).toEqual({keys:[first,k1,k2],coverage:'complete'})
  await f.client.stopAgent(sid,session.run,{operationId:'complete-takeover-stop'})
  const cold=owner==='file'?new AgentMuxFileAgentSessionStore(f.store.path):f.store
  expect((await cold.readRetiredAgentSession(sid))?.nativeCreationKeys).toEqual({keys:[first,k1,k2],coverage:'complete'})
  for(const key of [first,k1,k2])expect(await cold.agentCreationKeyRole(key)).toBe('agent')
},25000)
it.each(['array','scalar'] as const)('matching malformed %s private keys cannot authorize same-SID restart through a prior raw retirement claim',async shape=>{
  const f=await preparedAgentFixture(),running=await f.resume(),{agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js')
  await f.client.dispose()
  const op='malformed-matching-restart',key=agentLifecycleOperationIdentity('restart',running.agentSessionId,op),{DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.store.path)
  try {db.prepare("UPDATE sessions SET json=json_set(json,'$.nativeCreationKeys',json(?)) WHERE id=?").run(JSON.stringify({keys:shape==='array'?[key]:key,coverage:'unsupported'}),running.agentSessionId)}finally{db.close()}
  const {NativeCreationAdmission}=await import('../src/native-creation-admission.js'),{dirname}=await import('node:path'),{writeFile}=await import('node:fs/promises')
  await writeFile(new NativeCreationAdmission(dirname(f.store.path)).retirementPath(key),'original-existing-claim')
  const cold=await f.reader(),start=vi.spyOn(cold.inner.kernel,'startPrepared'),stop=vi.spyOn(cold.inner.kernel,'stop')
  await expect(cold.client.restartAgent({agentSessionId:running.agentSessionId,expectedRun:running.run,operationId:op,args:f.request.args,env:f.request.env})).rejects.toMatchObject({code:'AGENT_CREATION_ROLE_UNCONFIRMED'})
  expect(start).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
  expect((await cold.inner.kernel.status(running.run.runId)).state.type).toBe('running')
  await f.write(running,cold)
},25000)
it('a cold retained initial retirement ACK cannot be turned into a fresh retirement when its other two materials are missing',async()=>{
  const f=await fixture(),value=prepared(f.root),owner=f.owner()
  f.port.start.mockRejectedValueOnce(Error('unknown'))
  await expect(owner.createInitial(value)).rejects.toThrow()
  expect(await owner.retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{phase:'retired'}})
  for(const name of await readdir(f.root))if(name.startsWith('terminal-retirement-admission-'))await rm(join(f.root,name))
  for(const name of await readdir(f.directory))if(name.endsWith('.retirement.json'))await rm(join(f.directory,name))
  const cold=f.owner()
  expect(await cold.retireInitial(value.createOperationId,source.runtimeId)).toMatchObject({admission:{phase:'retired'}})
  expect((f.port as any).retireKey).toHaveBeenCalledOnce()
  expect(await cold.retainedExecutionDirectories()).toEqual([])
  const store=new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json'));await store.load()
  const client=new AgentMuxClient({store,controlSocketPath:join(f.root,'control.sock')})
  // Reconciliation may have rebuilt a thin result; remove it again to isolate
  // the original initial retired fact as the new-adoption witness.
  for(const name of await readdir(f.directory))if(name.endsWith('.retirement.json'))await rm(join(f.directory,name))
  await expect((client as any).registry.reserveNew('new-agent',value.createOperationId)).rejects.toMatchObject({code:'NATIVE_CREATION_KEY_RETIRED'})
  expect(await store.readLifecycleReservation('new-agent')).toBeNull()
})
it('a real reopen request with a new conflicting retirement key is refused before its original lifecycle writer and Start',async()=>{
  const {retiredReopenFixture}=await import('./fixtures/retired-reopen.js'),f=await retiredReopenFixture();cleanup.push(f.close)
  const {agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js'),{NativeCreationAdmission}=await import('../src/native-creation-admission.js'),{dirname}=await import('node:path'),{writeFile}=await import('node:fs/promises')
  const key=agentLifecycleOperationIdentity('reopen',f.input.agentSessionId,f.input.operationId)
  await writeFile(new NativeCreationAdmission(dirname(f.storePath)).retirementPath(key),'original-existing-claim')
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({code:'NATIVE_CREATION_KEY_RETIRED'})
  expect(f.starts).toEqual([]);expect(f.stops).toEqual([])
})
it('the actual resolution handoff cannot adopt a conflicting successor key even after it obtained the original Native fence',async()=>{
  const f=await preparedAgentFixture(),{NativeCreationAdmission}=await import('../src/native-creation-admission.js'),{dirname}=await import('node:path'),{writeFile}=await import('node:fs/promises')
  f.start.mockRejectedValueOnce(Error('Controlled original unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({code:'AGENT_RESUME_UNCONFIRMED'})
  const original=(await f.correlation())!,handoff=f.inner.registry.handoffResumeResolution.bind(f.inner.registry),write=vi.spyOn(f.store,'handoffResumeResolution')
  vi.spyOn(f.inner.registry,'handoffResumeResolution').mockImplementationOnce(async(...args:any[])=>{
    await writeFile(new NativeCreationAdmission(dirname(f.store.path)).retirementPath(args[2].prepared.createOperationId),'original-existing-claim')
    return await handoff(...args)
  })
  const result=await f.client.ensureAgentContinuity({agentSessionId:f.previous.agentSessionId,expectedRun:f.previous.run,operationId:'conflicting-real-handoff',trigger:'manual',args:f.request.args,env:f.request.env,policy:{reminderMode:'default',continuationEnabled:true}})
  expect(result.kind).not.toBe('resumed')
  expect(write).not.toHaveBeenCalled()
  expect((await f.correlation())?.operationId).toBe(original.operationId)
  expect(f.start).toHaveBeenCalledOnce();expect(f.stop).not.toHaveBeenCalled()
},25000)
it.each(['memory','file'] as const)('the %s original release transfers adopted keys before removing a temporary reservation',async kind=>{
  const f=await fixture(),{AgentMuxMemoryAgentSessionStore}=await import('../src/agent-session-store.js'),{AgentMuxAgentSessionRegistry}=await import('../src/agent-session-registry.js')
  const store=kind==='memory'?new AgentMuxMemoryAgentSessionStore():new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')),registry=new AgentMuxAgentSessionRegistry(store),sid='released-native-key-agent'
  const session:any={kind:'agent',agentSessionId:sid,providerId:'generic',executorId:'generic',hostId:'local',workspacePath:f.root,run:{runId:'original-agent-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'token',createdAt:1,updatedAt:1}
  await registry.commitLifecycle(await registry.reserveNew(sid,'original-created-key'),session)
  const pending=await registry.reserveExisting('resume',sid,session.run,'known-not-applied-key')
  await registry.releaseLifecycle(pending)
  const reader=kind==='file'?new AgentMuxFileAgentSessionStore(join(f.root,'sessions.json')):store
  expect((await reader.readMetadata(sid))?.nativeCreationKeys).toEqual({keys:['original-created-key','known-not-applied-key'],coverage:'complete'})
  expect(await reader.agentCreationKeyRole('known-not-applied-key')).toBe('agent')
})
it('ordinary metadata writing cannot launder strings from an invalid private packet into owned restart authority',async()=>{
  const f=await preparedAgentFixture(),running=await f.resume(),{agentLifecycleOperationIdentity}=await import('../src/agent-session-store.js')
  await f.client.dispose()
  const op='not-owned-after-ordinary-write',key=agentLifecycleOperationIdentity('restart',running.agentSessionId,op),{DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.store.path)
  try {db.prepare("UPDATE sessions SET json=json_set(json,'$.nativeCreationKeys',json(?)) WHERE id=?").run(JSON.stringify({keys:[key],coverage:'unsupported'}),running.agentSessionId)}finally{db.close()}
  const cold=await f.reader(),current=await cold.store.readMetadata(running.agentSessionId)
  await cold.store.compareAndSwapMetadata(current,{...current,updatedAt:current.updatedAt+1})
  expect((await cold.store.readMetadata(running.agentSessionId))?.nativeCreationKeys).toEqual({keys:[],coverage:'partial'})
  const {NativeCreationAdmission}=await import('../src/native-creation-admission.js'),{dirname}=await import('node:path'),{writeFile}=await import('node:fs/promises')
  await writeFile(new NativeCreationAdmission(dirname(f.store.path)).retirementPath(key),'original-existing-claim')
  const stop=vi.spyOn(cold.inner.kernel,'stop')
  await expect(cold.client.restartAgent({agentSessionId:running.agentSessionId,expectedRun:running.run,operationId:op,args:f.request.args,env:f.request.env})).rejects.toMatchObject({code:'NATIVE_CREATION_KEY_RETIRED'})
  expect(stop).not.toHaveBeenCalled();expect((await cold.inner.kernel.status(running.run.runId)).state.type).toBe('running')
  await f.write(running,cold)
},25000)

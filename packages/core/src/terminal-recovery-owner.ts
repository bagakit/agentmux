import { createHash } from 'node:crypto'
import { mkdir, open, readFile, opendir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { rpcRecord } from './rpc-data.js'
import { parsePreparedTerminal, type AgentMuxPreparedTerminal } from './terminal-preparation.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime, type AgentMuxTerminalCreationRetirement, type AgentMuxTerminalCreationRetirementObservation } from './terminal-creation-retirement.js'
import { parseTerminalRecoveryInput, type AgentMuxTerminalRecoveryInput, type AgentMuxTerminalRecoveryResult } from './terminal-recovery.js'
import { decodePreparedRun } from './prepared-run.js'
import { agentCreationIntentDigest } from './agent-creation-authority.js'
import { parseRawTerminalRun } from './terminal-observation.js'
import { NativeCreationAdmission } from './native-creation-admission.js'
import { parseTerminalCreationInspection, type TerminalCreationInspection, type TerminalCreationRetirement } from './terminal-creation.js'
import type { AgentMuxRun, AgentMuxRunRef } from './types.js'

type Intent = {
  schemaVersion: 1; expectedRun: AgentMuxRunRef; runtimeId: string; workspacePath: string; operationId: string
  prepared: AgentMuxPreparedTerminal; phase: 'prepared' | 'dispatched' | 'retained' | 'not_applied'
  run: AgentMuxRunRef | null; continuedBy: string[]; retirement: AgentMuxCreationRuntime | null
  retiredAttempts: Array<{ prepared: AgentMuxPreparedTerminal; runtime: AgentMuxCreationRuntime; continuationOperationId: string }>
}
type Port = {
  directoryAdmission?<T>(cwd: string, write: () => Promise<T>): Promise<T>
  runtime(): AgentMuxCreationRuntime
  assertNoAgentKey(key: string, rawRetained: boolean): Promise<void>
  agentCreationKeyRole?(key: string): Promise<'agent' | 'unclaimed' | 'unknown'>
  retireKey(key:string,runtime:AgentMuxCreationRuntime): Promise<{runtime:AgentMuxCreationRuntime}&({outcome:'retired'}|{outcome:'retained';prepared:AgentMuxPreparedTerminal;run:AgentMuxRun})>
  observeRetirementKey(key:string,runtime:AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirementObservation>
  /** Confirms raw ownership from durable Core bindings and exact Native status. */
  original(input: AgentMuxTerminalRecoveryInput): Promise<AgentMuxRun | null>
  prepare(operationId: string, workspacePath: string): Promise<AgentMuxPreparedTerminal>
  start(prepared: AgentMuxPreparedTerminal, initialRuntime?: AgentMuxCreationRuntime): Promise<AgentMuxRun>
  inspectCreation(operationId: string): Promise<{ prepared: AgentMuxPreparedTerminal; runtime: AgentMuxCreationRuntime; run: AgentMuxRun } | null>
  notice(operationId: string, run: AgentMuxRun, observedAt: number, stage?: 'retirement'): void
  inspect(prepared: AgentMuxPreparedTerminal, ref?: AgentMuxRunRef): Promise<AgentMuxRun | null>
  retire(prepared: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirement>
  observeRetirement(prepared: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirementObservation>
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const failure = (message: string) => new AgentMuxError(message + ' The original work surface and healthy Runs are retained.', 'TERMINAL_RECOVERY_UNCONFIRMED')
function parseHostRecoveryInput(value: unknown): AgentMuxTerminalRecoveryInput {
  const input = parseTerminalRecoveryInput(value)
  if (!isAbsolute(input.workspacePath)) throw new AgentMuxError('Terminal recovery requires the original Host\'s absolute execution directory.', 'INVALID_CONTROL_REQUEST')
  return input
}
function parseIntent(value: unknown): Intent {
  const r = rpcRecord(value, ['schemaVersion', 'expectedRun', 'runtimeId', 'workspacePath', 'operationId', 'prepared', 'phase', 'run', 'continuedBy', 'retirement', 'retiredAttempts'])
  parseHostRecoveryInput({ expectedRun: r.expectedRun, runtimeId: r.runtimeId, workspacePath: r.workspacePath, operationId: r.operationId })
  const prepared = parsePreparedTerminal(r.prepared)
  if (r.schemaVersion !== 1 || prepared.workspacePath !== r.workspacePath || !['prepared', 'dispatched', 'retained', 'not_applied'].includes(String(r.phase)) ||
      !Array.isArray(r.continuedBy) || r.continuedBy.some(id => typeof id !== 'string' || !id || /[\0\r\n]/u.test(id)) || new Set(r.continuedBy).size !== r.continuedBy.length) throw failure('The original terminal recovery intent is invalid.')
  if (r.run !== null && (typeof rpcRecord(r.run, ['runId']).runId !== 'string' || !rpcRecord(r.run).runId) || r.phase === 'retained' && r.run === null) throw failure('The retained replacement Run is unconfirmed.')
  if (r.retirement !== null) parseCreationRuntime(r.retirement)
  if (r.phase === 'not_applied' && r.retirement === null) throw failure('The original creation has no confirmed Native retirement fence.')
  if (!Array.isArray(r.retiredAttempts)) throw failure('The original creation fence history is unconfirmed.')
  for (const value of r.retiredAttempts) {
    const old = rpcRecord(value, ['prepared', 'runtime', 'continuationOperationId'])
    if (parsePreparedTerminal(old.prepared).workspacePath !== r.workspacePath || parseCreationRuntime(old.runtime).runtimeId !== r.runtimeId ||
        typeof old.continuationOperationId !== 'string' || !r.continuedBy.includes(old.continuationOperationId)) throw failure('The original creation fence identity changed.')
  }
  return structuredClone(r) as Intent
}

type InitialMarker = { schemaVersion: 1; kind: 'initial-terminal-start'; createOperationId: string; workspacePath: string; preparedDigest: string; runtime: AgentMuxCreationRuntime }
type InitialRecord = InitialMarker & { phase: 'dispatched' | 'published' | 'retired'; prepared: AgentMuxPreparedTerminal | null; run: AgentMuxRun | null; startFailure?:NonNullable<TerminalCreationInspection['admission']>['startFailure'] }
const initialDigest = (prepared: AgentMuxPreparedTerminal) => agentCreationIntentDigest({ createOperationId: prepared.createOperationId, ...decodePreparedRun(prepared).request })
function initialMarker(value: unknown): InitialMarker {
  const r = rpcRecord(value, ['schemaVersion', 'kind', 'createOperationId', 'workspacePath', 'preparedDigest', 'runtime'])
  if (r.schemaVersion !== 1 || r.kind !== 'initial-terminal-start' || [r.createOperationId, r.workspacePath].some(v => typeof v !== 'string' || !v || v.includes('\0')) ||
    typeof r.preparedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(r.preparedDigest)) throw failure('The original initial Terminal admission is unconfirmed.')
  return { ...r, runtime: parseCreationRuntime(r.runtime) } as InitialMarker
}
function initialRecord(value: unknown): InitialRecord {
  const r = rpcRecord(value, ['schemaVersion', 'kind', 'createOperationId', 'workspacePath', 'preparedDigest', 'runtime', 'phase', 'prepared', 'run', 'startFailure'])
  const { phase, prepared, run, startFailure, ...identity } = r, marker = initialMarker(identity)
  if (!['dispatched', 'published', 'retired'].includes(String(phase))) throw failure('The original initial Terminal phase is unconfirmed.')
  if (prepared !== null && (parsePreparedTerminal(prepared).workspacePath !== marker.workspacePath || parsePreparedTerminal(prepared).createOperationId !== marker.createOperationId || initialDigest(prepared as AgentMuxPreparedTerminal) !== marker.preparedDigest)) throw failure('The original frozen Terminal preparation changed.')
  if (phase === 'dispatched' && prepared === null || phase === 'published' && run === null || phase === 'retired' && run !== null) throw failure('The original Terminal result is incomplete.')
  if (run !== null && parseRawTerminalRun(run, String(rpcRecord(run).runId)).workspacePath !== marker.workspacePath) throw failure('The original Terminal Run changed its directory.')
  if(startFailure!==undefined) { const f=rpcRecord(startFailure,['operationId','disposition','code','observedAt']); if(f.operationId!==marker.createOperationId || !['not_applied','unknown'].includes(String(f.disposition)) || typeof f.code!=='string' || !f.code || typeof f.observedAt!=='number') throw failure('The original Start failure fact changed.') }
  return structuredClone({ ...marker, phase, prepared, run, ...(startFailure?{startFailure}:{}) }) as InitialRecord
}

/** Private Host material only. No frozen environment enters the spatial graph or public receipt. */
export class TerminalRecoveryOwner {
  // Only this Core writer's confirmed content digest, never historical JSON or launch environment.
  private readonly initialImages = new Map<string, string>()
  private readonly initialObserved = new Map<string, InitialRecord>()
  private readonly initialWrites = new Map<string, Promise<void>>()
  private readonly initialUnconfirmed = new Map<string, number>()
  private initialVersion = 0
  private readonly retirementObserved = new Map<string,TerminalCreationRetirement>()
  private readonly retirementImages = new Map<string,string>()
  private readonly retirementWrites = new Map<string,Promise<void>>()
  private readonly admission: NativeCreationAdmission
  constructor(private readonly directory: string, private readonly port: Port, admission?: NativeCreationAdmission) { this.admission=admission??new NativeCreationAdmission(dirname(directory),directory) }

  private initialHash(id: string): string { return createHash('sha256').update(id).digest('hex') }
  private initialPath(id: string): string { return join(this.directory, this.initialHash(id) + '.initial.json') }
  private initialMarkerPath(id: string): string { return join(dirname(this.directory), 'terminal-start-admission-' + this.initialHash(id) + '.lock') }
  private markerOf(record: InitialRecord): InitialMarker { const { phase: _phase, prepared: _prepared, run: _run, startFailure: _failure, ...marker } = record; return marker }
  private sameInitial(marker: InitialMarker, prepared: AgentMuxPreparedTerminal, runtime?: AgentMuxCreationRuntime): void {
    if (marker.createOperationId !== prepared.createOperationId || marker.workspacePath !== prepared.workspacePath || marker.preparedDigest !== initialDigest(prepared) || runtime && marker.runtime.runtimeId !== runtime.runtimeId)
      throw new AgentMuxError('This request differs from the original initial Terminal key, preparation or Runtime.', 'TERMINAL_INITIAL_CREATION_CONFLICT')
  }
  private async readInitialMarker(id: string): Promise<InitialMarker | null> {
    try {
      const marker = initialMarker(JSON.parse(await readFile(this.initialMarkerPath(id), 'utf8')))
      if (marker.createOperationId !== id) throw failure('The initial admission answers another key.')
      return marker
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async readInitial(id: string, marker: InitialMarker): Promise<InitialRecord | null> {
    try {
      const record = initialRecord(JSON.parse(await readFile(this.initialPath(id), 'utf8')))
      if (agentCreationIntentDigest(this.markerOf(record)) !== agentCreationIntentDigest(marker)) throw failure('The original initial Terminal member changed identity.')
      return record
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async initialLock<T>(id: string, work: (handle: Awaited<ReturnType<typeof open>>, fresh: boolean) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 })
    let fresh = false
    const handle = await open(this.initialMarkerPath(id), 'wx+', 0o600).then(h => { fresh = true; return h }, error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return open(this.initialMarkerPath(id), 'r+', 0o600)
    })
    try {
      if (!native.tryLock(handle.fd)) throw failure('The original initial Terminal admission is completing; inspect the same key.')
      return await work(handle, fresh)
    } finally { await handle.close() }
  }
  private async ensureMemberDirectory():Promise<void> {
    if(await mkdir(this.directory,{recursive:true,mode:0o700})) {
      const base=await open(dirname(this.directory),'r');try{await base.sync()}finally{await base.close()}
    }
  }
  private async saveInitial(record: InitialRecord): Promise<void> {
    await this.ensureMemberDirectory()
    initialRecord(record)
    const image = JSON.stringify(record) + '\n'
    await durableWriteFile(this.initialPath(record.createOperationId), image, { mode: 0o600, requireDirectorySync: true })
    this.initialImages.set(record.createOperationId, this.initialHash(image))
  }
  private async settleInitial(marker: InitialMarker, phase: 'published' | 'retired', run: AgentMuxRun | null): Promise<void> {
    const id = marker.createOperationId, observed: InitialRecord = { ...marker, phase, prepared: null, run }
    const version = ++this.initialVersion
    this.initialObserved.set(id, observed); this.initialUnconfirmed.set(id, version)
    const writing = (this.initialWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.initialLock(id, async (_handle, fresh) => {
      if (fresh) throw failure('The original admission marker disappeared; no replacement was authorized.')
      const original = await this.readInitialMarker(id)
      if (!original || agentCreationIntentDigest(original) !== agentCreationIntentDigest(marker)) throw failure('The original initial admission changed before settlement.')
      const current = await this.readInitial(id, marker)
      if (current?.phase === 'retired' && phase === 'published') {
        if (this.initialUnconfirmed.get(id) === version) { this.initialObserved.delete(id); this.initialUnconfirmed.delete(id) }
        return
      }
      await this.saveInitial(observed)
      if (this.initialUnconfirmed.get(id) === version) this.initialUnconfirmed.delete(id)
      if (this.initialObserved.get(id) === observed) this.initialObserved.delete(id)
    }))
    this.initialWrites.set(id, writing)
    let notified = false
    const notice = () => { if (run && !notified) { notified = true; try { this.port.notice(id, run, Date.now()) } catch { /* Auxiliary reporting cannot revoke the obtained Native Run. */ } } }
    void writing.catch(notice).finally(() => { if (this.initialWrites.get(id) === writing) this.initialWrites.delete(id) })
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([writing, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(failure('The original handoff save observation is unconfirmed.')), 5000) })]) }
    catch { notice() }
    finally { if (timer) clearTimeout(timer) }
  }
  /** Initial SDK dispatch. A previous key can only observe; it never submits Start again. */
  async createInitial(value: AgentMuxPreparedTerminal, expectedInstanceId?: string): Promise<AgentMuxRun> {
    const prepared = parsePreparedTerminal(value), runtime = this.port.runtime(), id = prepared.createOperationId
    if (expectedInstanceId !== undefined && runtime.instanceId !== expectedInstanceId)
      throw new AgentMuxError('The project Native instance changed before the prepared Start. No Start was submitted.', 'TERMINAL_INITIAL_RUNTIME_CHANGED')
    const admitted = await this.admission.locked(id, async()=>{
      if(await this.admission.hasRetirement(id) && !await this.readInitialMarker(id)) throw failure('This key already has an explicit retirement admission; no new Start was authorized.')
      return await this.initialLock(id, async (handle, fresh) => {
      if (!fresh) {
        const marker = await this.readInitialMarker(id)
        if (!marker) throw failure('The initial admission marker is unavailable.')
        this.sameInitial(marker, prepared, runtime); return { marker, dispatched: false }
      }
      let previous: InitialRecord | null = null
      try { previous = initialRecord(JSON.parse(await readFile(this.initialPath(id), 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const marker: InitialMarker = previous ? this.markerOf(previous) : { schemaVersion: 1, kind: 'initial-terminal-start', createOperationId: id,
        workspacePath: prepared.workspacePath, preparedDigest: initialDigest(prepared), runtime }
      await handle.writeFile(JSON.stringify(marker) + '\n'); await handle.sync()
      const base = await open(dirname(this.directory), 'r'); try { await base.sync() } finally { await base.close() }
      this.sameInitial(marker, prepared, runtime)
      if (previous) return { marker, dispatched: false }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const parent = await open(dirname(this.directory), 'r'); try { await parent.sync() } finally { await parent.close() }
      await this.saveInitial({ ...marker, phase: 'dispatched', prepared, run: null })
      return { marker, dispatched: true }
      })
    })
    if (!admitted.dispatched) {
      const record = await this.readInitial(id, admitted.marker)
      if (record?.phase === 'retired') throw new AgentMuxError('The original Terminal creation key is permanently retired.', 'CTXMUX_creation_retired')
      const observed = await this.inspectInitialPrepared(prepared)
      if (observed) return observed
      throw failure('The original initial Start has no confirmed Run; it was not submitted again.')
    }
    let run:AgentMuxRun
    try {run=await this.port.start(prepared,runtime)} catch(error) {
      if(error instanceof AgentMuxError && error.creationFailure?.operationId===id) {
        const startFailure={operationId:id,disposition:error.creationFailure.disposition,code:error.code,observedAt:Date.now()}
        try {await this.initialLock(id,async()=>{const record=await this.readInitial(id,admitted.marker);if(record?.phase==='dispatched') await this.saveInitial({...record,startFailure})})} catch { /* The original Start error remains authoritative; no replay follows a save failure. */ }
      }
      throw error
    }
    await this.settleInitial(admitted.marker, 'published', run)
    return run
  }
  async inspectInitialPrepared(value: AgentMuxPreparedTerminal, ref?: AgentMuxRunRef): Promise<AgentMuxRun | null> {
    const prepared = parsePreparedTerminal(value), marker = await this.readInitialMarker(prepared.createOperationId)
    if (marker) this.sameInitial(marker, prepared)
    const runtime = this.port.runtime()
    if (marker && runtime.runtimeId !== marker.runtime.runtimeId) throw failure('The prepared Terminal belongs to another persistent Runtime.')
    const run = await this.port.inspect(prepared, ref)
    if (marker && run) await this.settleInitial(marker, 'published', run)
    return run
  }
  async retireInitialPrepared(value: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirement> {
    const prepared=parsePreparedTerminal(value),ownedRuntime=parseCreationRuntime(runtime),marker=await this.readInitialMarker(prepared.createOperationId)
    if(marker) this.sameInitial(marker,prepared,ownedRuntime)
    const identity=marker??{schemaVersion:1 as const,kind:'initial-terminal-start' as const,createOperationId:prepared.createOperationId,workspacePath:prepared.workspacePath,preparedDigest:initialDigest(prepared),runtime:ownedRuntime}
    const result=await this.retireOriginal(identity)
    if(result?.native) return result.native
    throw failure('The original retirement outcome is unconfirmed; inspect its original key without repeating the action.')
  }
  private retirementPath(id:string):string{return this.admission.retirementMemberPath(id)}
  private async retirementClaim(marker:InitialMarker):Promise<{marker:InitialMarker;dispatchRuntime:AgentMuxCreationRuntime}|null> {
    try {
      const r=rpcRecord(JSON.parse(await readFile(this.admission.retirementPath(marker.createOperationId),'utf8')),['marker','dispatchRuntime'])
      const original=initialMarker(r.marker),dispatchRuntime=parseCreationRuntime(r.dispatchRuntime)
      if(agentCreationIntentDigest(original)!==agentCreationIntentDigest(marker)||dispatchRuntime.runtimeId!==marker.runtime.runtimeId) throw failure('The original retirement admission identity changed.')
      return {marker:original,dispatchRuntime}
    } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
  }
  private async writeRetirement(id: string, image: string): Promise<void> {
    await this.ensureMemberDirectory()
    await durableWriteFile(this.retirementPath(id), image, { mode: 0o600, requireDirectorySync: true })
  }
  private async saveRetirement(id: string, value: TerminalCreationRetirement): Promise<boolean> {
    const record = structuredClone({ ...value, diskDurability: 'unconfirmed' as const }), image = JSON.stringify(record) + '\n'
    this.retirementObserved.set(id, record)
    const writing = (this.retirementWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.writeRetirement(id, image)
      this.retirementImages.set(id, this.initialHash(image))
      if (this.retirementObserved.get(id) === record) this.retirementObserved.delete(id)
    })
    this.retirementWrites.set(id, writing)
    let notified = false
    const notice = () => {
      if (record.native?.outcome === 'retained' && !notified) {
        notified = true
        try { this.port.notice(id, record.native.run, Date.now(), 'retirement') } catch { /* Reporting cannot revoke the original Native fact. */ }
      }
    }
    void writing.catch(notice).finally(() => { if (this.retirementWrites.get(id) === writing) this.retirementWrites.delete(id) })
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([writing.then(() => true, () => { notice(); return false }), new Promise<false>(resolve => {
        timer = setTimeout(() => { notice(); resolve(false) }, 5000)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  private async retirementSummary(marker:InitialMarker):Promise<TerminalCreationRetirement|undefined> {
    if(!await this.admission.hasRetirement(marker.createOperationId))return undefined
    let claim:Awaited<ReturnType<TerminalRecoveryOwner['retirementClaim']>>=null
    try {claim=await this.retirementClaim(marker)} catch { /* Empty/partial immutable witness is unknown and never new. */ }
    let record=this.retirementObserved.get(marker.createOperationId)
    if(!record)try {record=JSON.parse(await readFile(this.retirementPath(marker.createOperationId),'utf8'))}catch { /* Marker still proves adoption, not a completed result. */ }
    let dispatchRuntime=claim?.dispatchRuntime??null
    if(!claim && record?.request?.operationId===marker.createOperationId && record.request.runtimeId===marker.runtime.runtimeId) {
      try {dispatchRuntime=record.request.dispatchRuntime===null?null:parseCreationRuntime(record.request.dispatchRuntime)}catch{ /* Malformed stored fields are not public request data. */ }
    }
    const request={operationId:marker.createOperationId,runtimeId:marker.runtime.runtimeId,dispatchRuntime}
    if(!record || JSON.stringify(record.request)!==JSON.stringify(request))return {request,phase:'unconfirmed',native:null,diskDurability:'unconfirmed'}
    try {parseTerminalCreationInspection({hostId:'local',operationId:marker.createOperationId,known:true,admission:{runtime:marker.runtime,workspacePath:marker.workspacePath,phase:'unconfirmed',run:null,observation:{availability:'unavailable',runtime:null},diskDurability:'unconfirmed',retirement:record}},{hostId:'local',operationId:marker.createOperationId})}catch{return {request,phase:'unconfirmed',native:null,diskDurability:'unconfirmed'}}
    return {...record,diskDurability:!this.retirementObserved.has(marker.createOperationId)&&this.retirementImages.get(marker.createOperationId)===this.initialHash(JSON.stringify({...record,diskDurability:'unconfirmed'})+'\n')?'confirmed':'unconfirmed'}
  }
  /** Positive original Native fence only; an unknown raw marker is not role authority. */
  async knownRetiredInitial(id:string):Promise<boolean> {
    try {const marker=await this.readInitialMarker(id);return !!marker&&(await this.readInitial(id,marker))?.phase==='retired'}catch{return false}
  }
  private async retireOriginal(marker:InitialMarker):Promise<TerminalCreationRetirement|undefined> {
    const id=marker.createOperationId
    if((this.initialObserved.get(id)??await this.readInitial(id,marker))?.phase==='retired') {
      this.admission.noteRetirement(id)
      await this.observeInitialRetirementKey(marker)
      return await this.retirementSummary(marker)
    }
    let rawRetained=false
    if(!await this.admission.hasRetirement(id)) {
      const selected=this.port.runtime()
      if(selected.runtimeId!==marker.runtime.runtimeId)throw failure('The original retirement belongs to another persistent Runtime.')
      const retained=await this.port.inspectCreation(id)
      if(retained){this.sameInitial(marker,retained.prepared,retained.runtime);rawRetained=true}
    }
    const dispatch=await this.admission.locked(id,async()=>{
      if(await this.admission.hasRetirement(id)) {await this.retirementClaim(marker);return null}
      // No connection means no new irreversible admission and no activation.
      const selected=this.port.runtime()
      if(selected.runtimeId!==marker.runtime.runtimeId)throw failure('The original retirement belongs to another persistent Runtime.')
      await this.port.assertNoAgentKey(id,rawRetained)
      const handle=await open(this.admission.retirementPath(id),'wx',0o600)
      this.admission.noteRetirement(id)
      try {await handle.writeFile(JSON.stringify({marker,dispatchRuntime:selected})+'\n');await handle.sync()}finally{await handle.close()}
      const base=await open(dirname(this.directory),'r');try{await base.sync()}finally{await base.close()}
      await mkdir(this.directory,{recursive:true,mode:0o700})
      const parent=await open(dirname(this.directory),'r');try{await parent.sync()}finally{await parent.close()}
      const request={operationId:id,runtimeId:marker.runtime.runtimeId,dispatchRuntime:selected}
      const saved=await this.saveRetirement(id,{request,phase:'dispatched',native:null,diskDurability:'unconfirmed'})
      // Only this exclusive claimant's own successful write can authorize dispatch.
      if(!saved)throw failure('Retirement admission member save is unconfirmed; no retirement was submitted.')
      return selected
    })
    if(dispatch) {
      try {
        const value=await this.port.retireKey(id,dispatch)
        if(value.runtime.runtimeId!==marker.runtime.runtimeId)throw failure('The retirement answers another Runtime.')
        if(value.outcome==='retained')this.sameInitial(marker,value.prepared,value.runtime)
        const result:AgentMuxTerminalCreationRetirement=value.outcome==='retired'?{runtime:value.runtime,outcome:'retired'}:{runtime:value.runtime,outcome:'retained',run:value.run}
        await this.saveRetirement(id,{request:{operationId:id,runtimeId:marker.runtime.runtimeId,dispatchRuntime:dispatch},phase:'observed',native:result,diskDurability:'unconfirmed'})
        if(await this.readInitialMarker(id))await this.settleInitial(marker,result.outcome==='retired'?'retired':'published',result.outcome==='retired'?null:result.run)
      } catch(error) {if(error instanceof AgentMuxError&&['RUN_KIND_MISMATCH','TERMINAL_INITIAL_CREATION_CONFLICT'].includes(error.code))throw error}
    } else await this.observeInitialRetirementKey(marker)
    return await this.retirementSummary(marker)
  }
  private async observeInitialRetirementKey(marker:InitialMarker):Promise<void> {
    const summary=await this.retirementSummary(marker)
    if(!summary)return
    if(summary.native) {
      if(summary.native.outcome==='retired' && await this.readInitialMarker(marker.createOperationId)) {
        const latest=this.initialObserved.get(marker.createOperationId)??await this.readInitial(marker.createOperationId,marker)
        if(latest?.phase!=='retired') await this.settleInitial(marker,'retired',null)
      }
      return
    }
    try {
      const runtime=this.port.runtime(),value=await this.port.observeRetirementKey(marker.createOperationId,runtime)
      if(value.runtime.runtimeId!==marker.runtime.runtimeId||value.outcome!=='retired')return
      await this.saveRetirement(marker.createOperationId,{...summary,phase:'observed',native:{runtime:value.runtime,outcome:'retired'}})
      if(await this.readInitialMarker(marker.createOperationId))await this.settleInitial(marker,'retired',null)
    } catch { /* Read unknown never authorizes another retirement. */ }
  }
  async retireInitial(id:string,runtimeId:string):Promise<TerminalCreationInspection> {
    const marker=await this.readInitialMarker(id)
    if(!marker)throw failure('There is no original initial Terminal admission for this key.')
    if(marker.runtime.runtimeId!==runtimeId)throw failure('The original retirement belongs to another Runtime.')
    await this.retireOriginal(marker)
    return await this.inspectInitial(id,runtimeId)
  }
  async observeInitialRetirement(value: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirementObservation> {
    const prepared = parsePreparedTerminal(value), marker = await this.readInitialMarker(prepared.createOperationId)
    if (marker) this.sameInitial(marker, prepared, runtime)
    const result = await this.port.observeRetirement(prepared, runtime)
    if (marker && result.outcome === 'retired') await this.settleInitial(marker, 'retired', null)
    return result
  }
  async inspectInitial(id: string, runtimeId?: string, includeRetirementBlocker = false): Promise<TerminalCreationInspection> {
    const marker = await this.readInitialMarker(id)
    if (!marker) {
      try { await readFile(this.initialPath(id)); throw failure('The original admission marker is missing.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return { hostId: 'local', operationId: id, known: false, admission: null }
    }
    if (runtimeId !== undefined && marker.runtime.runtimeId !== runtimeId) throw failure('The original creation belongs to another Runtime.')
    if(await this.admission.hasRetirement(id)) await this.observeInitialRetirementKey(marker)
    let record: InitialRecord | null = null, issue: string | undefined
    try { record = await this.readInitial(id, marker) } catch { issue = 'The original creation member is unconfirmed.' }
    if (!record) issue = 'The admitted original member is unavailable; this key cannot dispatch again.'
    const held = this.initialObserved.get(id), known = held ?? record
    let run = known?.run ?? null, availability: 'retained' | 'not-observed' | 'unavailable' = 'unavailable', observedRuntime: AgentMuxCreationRuntime | null = null
    try {
      const current = this.port.runtime()
      if (current.runtimeId !== marker.runtime.runtimeId) throw failure('The original Runtime observation owner changed.')
      observedRuntime = current
      const observed = (this.initialObserved.get(id) ?? record)?.phase === 'retired' ? null : await this.port.inspectCreation(id)
      if (observed) {
        this.sameInitial(marker, observed.prepared, observed.runtime)
        run = observed.run; availability = 'retained'
        if ((this.initialObserved.get(id) ?? record)?.phase !== 'retired' && (record?.phase !== 'published' || this.initialUnconfirmed.has(id))) {
          await this.settleInitial(marker, 'published', run); record = await this.readInitial(id, marker)
        }
      } else availability = 'not-observed'
    } catch (error) {
      if (error instanceof AgentMuxError && ['TERMINAL_INITIAL_CREATION_CONFLICT', 'RUN_KIND_MISMATCH'].includes(error.code)) throw error
      issue = issue ?? 'The original Native observation is unavailable; no Start was submitted.'
    }
    const latest = this.initialObserved.get(id) ?? record
    const phase = latest?.phase ?? 'unconfirmed'
    if (phase === 'retired') { run = null; if (availability === 'retained') availability = 'unavailable' }
    else if (availability !== 'retained' && latest?.run) run = latest.run
    const retirement=await this.retirementSummary(marker)
    let retirementBlocker: 'agent-role-unconfirmed' | undefined
    if (includeRetirementBlocker && phase === 'dispatched' && run === null && availability === 'not-observed' && !retirement) {
      try {
        if (await this.port.agentCreationKeyRole?.(id) === 'unknown') retirementBlocker = 'agent-role-unconfirmed'
      } catch {
        issue ??= 'The original Agent creation-key role could not be read. No retirement or release was authorized.'
      }
    }
    return { hostId: 'local', operationId: id, known: true, admission: { runtime: marker.runtime, workspacePath: marker.workspacePath,
      phase, run: phase === 'retired' ? null : run, observation: { availability, runtime: observedRuntime },
      ...(latest?.startFailure?{startFailure:latest.startFailure}:{}), ...(retirement?{retirement}:{}), ...(retirementBlocker ? { retirementBlocker } : {}),
      diskDurability: latest && !this.initialUnconfirmed.has(id) && this.initialImages.get(id) === this.initialHash(JSON.stringify(latest) + '\n') ? 'confirmed' : 'unconfirmed', ...(issue ? { issue } : {}) } }
  }
  /** Explicit cold directory reference read; never a Native query or hot-path history scan. */
  async retainedExecutionDirectories(isRelated?: (cwd: string) => Promise<boolean>): Promise<readonly string[]> {
    const paths = new Set<string>()
    for await (const name of this.directoryNames(this.directory)) if (/^[a-f0-9]{64}\.json$/u.test(name)) {
      const value = await this.read(join(this.directory, name))
      if (!value || this.path(value) !== join(this.directory, name)) throw failure('An original Terminal recovery reference changed.')
      if (!isRelated || await isRelated(value.workspacePath)) paths.add(value.workspacePath)
    }
    for await (const name of this.directoryNames(dirname(this.directory))) if (/^terminal-start-admission-[a-f0-9]{64}\.lock$/u.test(name)) {
      const marker = initialMarker(JSON.parse(await readFile(join(dirname(this.directory), name), 'utf8')))
      if (this.initialMarkerPath(marker.createOperationId) !== join(dirname(this.directory), name)) throw failure('An initial directory admission changed.')
      if (isRelated && !await isRelated(marker.workspacePath)) continue
      let record: InitialRecord | null = null
      try { record = await this.readInitial(marker.createOperationId, marker) } catch { /* Missing/corrupt member still retains its exact marker cwd. */ }
      if((await this.retirementSummary(marker))?.native?.outcome==='retired')continue
      if (!record || record.phase === 'dispatched' || this.initialUnconfirmed.has(marker.createOperationId)) paths.add(marker.workspacePath)
    }
    return [...paths]
  }
  private async *directoryNames(path: string): AsyncGenerator<string> {
    let entries
    try { entries = await opendir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for await (const entry of entries) yield entry.name
  }
  private path(input: AgentMuxTerminalRecoveryInput): string {
    return join(this.directory, createHash('sha256').update(input.expectedRun.runId).digest('hex') + '.json')
  }
  private async read(path: string): Promise<Intent | null> {
    try { return parseIntent(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async locked<T>(path: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Stable inode; never unlink a lock that another Core process may already have opened.
    const lock = await open(path + '.lock', 'a+', 0o600)
    try {
      const deadline = Date.now() + 5000
      while (!native.tryLock(lock.fd)) { if (Date.now() > deadline) throw failure('The original terminal recovery is completing admission; inspect the same intent.'); await delay(10) }
      // A newly created private namespace must itself be durable before any Start.
      // Every contender acknowledges it; observing mkdir success in another process is not fsync.
      const parent = await open(dirname(this.directory), 'r')
      try { await parent.sync() } finally { await parent.close() }
      return await work()
    } finally { await lock.close() }
  }
  private save(path: string, intent: Intent): Promise<void> {
    parseIntent(intent)
    return durableWriteFile(path, JSON.stringify(intent) + '\n', { mode: 0o600, requireDirectorySync: true })
  }
  private identity(input: AgentMuxTerminalRecoveryInput): AgentMuxCreationRuntime {
    const runtime = this.port.runtime()
    if (runtime.runtimeId !== input.runtimeId) throw failure('The requested terminal belongs to another persistent Runtime.')
    return runtime
  }
  private assertIntent(intent: Intent, input: AgentMuxTerminalRecoveryInput): void {
    if (intent.expectedRun.runId !== input.expectedRun.runId || intent.runtimeId !== input.runtimeId || intent.workspacePath !== input.workspacePath)
      throw failure('The original terminal recovery target or execution directory changed.')
  }
  private result(intent: Intent, run?: AgentMuxRun): AgentMuxTerminalRecoveryResult {
    const base = { expectedRun: intent.expectedRun, runtimeId: intent.runtimeId, operationId: intent.operationId }
    if (run?.state === 'running') return { ...base, kind: 'recovered', run }
    return { ...base, kind: 'pending', phase: intent.phase, ...(intent.run ? { replacementRun: intent.run } : {}),
      message: intent.phase === 'retained' ? 'The original replacement is retained but has ended; inspect its exact Run.'
        : 'The original terminal creation is unconfirmed. Inspect this same intent; explicit continue fences its original creation before a successor.' }
  }
  async recover(value: AgentMuxTerminalRecoveryInput): Promise<AgentMuxTerminalRecoveryResult> {
    const input = parseHostRecoveryInput(value), runtime = this.identity(input), path = this.path(input)
    const original = await this.port.original(input)
    if (original?.state === 'running') return { kind: 'reattachable', expectedRun: input.expectedRun, runtimeId: input.runtimeId, operationId: input.operationId, run: original }
    let intent = await this.read(path)
    if (!intent && input.action === 'inspect') return { kind: 'pending', expectedRun: input.expectedRun, runtimeId: input.runtimeId, operationId: input.operationId, phase: 'not_applied', message: 'No recovery intent has been admitted for this original Run.' }
    // Shell preparation can await Host discovery. It never holds the per-Run admission lock.
    // A caller operation can be reused for another old Run; it cannot alias Native creations.
    const prepared = !intent ? await this.port.prepare(mintObjectId(), input.workspacePath) : undefined
    intent = await this.locked(path, async () => {
      const prior = await this.read(path)
      if (prior) { this.assertIntent(prior, input); return prior }
      const created: Intent = { schemaVersion: 1, expectedRun: input.expectedRun, runtimeId: input.runtimeId,
        workspacePath: input.workspacePath, operationId: input.operationId, prepared: prepared!, phase: 'prepared', run: null, continuedBy: [], retirement: null, retiredAttempts: [] }
      const write = async () => { await this.save(path, created); return created }
      return this.port.directoryAdmission ? await this.port.directoryAdmission(created.workspacePath, write) : await write()
    })
    this.assertIntent(intent, input)
    // Each update is bound to the attempt observed before its Native await. A lost
    // compare-and-swap only returns the latest intent; it never follows its successor.
    const update = async (attempt: AgentMuxPreparedTerminal, change: (current: Intent) => boolean) =>
      this.locked(path, async () => {
        const current = (await this.read(path))!
        this.assertIntent(current, input)
        const changed = current.prepared.createOperationId === attempt.createOperationId && change(current)
        if (changed) await this.save(path, current)
        return { current, changed }
      })
    // A confirmed retirement is monotonic even before a successor is prepared.
    // A reply generated before that fence cannot resurrect the same attempt.
    const retain = (current: Intent, run: AgentMuxRun): boolean => {
      if (!['dispatched', 'retained'].includes(current.phase)) return false
      current.phase = 'retained'; current.run = { runId: run.runId }; return true
    }
    // A durable dispatched marker may precede a lost Start reply or a Core crash. Only observe.
    if (intent.phase === 'dispatched' || intent.phase === 'retained') {
      const attempt = intent.prepared
      const retained = await this.port.inspect(attempt, intent.run ?? undefined)
      if (retained) {
        const observed = await update(attempt, current => retain(current, retained))
        intent = observed.current
        if (!observed.changed) return this.result(intent)
        return this.result(intent, retained)
      }
      if (intent.retirement) {
        const fence = await this.port.observeRetirement(attempt, intent.retirement)
        if (fence.outcome === 'retired') {
          const observed = await update(attempt, current => { current.phase = 'not_applied'; return true })
          intent = observed.current
          if (!observed.changed) return this.result(intent)
        }
      }
      if (intent.phase !== 'not_applied' && input.action !== 'continue') return this.result(intent)
      if (intent.phase !== 'not_applied' && intent.continuedBy.includes(input.operationId)) return this.result(intent)
      if (intent.phase !== 'not_applied') {
        // Admit the exact attempt, phase and unused authorization under the lock.
        // A concurrent owner may already have consumed this operation for a successor.
        let retirementRuntime: AgentMuxCreationRuntime | null = null
        const admitted = await update(attempt, current => {
          if (!['dispatched', 'retained'].includes(current.phase) || current.continuedBy.includes(input.operationId)) return false
          current.retirement ??= runtime; retirementRuntime = current.retirement; return true
        })
        intent = admitted.current
        if (!admitted.changed) return this.result(intent)
        const retirement = await this.port.retire(attempt, retirementRuntime!)
        if (retirement.outcome === 'retained') {
          const observed = await update(attempt, current => retain(current, retirement.run))
          intent = observed.current
          if (!observed.changed) return this.result(intent)
          return this.result(intent, retirement.run)
        }
        const observed = await update(attempt, current => { current.phase = 'not_applied'; return true })
        intent = observed.current
        if (!observed.changed) return this.result(intent)
      }
    }
    if (intent.phase === 'not_applied') {
      if (input.action !== 'continue' || intent.continuedBy.includes(input.operationId)) return this.result(intent)
      const attempt = intent.prepared, next = await this.port.prepare(mintObjectId(), input.workspacePath)
      const continued = await update(attempt, current => {
        if (current.phase !== 'not_applied' || current.continuedBy.includes(input.operationId)) return false
        current.retiredAttempts.push({ prepared: current.prepared, runtime: current.retirement!, continuationOperationId: input.operationId })
        current.continuedBy.push(input.operationId); current.prepared = next; current.phase = 'prepared'; current.run = null; current.retirement = null
        return true
      })
      intent = continued.current
      if (!continued.changed) return this.result(intent)
    }
    if (input.action === 'inspect' || intent.phase !== 'prepared') return this.result(intent)
    // One process claims dispatch under a short per-original-Run lock, before any Native wait.
    const attempt = intent.prepared
    const dispatched = await update(attempt, current => { if (current.phase !== 'prepared') return false; current.phase = 'dispatched'; return true })
    intent = dispatched.current
    if (!dispatched.changed) return this.result(intent)
    this.identity(input)
    let run: AgentMuxRun
    try { run = await this.port.start(attempt) }
    catch { return this.result(intent) }
    const observed = await update(attempt, current => retain(current, run))
    intent = observed.current
    if (!observed.changed) return this.result(intent)
    return this.result(intent, run)
  }
}

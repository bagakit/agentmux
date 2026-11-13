import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, unlink, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ctxmuxOwnerReceiptPath } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { durableWriteFile } from './durable-write.js'
import { SshExecutionHost, type ExecutionHost } from './execution-host.js'
import { assertAgentMuxRuntimeCompatibility } from './ctxmux-run-adapter.js'
import type { AgentMuxRunState, AgentMuxRuntimeCompatibilityInput } from './types.js'
import { createPortableCoreArtifact, type PortableCoreArtifact } from './portable-core-artifact.js'
import { INSPECT_CORE_OWNER, READ_CORE_MAINTENANCE, OWNER_GONE, STAGE_CORE, START_CORE, SELECT_CORE_RELEASE, REPLACE_NATIVE } from './remote-core-upgrade-programs.js'
import { parseRemoteCoreUpgradeExpected, parseRemoteCoreMaintenanceObservation, parseRemoteCoreMaintenanceShutdown } from './remote-core-upgrade-codec.js'

export type RemoteCoreUpgradeHost = { id: string; kind: 'local'; label: string; tailcat?: { enabled: boolean; keyFile: string; allowedClients: string[] } } | {
  id: string; kind: 'ssh'; label: string; hostname: string; user?: string; port?: number; identityFile?: string
  remoteCommand?: string; remoteSocketPath?: string; runtimeId?: string
  transport?: 'ssh' | 'ssh-tailcat' | 'tailcat'
  tailcat?: import('./public-rpc.js').AgentMuxTailcatTarget
}
export type RemoteCoreUpgradeExpected = {
  targetDigest: string; runtimeId: string; ownerInstanceId: string; processId: number; startTicks: string
  candidateDigest: string; nativeInstanceId: string; nativeProcessId: number; nativeStartTicks: string
  /** Present only for a reviewed Native replacement: the running Runs the user accepted ending. */
  nativeReplacement?: { endingRunIds: string[] }
}
/** What a Native replacement ends, read from the serving Native and its owner. */
export type RemoteCoreNativeReplacement = {
  /** Running Runs of the serving Native; each ends when the Native is replaced. */
  ending: { runId: string; agentSessionId: string | null }[]
}
export type RemoteCoreUpgradeCandidate = Pick<PortableCoreArtifact, 'digest' | 'sourceCommit' | 'version' | 'ownerProtocolVersion' | 'requiredNativeProtocolVersion'>
export type RemoteCoreCurrentObservation =
  | { state: 'available'; observedAt: number; version: string | null; sourceCommit: string | null; deploymentDigest: string;
      ownerProtocolVersion: number; runtimeId: string; ownerInstanceId: string; processId: number;
      native: { instanceId: string; buildId: string; protocolVersion: number } }
  | { state: 'unavailable'; observedAt: number; code: string; detail: string }
export type RemoteCoreUpgradeCheck = {
  input: RemoteCoreUpgradeHost; current: RemoteCoreCurrentObservation; candidate: RemoteCoreUpgradeCandidate | null; eligible: boolean; detail: string
  /** A local candidate failure never hides the current owner or an original operation. */
  candidateUnavailable?: { code: string; detail: string }
  reason: 'ready' | 'native-replacement' | 'up-to-date' | 'runtime-update-required' | 'unverified'
  expected?: RemoteCoreUpgradeExpected
  /** Present with reason native-replacement. */
  nativeReplacement?: RemoteCoreNativeReplacement
  latestOperation?: RemoteCoreUpgradeReceipt
  /** Operation IDs whose record cannot be read: original Host and outcome unknown, never replayed. */
  unreadableOperations?: string[]
}
export type RemoteCoreUpgradeReceipt = {
  input: RemoteCoreUpgradeHost; operationId: string; expected: RemoteCoreUpgradeExpected
  status: 'running' | 'completed' | 'failed' | 'unknown'
  stage: 'preparing' | 'staged' | 'stopping' | 'replacing-native' | 'starting' | 'verifying' | 'completed'
  detail: string; remoteCommand?: string; updatedAt: number
  /** A Native replacement's facts, as far as this operation confirmed them. */
  nativeReplacement?: { stateCopy?: string; endedRunIds: string[]; survivingProcessIds?: number[] }
  candidate?: RemoteCoreUpgradeCandidate
  /** Main/config owner projection only; never rewrites the Core deployment outcome. */
  connectionAdoption?: { state: 'pending-confirmation' | 'connected' | 'unconfirmed'; readAt: number; code?: string; detail?: string }
}
type Launch = { node: string; cli: string; cwd: string; processId: number; startTicks: string; env: Record<string, string>
  stateDirectory: string; runtimeDirectory: string; storePath: string; nativeSha256: string; nativeProcessId: number; nativeStartTicks: string
  nativeArtifactDirectory: string; nativeManifestSha256: string; nativeInstanceId: string; nativeRuntimeId: string; nativeBuildId: string
  platform: string; deploymentDigest: string; version: string | null; sourceCommit: string | null }
/** One Native Run as its own serving Native reports it. */
export type RemoteCoreUpgradeNativeRun = { runId: string; pid: number | null; state: AgentMuxRunState; outputBytes: number
  /** Bytes the Native has made durable, or null without a state directory. */
  durableOutputBytes: number | null; inputBytes: number | null }
export type RemoteCoreMaintenanceOwner = { runtimeId: string; ownerInstanceId: string; processId: number; protocolVersion: number
  ctxmux: { instanceId: string; processId: number | null; buildIdentity: string; protocolVersion: number } }
export type RemoteCoreMaintenanceObservation = { owner: RemoteCoreMaintenanceOwner
  /** Session bindings of the semantic owner. A bound Run absent from nativeRuns is physically
   * absent from this Native; that is never a Session terminal fact. */
  bootstrap: { storePath: string; hostProcessId: number; sessions: { agentSessionId: string; run: { runId: string } }[] }
  /** Every Run of this exact Native instance, read through its own SDK. */
  nativeRuns: RemoteCoreUpgradeNativeRun[]
  nativeRuntime: AgentMuxRuntimeCompatibilityInput & { daemonInstanceId: string; runtimeId: string } }
type OwnerReceiptObservation = { status: 'matching' | 'missing' | 'mismatch' | 'unreadable'; path: string; detail?: string }
type LaunchInspection = Omit<Launch, 'nativeInstanceId' | 'nativeRuntimeId' | 'nativeBuildId'>
type Observed = RemoteCoreMaintenanceObservation & { launch: Launch; ownerReceipt: OwnerReceiptObservation }
type OperationRecords = { values: RetainedOperation[]; unreadable: string[] }
type RetainedOperation = { receipt: RemoteCoreUpgradeReceipt; observed?: Observed; releaseDirectory?: string }
export type RemoteCoreUpgradeOptions = {
  stateDirectory: string; packageRoot?: string
  /** The execution port supports a headless client without Desktop ownership. */
  executionHost?: (host: RemoteCoreUpgradeHost) => ExecutionHost
  artifact?: () => Promise<PortableCoreArtifact>
}
export function remoteCoreUpgradeTargetDigest(host: RemoteCoreUpgradeHost): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(host).filter(([key]) => key !== 'label').sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
}
const UNREADABLE_OPERATION = 'CORE_UPGRADE_OPERATION_UNREADABLE'
/** Free space kept beyond the state copy: the WAL ceiling of the Native that starts next. */
const NATIVE_REPLACEMENT_RESERVE_BYTES = 16 * 1024 * 1024
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const wait = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 250))
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
function maintenanceScope(input: RemoteCoreUpgradeHost): string {
  // A verified durable Runtime identity is the authority, even when SSH uses another
  // DNS name, account or port. The admission still binds the complete route.
  return createHash('sha256').update(JSON.stringify(input.kind === 'ssh' && input.runtimeId ? { kind: 'ssh', runtimeId: input.runtimeId } : input.kind === 'ssh' ? {
    hostname: input.hostname, user: input.user ?? null, port: input.port ?? 22,
    socket: input.remoteSocketPath ?? null, runtimeId: input.runtimeId ?? null
  } : { kind: 'local', id: input.id })).digest('hex')
}

/** Owns a finite deployment transaction. Native and Agent Runs remain owned by
 * their original Runtime; an incompatible Native is a refusal of this update only. */
export class RemoteCoreUpgradeManager {
  private candidate: Promise<PortableCoreArtifact> | undefined
  private readonly active = new Map<string, Promise<RemoteCoreUpgradeReceipt>>()
  private readonly targets = new Set<string>()
  constructor(private readonly options: RemoteCoreUpgradeOptions) {}
  private async artifact(): Promise<PortableCoreArtifact> {
    const pending = this.candidate ??= (async () => {
      if (this.options.artifact) return await this.options.artifact()
      await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.options.stateDirectory, 'candidate-'))
      try { return await createPortableCoreArtifact(directory, this.options.packageRoot) }
      catch (error) {
        try { await rm(directory, { recursive: true, force: true }) }
        catch (cleanupError) {
          const failure = new AgentMuxError(
            `${errorText(error)} Incomplete candidate cleanup failed: ${errorText(cleanupError)} (${directory}).`,
            error instanceof AgentMuxError ? error.code : 'CORE_ARTIFACT_UNAVAILABLE',
            JSON.stringify({ directory, assembly: { message: errorText(error), ...(error instanceof AgentMuxError ? { code: error.code, detail: error.detail } : {}) },
              cleanup: { message: errorText(cleanupError) } }))
          failure.cause = error
          throw failure
        }
        throw error
      }
    })()
    try { return await pending }
    catch (error) {
      // A failed local assembly did not admit a remote update. An explicit
      // Check again may retry it; a successful candidate remains fixed.
      if (this.candidate === pending) this.candidate = undefined
      throw error
    }
  }
  private host(input: RemoteCoreUpgradeHost): ExecutionHost {
    if (input.kind !== 'ssh' || input.transport === 'tailcat') throw new AgentMuxError('Only explicitly configured SSH Linux x64 headless Core owners can be upgraded here. Tailcat does not install or upgrade a remote Mac.', 'CORE_UPGRADE_UNAVAILABLE')
    return this.options.executionHost?.(input) ?? new SshExecutionHost(input)
  }
  private async program<T>(input: RemoteCoreUpgradeHost, command: string, args: string[], params: unknown): Promise<T> {
    const result = await this.host(input).run(command, args, { input: JSON.stringify(params), timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0) throw new AgentMuxError(result.stderr.trim() || 'The maintenance command did not complete.', 'CORE_UPGRADE_UNAVAILABLE')
    try { return JSON.parse(result.stdout.trim()) as T }
    catch { throw new AgentMuxError('The maintenance command returned an unknown receipt.', 'CORE_UPGRADE_RESPONSE_UNKNOWN') }
  }
  private async observe(input: RemoteCoreUpgradeHost, qualifyNative = true): Promise<Observed> {
    if (input.kind !== 'ssh' || !input.remoteCommand?.startsWith('/') || !input.remoteSocketPath?.startsWith('/') || !input.runtimeId) {
      throw new AgentMuxError('Save an explicit remote Core command, socket and verified Runtime identity before upgrading.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    const physical = await this.program<LaunchInspection>(input, '/usr/bin/python3', ['-c', INSPECT_CORE_OWNER], {
      socket: input.remoteSocketPath, runtimeId: input.runtimeId })
    if (physical.platform !== 'linux-x64' || !/^\d+$/u.test(physical.startTicks) || !/^\d+$/u.test(physical.nativeStartTicks) ||
      !Number.isSafeInteger(physical.processId) || physical.processId < 1 || !Number.isSafeInteger(physical.nativeProcessId) || physical.nativeProcessId < 1 ||
      !physical.node.startsWith('/') || !/^[a-f0-9]{64}$/u.test(physical.deploymentDigest)) {
      throw new AgentMuxError('The original process launch identity is not qualified.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    const observed = parseRemoteCoreMaintenanceObservation(await this.program(input, physical.node, ['-e', READ_CORE_MAINTENANCE], {
      launch: physical, socket: input.remoteSocketPath, runtimeId: input.runtimeId }))
    if (observed.owner.runtimeId !== input.runtimeId || observed.owner.processId !== physical.processId || observed.bootstrap.storePath !== physical.storePath) {
      throw new AgentMuxError('The maintenance observation belongs to another process, Native or Store.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    if (qualifyNative) assertAgentMuxRuntimeCompatibility(observed.nativeRuntime)
    // Recheck OS leases, image and package after the producer's strict read.
    const after = await this.program<LaunchInspection & { ownerReceipt: OwnerReceiptObservation }>(input, '/usr/bin/python3', ['-c', INSPECT_CORE_OWNER], {
      pid: physical.processId, startTicks: physical.startTicks, nativePid: physical.nativeProcessId,
      socket: input.remoteSocketPath, store: physical.storePath, runtimeId: input.runtimeId,
      receipt: { path: ctxmuxOwnerReceiptPath(join(physical.runtimeDirectory, 'ctxmux.sock'), observed.nativeRuntime, physical.nativeManifestSha256), identity: observed.nativeRuntime } })
    const { ownerReceipt, ...afterPhysical } = after
    if (JSON.stringify(afterPhysical) !== JSON.stringify(physical)) throw new AgentMuxError('The original process or software changed during observation.', 'CORE_UPGRADE_UNAVAILABLE')
    if (!ownerReceipt || !['matching', 'missing', 'mismatch', 'unreadable'].includes(ownerReceipt.status) ||
      ownerReceipt.path !== ctxmuxOwnerReceiptPath(join(physical.runtimeDirectory, 'ctxmux.sock'), observed.nativeRuntime, physical.nativeManifestSha256)) {
      throw new AgentMuxError('The product receipt diagnostic belongs to another Native observation.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    const launch = { ...physical, nativeInstanceId: observed.nativeRuntime.daemonInstanceId,
      nativeRuntimeId: observed.nativeRuntime.runtimeId, nativeBuildId: observed.nativeRuntime.buildId }
    return { ...observed, launch, ownerReceipt }
  }
  private expected(input: RemoteCoreUpgradeHost, artifact: PortableCoreArtifact, observed: Observed): RemoteCoreUpgradeExpected {
    return { targetDigest: remoteCoreUpgradeTargetDigest(input), runtimeId: observed.owner.runtimeId,
      ownerInstanceId: observed.owner.ownerInstanceId, processId: observed.owner.processId, startTicks: observed.launch.startTicks,
      candidateDigest: artifact.digest, nativeInstanceId: observed.owner.ctxmux.instanceId, nativeProcessId: observed.launch.nativeProcessId, nativeStartTicks: observed.launch.nativeStartTicks }
  }
  private candidateSummary(artifact: PortableCoreArtifact): RemoteCoreUpgradeCandidate {
    return { digest: artifact.digest, sourceCommit: artifact.sourceCommit, version: artifact.version,
      ownerProtocolVersion: artifact.ownerProtocolVersion, requiredNativeProtocolVersion: artifact.requiredNativeProtocolVersion }
  }
  async check(input: RemoteCoreUpgradeHost): Promise<RemoteCoreUpgradeCheck> {
    const captured = structuredClone(input)
    let records: OperationRecords | Error
    try { records = await this.records() } catch (error) { records = error instanceof Error ? error : new Error(String(error)) }
    const result = await this.evaluate(captured, records)
    // An unattributable record names its own operation ID only; it neither blocks
    // this Host nor disappears from the read.
    return records instanceof Error || !records.unreadable.length ? result : { ...result, unreadableOperations: [...records.unreadable].sort() }
  }
  private async evaluate(captured: RemoteCoreUpgradeHost, records: OperationRecords | Error): Promise<RemoteCoreUpgradeCheck> {
    let artifact: PortableCoreArtifact | undefined, candidateUnavailable: RemoteCoreUpgradeCheck['candidateUnavailable']
    try { artifact = await this.artifact() }
    catch (error) { candidateUnavailable = { code: error instanceof AgentMuxError ? error.code : 'CORE_ARTIFACT_UNAVAILABLE', detail: errorText(error) } }
    const candidate = artifact ? this.candidateSummary(artifact) : null
    let observed: Observed | undefined
    let current: RemoteCoreCurrentObservation
    try {
      // Reading the exact current producer is independent of a new admission,
      // uncertain historical operations and this candidate's Native compatibility.
      observed = await this.observe(captured, false)
      current = { state: 'available', observedAt: Date.now(), version: observed.launch.version, sourceCommit: observed.launch.sourceCommit,
        deploymentDigest: observed.launch.deploymentDigest, ownerProtocolVersion: observed.owner.protocolVersion,
        runtimeId: observed.owner.runtimeId, ownerInstanceId: observed.owner.ownerInstanceId, processId: observed.owner.processId,
        native: { instanceId: observed.owner.ctxmux.instanceId, buildId: observed.owner.ctxmux.buildIdentity, protocolVersion: observed.owner.ctxmux.protocolVersion } }
    } catch (error) {
      current = { state: 'unavailable', observedAt: Date.now(), code: error instanceof AgentMuxError ? error.code : 'CORE_OBSERVATION_UNAVAILABLE', detail: errorText(error) }
    }
    let latestOperation: RemoteCoreUpgradeReceipt | undefined, scoped: RemoteCoreUpgradeReceipt | undefined
    try {
      if (records instanceof Error) throw records
      latestOperation = await this.latest(captured, records); scoped = await this.unconfirmedInScope(captured, undefined, records)
    } catch (error) {
      // Unreadable history cannot admit an update, but it does not erase the
      // current owner observation or the local candidate facts already read.
      return { input: captured, candidate, ...(candidateUnavailable ? { candidateUnavailable } : {}), current, eligible: false, reason: 'unverified',
        detail: `原维护操作记录无法读取：${errorText(error)} 当前 Core 观测保留；不会受理新的升级。` }
    }
    const base = { input: captured, candidate, ...(candidateUnavailable ? { candidateUnavailable } : {}), current, ...(latestOperation ? { latestOperation } : {}) }
    if (latestOperation?.status === 'unknown' || latestOperation?.status === 'running') return { ...base, eligible: false, reason: 'unverified',
      detail: '此前的升级结果尚未确认。请复查原操作；不会再次停止或启动 Core。' }
    if (scoped) return { ...base, eligible: false, reason: 'unverified', latestOperation: scoped,
      detail: `同一 Core 的连接 ${scoped.input.id} 有未确认的维护操作 ${scoped.operationId}。请复查该原操作；不会再次停止或启动 Core。` }
    if (!artifact || !candidate) return { ...base, eligible: false, reason: 'unverified', detail: 'The local upgrade candidate is unavailable. Current Core and original operation observations are retained.' }
    if (!observed) return { ...base, eligible: false, reason: 'unverified', detail: current.state === 'unavailable' ? current.detail : 'The original Core could not be observed.' }
    if (observed.launch.deploymentDigest === candidate.digest) return { ...base, eligible: false, reason: 'up-to-date', detail: 'The original Core already runs this exact bundled deployment.' }
    const provenance = observed.ownerReceipt.status === 'matching' ? '' : ` 产品来源回执${observed.ownerReceipt.status === 'missing' ? '缺失' : '未确认'}；当前进程、映像与公开身份已独立核对，健康 Runtime 保持可用。`
    try {
      assertAgentMuxRuntimeCompatibility(observed.nativeRuntime)
      return { ...base, eligible: true, reason: 'ready', expected: this.expected(captured, artifact, observed),
        detail: '已核对原 Core、启动目录和 Runtime。升级仅重启 Core 服务，保留原 Session 和运行进程。' + provenance }
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_OWNER_IDENTITY_UNPROVEN') return { ...base, eligible: false, reason: 'unverified', detail: errorText(error) }
      // No same-process handoff exists to a newer generation. A persistent older Native can be
      // replaced cold, once the user reviews what ends; anything else stays a refusal.
      if (observed.nativeRuntime.runtimeIdPersistence !== 'state_dir' || artifact.requiredNativeProtocolVersion <= observed.nativeRuntime.protocolGeneration) {
        return { ...base, eligible: false, reason: 'runtime-update-required', detail: errorText(error) }
      }
      try {
        const nativeReplacement = await this.replacementPlan(captured, observed)
        return { ...base, eligible: true, reason: 'native-replacement', nativeReplacement,
          expected: { ...this.expected(captured, artifact, observed), nativeReplacement: { endingRunIds: nativeReplacement.ending.map(run => run.runId) } },
          detail: `Native Runtime 使用协议 ${observed.nativeRuntime.protocolGeneration}，本 App 需要协议 ${artifact.requiredNativeProtocolVersion}，无法在原进程中交接。` +
            `升级会先保存 Native 状态副本，再用新版本重启 Native；${nativeReplacement.ending.length ? `${nativeReplacement.ending.length} 个运行中的进程会结束，` : '没有运行中的进程，'}Session、历史与 Runtime 身份保留。` + provenance }
      } catch (planError) { return { ...base, eligible: false, reason: 'unverified', detail: `Native 替换条件未确认：${errorText(planError)}` } }
    }
  }
  /** The running Runs a replacement ends, with their Session owners. The remote program also
   * confirms the exact Native process and room for the state copy. */
  private async replacementPlan(input: RemoteCoreUpgradeHost, observed: Observed): Promise<RemoteCoreNativeReplacement> {
    const ready = await this.program<{ ready?: unknown }>(input, observed.launch.node, ['-e', REPLACE_NATIVE], this.replacementInput(observed, false, ''))
    if (ready.ready !== true) throw new AgentMuxError('The Native replacement conditions are unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    const owners = new Map(observed.bootstrap.sessions.map(session => [session.run.runId, session.agentSessionId]))
    return { ending: observed.nativeRuns.filter(run => run.state === 'running').map(run => ({ runId: run.runId, agentSessionId: owners.get(run.runId) ?? null })) }
  }
  private replacementInput(observed: Observed, stop: boolean, copyDirectory: string) {
    return { pid: observed.launch.nativeProcessId, startTicks: observed.launch.nativeStartTicks, nativeSha256: observed.launch.nativeSha256,
      stateDirectory: observed.launch.stateDirectory, nativeStateDirectory: join(observed.launch.stateDirectory, 'ctxmux'), reserveBytes: NATIVE_REPLACEMENT_RESERVE_BYTES,
      stop, copyDirectory, runProcessIds: observed.nativeRuns.flatMap(run => run.state === 'running' && run.pid !== null ? [run.pid] : []) }
  }
  private path(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new AgentMuxError('Upgrade operation ID is invalid.', 'INVALID_CONTROL_REQUEST')
    return join(this.options.stateDirectory, 'operations', operationId + '.json')
  }
  /** A record without its original Host and admission cannot be attributed to any
   * Core scope. It is refused by its own operation ID and never blocks other Hosts. */
  private async read(operationId: string): Promise<RetainedOperation | null> {
    let source: string
    try { source = await readFile(this.path(operationId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let value: unknown
    try { value = JSON.parse(source) } catch { value = undefined }
    const receipt = (value as Partial<RetainedOperation> | undefined)?.receipt
    if (!receipt || typeof receipt !== 'object' || receipt.operationId !== operationId || !receipt.input || typeof receipt.input !== 'object' ||
        (receipt.input.kind !== 'ssh' && receipt.input.kind !== 'local') || !receipt.expected || typeof receipt.expected.targetDigest !== 'string') {
      throw new AgentMuxError(`Upgrade operation ${operationId} has an unreadable record; its original Host and outcome are unknown. It is not replayed.`, UNREADABLE_OPERATION)
    }
    return value as RetainedOperation
  }
  private async records(): Promise<OperationRecords> {
    let names: string[]
    try { names = await readdir(join(this.options.stateDirectory, 'operations')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: [], unreadable: [] }; throw error }
    const values: RetainedOperation[] = [], unreadable: string[] = []
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name)) continue
      try { const value = await this.read(name.slice(0, -5)); if (value) values.push(value) }
      catch (error) { if (error instanceof AgentMuxError && error.code === UNREADABLE_OPERATION) unreadable.push(name.slice(0, -5)); else throw error }
    }
    return { values, unreadable }
  }
  private async save(value: RetainedOperation): Promise<void> {
    value.receipt.updatedAt = Date.now()
    await mkdir(join(this.options.stateDirectory, 'operations'), { recursive: true, mode: 0o700 })
    await durableWriteFile(this.path(value.receipt.operationId), JSON.stringify(value) + '\n', { requireDirectorySync: true })
  }
  private matches(input: RemoteCoreUpgradeHost, receipt: RemoteCoreUpgradeReceipt): boolean {
    const digest = remoteCoreUpgradeTargetDigest(input)
    return digest === receipt.expected.targetDigest || Boolean(receipt.remoteCommand && receipt.input.kind === 'ssh' &&
      digest === remoteCoreUpgradeTargetDigest({ ...receipt.input, remoteCommand: receipt.remoteCommand }))
  }
  private async latest(input: RemoteCoreUpgradeHost, records?: OperationRecords): Promise<RemoteCoreUpgradeReceipt | undefined> {
    const matches = (records ?? await this.records()).values.map(value => value.receipt).filter(receipt => this.matches(input, receipt))
    matches.sort((a, b) => Number(b.status === 'running' || b.status === 'unknown') - Number(a.status === 'running' || a.status === 'unknown') || b.updatedAt - a.updatedAt)
    return matches[0] ? (await this.inspect(input, matches[0].operationId)) ?? undefined : undefined
  }
  private async unconfirmedInScope(input: RemoteCoreUpgradeHost, excluding?: string, records?: OperationRecords): Promise<RemoteCoreUpgradeReceipt | undefined> {
    return (records ?? await this.records()).values.find(value => value.receipt.operationId !== excluding &&
      maintenanceScope(value.receipt.input) === maintenanceScope(input) && (value.receipt.status === 'running' || value.receipt.status === 'unknown'))?.receipt
  }
  async inspect(input: RemoteCoreUpgradeHost, operationId: string): Promise<RemoteCoreUpgradeReceipt | null> {
    let retained = await this.read(operationId)
    if (!retained) return null
    if (!this.matches(input, retained.receipt)) {
      throw new AgentMuxError('This operation belongs to another Host configuration.', 'CONFIG_CONFLICT')
    }
    if (retained.receipt.status === 'running' && !this.active.has(operationId)) {
      const lease = await open(join(this.options.stateDirectory, 'operations', maintenanceScope(retained.receipt.input) + '.lock'), 'a+', 0o600)
      try {
        if (native.tryLock(lease.fd)) {
          const current = await this.read(operationId)
          if (!current || !this.matches(input, current.receipt)) throw new AgentMuxError('The original operation changed during inspection.', 'CONFIG_CONFLICT')
          retained = current
          if (retained.receipt.status === 'running') {
            retained.receipt.status = 'unknown'
            retained.receipt.detail = '升级执行者已断开，原操作结果尚未确认。保留原 operationId；不会自动重放停止或启动。'
            await this.save(retained)
          }
        }
      } finally { await lease.close() }
    }
    if (input.kind === 'ssh' && input.transport !== 'tailcat' && retained.receipt.status === 'unknown' && retained.observed && retained.releaseDirectory && retained.receipt.remoteCommand && retained.receipt.input.kind === 'ssh') {
      try {
        const replacing = retained.receipt.expected.nativeReplacement !== undefined
        if (!retained.observed.nativeRuntime || !replacing && retained.receipt.candidate &&
            retained.receipt.candidate.requiredNativeProtocolVersion !== retained.observed.nativeRuntime.protocolGeneration) {
          throw new AgentMuxError('The original candidate and Native contract are unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
        }
        // A replacement can only be confirmed after its exact state copy was confirmed.
        if (replacing && !retained.receipt.nativeReplacement?.stateCopy) throw new AgentMuxError('The original Native state copy is unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
        // Reconcile this original transaction with its retained Native contract,
        // not the current App's SDK or a newly assembled local candidate.
        const next = await this.observe({ ...retained.receipt.input, remoteCommand: retained.receipt.remoteCommand }, false)
        if (replacing) retained.receipt.nativeReplacement = { ...retained.receipt.nativeReplacement!, endedRunIds: this.verifyReplacement(retained.observed, next, retained.receipt.expected.candidateDigest) }
        else this.verify(retained.observed, next, retained.receipt.expected.candidateDigest)
        // A confirmed original upgrade also names its release for the next restart.
        await this.select(retained.receipt.input, retained.observed.launch, retained.receipt.expected.candidateDigest, operationId)
        retained.receipt.status = 'completed'; retained.receipt.stage = 'completed'
        retained.receipt.detail = replacing ? '已复查原操作：新 Core 与 Native Runtime 已运行，原 Runtime、Session 与历史保留。' : '已复查原操作：新 Core 已运行，原 Runtime 和 Session/Run 绑定保留。'
        await this.save(retained)
      } catch { /* Read-only observation cannot turn uncertainty into a replay. */ }
    }
    return structuredClone(retained.receipt)
  }
  async upgrade(input: RemoteCoreUpgradeHost, expected: RemoteCoreUpgradeExpected, operationId: string): Promise<RemoteCoreUpgradeReceipt> {
    const captured = structuredClone(input), pinned = parseRemoteCoreUpgradeExpected(expected)
    this.path(operationId)
    if (pinned.targetDigest !== remoteCoreUpgradeTargetDigest(captured)) throw new AgentMuxError('Host input changed after the upgrade check.', 'CONFIG_CONFLICT')
    const retained = await this.read(operationId)
    if (retained) {
      if (JSON.stringify(retained.receipt.expected) !== JSON.stringify(pinned)) throw new AgentMuxError('The operation ID belongs to another admission.', 'CONFIG_CONFLICT')
      return await this.active.get(operationId) ?? (await this.inspect(captured, operationId))!
    }
    const scope = maintenanceScope(captured)
    if (this.targets.has(scope)) throw new AgentMuxError('This exact Core already has an upgrade in progress.', 'CONFIG_CONFLICT')
    const prior = await this.latest(captured)
    if (prior?.status === 'running' || prior?.status === 'unknown') throw new AgentMuxError('The previous Core update is unconfirmed. Inspect that original operation; do not replay it.', 'CONFIG_CONFLICT')
    this.targets.add(scope)
    const work = this.execute(captured, pinned, operationId)
    this.active.set(operationId, work)
    try { return await work } finally { this.active.delete(operationId); this.targets.delete(scope) }
  }
  private async execute(input: RemoteCoreUpgradeHost, expected: RemoteCoreUpgradeExpected, operationId: string): Promise<RemoteCoreUpgradeReceipt> {
    const value: RetainedOperation = { receipt: { input, expected, operationId, status: 'running', stage: 'preparing', detail: '正在准备离线 Core 候选。', updatedAt: Date.now() } }
    let mutation = false
    /** The remote program confirmed the candidate never started; the operation simply did not apply. */
    let notApplied = false
    let lease: FileHandle | undefined
    let admitted = false
    try {
      await mkdir(join(this.options.stateDirectory, 'operations'), { recursive: true, mode: 0o700 })
      lease = await open(join(this.options.stateDirectory, 'operations', maintenanceScope(input) + '.lock'), 'a+', 0o600)
      if (!native.tryLock(lease.fd)) throw new AgentMuxError('Another owner is maintaining this exact Core.', 'CONFIG_CONFLICT')
      const existing = await this.read(operationId)
      if (existing) {
        if (JSON.stringify(existing.receipt.expected) !== JSON.stringify(expected)) throw new AgentMuxError('This operation ID belongs to another admission.', 'CONFIG_CONFLICT')
        return (await this.inspect(input, operationId))!
      }
      const original = await this.unconfirmedInScope(input, operationId)
      if (original) throw new AgentMuxError(`Core maintenance for Host ${original.input.id} is unconfirmed. Inspect original operation ${original.operationId} before admitting another update.`, 'CONFIG_CONFLICT')
      // Claim the original business ID before writing any phase. Separate manager
      // instances and route aliases cannot overwrite another admitted operation.
      // The complete record is synced under a private name and then linked
      // exclusively, so a crash never leaves an empty or partial operation.
      const staging = `${this.path(operationId)}.${process.pid}.${mintObjectId()}.reserve`
      try {
        const reservation = await open(staging, 'wx', 0o600)
        try { await reservation.writeFile(JSON.stringify(value) + '\n'); await reservation.sync() }
        finally { await reservation.close() }
        await link(staging, this.path(operationId))
      } finally { await unlink(staging).catch(() => { /* A private staging name is never read as an operation. */ }) }
      admitted = true
      await this.save(value)
      const artifact = await this.artifact(), replacing = expected.nativeReplacement !== undefined, observed = await this.observe(input, !replacing)
      this.admit(input, artifact, observed, expected)
      value.receipt.candidate = this.candidateSummary(artifact)
      value.observed = observed
      const stage = await this.program<{ releaseDirectory: string; remoteCommand: string; digest: string }>(input, observed.launch.node, ['-e', STAGE_CORE], {
        stateDirectory: observed.launch.stateDirectory, node: observed.launch.node, digest: artifact.digest, operationId,
        archive: (await readFile(artifact.archivePath)).toString('base64'), archiveDigest: artifact.archiveDigest, files: artifact.files })
      if (stage.digest !== artifact.digest || stage.releaseDirectory !== join(observed.launch.stateDirectory, 'core-releases', artifact.digest) || stage.remoteCommand !== join(stage.releaseDirectory, 'launcher', 'amux')) {
        throw new AgentMuxError('The staging receipt belongs to another artifact.', 'CONTROL_PROTOCOL_ERROR')
      }
      value.releaseDirectory = stage.releaseDirectory; value.receipt.remoteCommand = stage.remoteCommand
      value.receipt.stage = 'staged'; value.receipt.detail = '候选已核验，正在重新核对原服务。'; await this.save(value)
      const current = await this.observe(input, !replacing)
      this.admit(input, artifact, current, expected)
      if (current.launch.nativeSha256 !== observed.launch.nativeSha256 || current.launch.deploymentDigest !== observed.launch.deploymentDigest) throw new AgentMuxError('The original owner or software changed while staging; no owner was stopped.', 'CONFIG_CONFLICT')
      if (replacing) {
        // Free space and the exact process are read once more before anything stops.
        await this.replacementPlan(input, current)
        value.receipt.nativeReplacement = { endedRunIds: [] }
      }
      // The stop is admitted against the latest exact inventory of the same Native instance.
      value.observed = current
      value.receipt.stage = 'stopping'; value.receipt.detail = '正在停止原 Core 服务；Agent Run 保留。'; await this.save(value)
      mutation = true
      const response = parseRemoteCoreMaintenanceShutdown(await this.program(input, current.launch.node, ['-e', READ_CORE_MAINTENANCE], {
        launch: current.launch, socket: input.kind === 'ssh' ? input.remoteSocketPath : undefined, runtimeId: expected.runtimeId,
        shutdown: { ownerInstanceId: expected.ownerInstanceId, processId: expected.processId, sourceDigest: current.launch.deploymentDigest } }))
      if (response.owner.runtimeId !== expected.runtimeId || response.owner.ownerInstanceId !== expected.ownerInstanceId || response.owner.processId !== expected.processId || response.owner.ctxmux.instanceId !== expected.nativeInstanceId) throw new AgentMuxError('Core shutdown has an unknown response.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      let gone = false
      for (let attempt = 0; attempt < 80 && !gone; attempt++) {
        gone = (await this.program<{ gone: boolean }>(input, '/usr/bin/python3', ['-c', OWNER_GONE], { pid: expected.processId, startTicks: expected.startTicks })).gone === true
        if (!gone) await wait()
      }
      if (!gone) throw new AgentMuxError('The original Core shutdown is unconfirmed; no second owner was started.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      if (replacing) {
        value.receipt.stage = 'replacing-native'; value.receipt.detail = '原 Core 已停止，正在停止原 Native 并保存状态副本。'; await this.save(value)
        const copyDirectory = join(current.launch.stateDirectory, 'core-releases', `${operationId}.native-state`)
        const replaced = await this.program<{ outcome?: unknown; detail?: unknown; stateCopy?: unknown; survivingProcessIds?: unknown }>(input, current.launch.node, ['-e', REPLACE_NATIVE],
          this.replacementInput(current, true, copyDirectory))
        if (replaced.outcome === 'refused' || replaced.outcome === 'copy-failed') {
          // Confirmed before the candidate started: bring back the original Core on its original release.
          notApplied = true
          const restored = await this.restoreOriginal(input, current, operationId)
          throw new AgentMuxError(`${typeof replaced.detail === 'string' ? replaced.detail : 'The Native replacement did not proceed.'} ` +
            (replaced.outcome === 'refused' ? '原 Native 未停止；' : '原 Native 已停止且其运行中的进程已结束；') + restored, 'CORE_UPGRADE_UNAVAILABLE')
        }
        if (replaced.outcome !== 'replaced' || replaced.stateCopy !== copyDirectory || !Array.isArray(replaced.survivingProcessIds) || !replaced.survivingProcessIds.every(pid => Number.isSafeInteger(pid) && pid > 0)) {
          throw new AgentMuxError('The original Native stop or its state copy is unconfirmed; no new Native was started.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
        }
        value.receipt.nativeReplacement = { stateCopy: copyDirectory, endedRunIds: [], survivingProcessIds: replaced.survivingProcessIds as number[] }
      }
      value.receipt.stage = 'starting'; value.receipt.detail = '正在原目录和 namespace 中启动新 Core。'; await this.save(value)
      await this.program(input, observed.launch.node, ['-e', START_CORE], { ...observed.launch, operationId, releaseDirectory: stage.releaseDirectory })
      value.receipt.stage = 'verifying'; value.receipt.detail = '正在核对原 Runtime、Session 和运行进程。'; await this.save(value)
      const target = { ...input, remoteCommand: stage.remoteCommand }
      let next: Observed | undefined, last: unknown
      for (let attempt = 0; attempt < 30; attempt++) {
        try { next = await this.observe(target); break } catch (error) { last = error; await wait() }
      }
      if (!next) throw new AgentMuxError(`新 Core 的启动结果尚未确认：${errorText(last)}`, 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      if (replacing) {
        const ended = this.verifyReplacement(current, next, artifact.digest)
        value.receipt.nativeReplacement = { ...value.receipt.nativeReplacement!, endedRunIds: ended }
      } else this.verify(current, next, artifact.digest)
      await this.select(input, observed.launch, artifact.digest, operationId)
      value.receipt.status = 'completed'; value.receipt.stage = 'completed'
      value.receipt.detail = replacing ? `Core 与 Native Runtime 已升级；原 Runtime、Session 与历史保留，${value.receipt.nativeReplacement!.endedRunIds.length} 个运行中的进程已结束，可沿原 Session 恢复。`
        : 'Core 已升级，原 Runtime、Session 和运行进程已保留。'
    } catch (error) {
      if (!admitted) throw error
      value.receipt.status = mutation && !notApplied ? 'unknown' : 'failed'
      // A stop that may have happened with no candidate started leaves this Host without a Core.
      const coreStopped = value.receipt.stage === 'replacing-native' ? ' 原 Core 已停止；请在该 Host 上用原启动方式重新启动 Core，再复查此操作。' : ''
      value.receipt.detail = errorText(error) + (notApplied ? '' : mutation ? ' 原操作不会自动重放；请复查此操作。' + coreStopped : ' 原 Core 和运行进程未停止。')
    } finally {
      try { if (admitted) await this.save(value) }
      finally { await lease?.close() }
    }
    return structuredClone(value.receipt)
  }
  /** The exact checked owner and candidate. A Native replacement may proceed when running
   * Runs ended on their own; a Run the user has not reviewed ending refuses it. */
  private admit(input: RemoteCoreUpgradeHost, artifact: PortableCoreArtifact, observed: Observed, expected: RemoteCoreUpgradeExpected): void {
    const { nativeReplacement: _accepted, ...pinned } = expected, { nativeReplacement: _current, ...actual } = this.expected(input, artifact, observed)
    if (JSON.stringify(actual) !== JSON.stringify(pinned)) throw new AgentMuxError('The checked owner or candidate changed. Check again before upgrading.', 'CONFIG_CONFLICT')
    if (!expected.nativeReplacement) return
    const accepted = new Set(expected.nativeReplacement.endingRunIds)
    const unreviewed = observed.nativeRuns.filter(run => run.state === 'running' && !accepted.has(run.runId))
    if (unreviewed.length) throw new AgentMuxError(`${unreviewed.length} running process${unreviewed.length === 1 ? '' : 'es'} started after the review. Check again and review what ends; nothing was stopped.`, 'CONFIG_CONFLICT')
  }
  /** Starts the original Core from its original release after a confirmed refusal. Its own
   * adapter brings back a Native on the unchanged state directory. */
  private async restoreOriginal(input: RemoteCoreUpgradeHost, original: Observed, operationId: string): Promise<string> {
    const releaseDirectory = dirname(dirname(original.launch.cli))
    try {
      await this.program(input, original.launch.node, ['-e', START_CORE], { ...original.launch, operationId: `${operationId}-restore`, releaseDirectory })
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const back = await this.observe(input, false)
          if (back.owner.runtimeId === original.owner.runtimeId && back.launch.deploymentDigest === original.launch.deploymentDigest) return '原 Core 已用原发行恢复服务。'
        } catch { /* The original Core may still be starting. */ }
        await wait()
      }
      return '原 Core 已按原发行启动，但尚未确认恢复服务；请检查此 Host。'
    } catch (error) { return `原 Core 未能自动恢复（${errorText(error)}）；请在此 Host 上运行原启动命令。` }
  }
  /** A cold Native replacement keeps the durable Runtime, every Session binding and retained
   * history. The original running Runs end; their processes are not adopted. Returns them. */
  private verifyReplacement(previous: Observed, next: Observed, digest: string): string[] {
    // A cold start keeps the durable runtime ID and always begins a new daemon instance.
    if (next.launch.deploymentDigest !== digest || next.owner.runtimeId !== previous.owner.runtimeId || next.owner.ownerInstanceId === previous.owner.ownerInstanceId ||
        next.nativeRuntime.runtimeId !== previous.nativeRuntime.runtimeId || next.nativeRuntime.daemonInstanceId === previous.nativeRuntime.daemonInstanceId) {
      throw new AgentMuxError('The replaced Native did not keep the original durable Runtime.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    assertAgentMuxRuntimeCompatibility(next.nativeRuntime)
    this.verifySessions(previous, next)
    for (const run of previous.nativeRuns) {
      const after = next.nativeRuns.find(candidate => candidate.runId === run.runId)
      // History already made durable stays readable; a running Run ends without an owner.
      if (!after || run.durableOutputBytes !== null && after.outputBytes < run.durableOutputBytes ||
          after.state === 'running' || run.state !== 'running' && after.state !== run.state) {
        throw new AgentMuxError(`Original Run ${run.runId} history or state after the Native replacement is unconfirmed.`, 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      }
    }
    return previous.nativeRuns.filter(run => run.state === 'running').map(run => run.runId)
  }
  /** Points the remote restart entry at the confirmed release; a lost reply stays unknown. */
  private async select(input: RemoteCoreUpgradeHost, launch: Launch, digest: string, operationId: string): Promise<void> {
    const selected = await this.program<{ current?: unknown }>(input, launch.node, ['-e', SELECT_CORE_RELEASE], { stateDirectory: launch.stateDirectory, digest, operationId })
    if (selected.current !== digest) throw new AgentMuxError('The restart release receipt belongs to another release.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
  }
  private verify(previous: Observed, next: Observed, digest: string): void {
    if (next.launch.deploymentDigest !== digest || next.owner.runtimeId !== previous.owner.runtimeId || next.owner.ownerInstanceId === previous.owner.ownerInstanceId ||
        next.owner.ctxmux.instanceId !== previous.owner.ctxmux.instanceId || next.launch.nativeProcessId !== previous.launch.nativeProcessId ||
        next.launch.nativeStartTicks !== previous.launch.nativeStartTicks || next.launch.nativeSha256 !== previous.launch.nativeSha256 ||
        !isDeepStrictEqual(next.nativeRuntime, previous.nativeRuntime)) {
      throw new AgentMuxError('The new Core did not retain the original Runtime or candidate identity.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    this.verifySessions(previous, next)
    this.verifyRuns(previous.nativeRuns, next.nativeRuns)
  }
  private verifySessions(previous: Observed, next: Observed): void {
    for (const session of previous.bootstrap.sessions) {
      const retained = next.bootstrap.sessions.find(candidate => candidate.agentSessionId === session.agentSessionId)
      if (!retained || JSON.stringify(retained.run) !== JSON.stringify(session.run)) throw new AgentMuxError('An original Session/Run binding is unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
  }
  private verifyRuns(previous: RemoteCoreUpgradeNativeRun[], next: RemoteCoreUpgradeNativeRun[]): void {
    for (const before of previous) {
      const after = next.find(run => run.runId === before.runId)
      if (!after || after.pid !== before.pid && !(after.state === 'exited' && after.pid === null) || after.outputBytes < before.outputBytes ||
          before.inputBytes !== null && (after.inputBytes === null ? after.state !== 'exited' : after.inputBytes < before.inputBytes) ||
          before.state === 'running' && after.state !== 'running' && after.state !== 'exited' ||
          before.state !== 'running' && after.state === 'running') {
        throw new AgentMuxError('Original Run process or ordered byte continuity is unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      }
    }
  }
}

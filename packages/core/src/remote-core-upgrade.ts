import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { SshExecutionHost, type ExecutionHost } from './execution-host.js'
import { assertAgentMuxRuntimeCompatibility } from './ctxmux-run-adapter.js'
import type { AgentMuxRunState, AgentMuxRuntimeCompatibilityInput } from './types.js'
import { createPortableCoreArtifact, type PortableCoreArtifact } from './portable-core-artifact.js'
import { INSPECT_CORE_OWNER, READ_CORE_MAINTENANCE, OWNER_GONE, STAGE_CORE, START_CORE, NATIVE_RUN_INVENTORY } from './remote-core-upgrade-programs.js'
import { parseRemoteCoreUpgradeExpected, parseRemoteCoreMaintenanceObservation, parseRemoteCoreMaintenanceShutdown } from './remote-core-upgrade-codec.js'

export type RemoteCoreUpgradeHost = { id: string; kind: 'local'; label: string } | {
  id: string; kind: 'ssh'; label: string; hostname: string; user?: string; port?: number; identityFile?: string
  remoteCommand?: string; remoteSocketPath?: string; runtimeId?: string
}
export type RemoteCoreUpgradeExpected = {
  targetDigest: string; runtimeId: string; ownerInstanceId: string; processId: number; startTicks: string
  candidateDigest: string; nativeInstanceId: string; nativeProcessId: number; nativeStartTicks: string
}
export type RemoteCoreUpgradeCandidate = Pick<PortableCoreArtifact, 'digest' | 'sourceCommit' | 'protocolVersion'>
export type RemoteCoreUpgradeCheck = {
  input: RemoteCoreUpgradeHost; candidate: RemoteCoreUpgradeCandidate; eligible: boolean; detail: string
  reason: 'ready' | 'runtime-update-required' | 'unverified'
  expected?: RemoteCoreUpgradeExpected
  latestOperation?: RemoteCoreUpgradeReceipt
}
export type RemoteCoreUpgradeReceipt = {
  input: RemoteCoreUpgradeHost; operationId: string; expected: RemoteCoreUpgradeExpected
  status: 'running' | 'completed' | 'failed' | 'unknown'
  stage: 'preparing' | 'staged' | 'stopping' | 'starting' | 'verifying' | 'completed'
  detail: string; remoteCommand?: string; updatedAt: number
}
type Launch = { node: string; cli: string; cwd: string; processId: number; startTicks: string; env: Record<string, string>
  stateDirectory: string; runtimeDirectory: string; storePath: string; nativeSha256: string; nativeProcessId: number; nativeStartTicks: string
  nativeArtifactDirectory: string; nativeManifestSha256: string; nativeInstanceId: string; nativeRuntimeId: string; nativeBuildId: string
  platform: string; deploymentDigest: string }
export type RemoteCoreUpgradeNativeRun = { runId: string; pid: number | null; state: AgentMuxRunState; outputBytes: number; inputBytes: number | null }
type RunObservation = RemoteCoreUpgradeNativeRun & { agentSessionId: string }
export type RemoteCoreMaintenanceOwner = { runtimeId: string; ownerInstanceId: string; processId: number
  ctxmux: { instanceId: string; processId: number | null; buildIdentity: string; protocolVersion: number } }
export type RemoteCoreMaintenanceObservation = { owner: RemoteCoreMaintenanceOwner
  bootstrap: { storePath: string; hostProcessId: number; sessions: { agentSessionId: string; run: { runId: string } }[] }
  runs: RunObservation[]
  /** Exact typed Native run_not_found observations; never Session terminal facts. */
  missingRunIds: string[]
  nativeRuntime: AgentMuxRuntimeCompatibilityInput & { daemonInstanceId: string; runtimeId: string } }
type Observed = RemoteCoreMaintenanceObservation & { launch: Launch }
type RetainedOperation = { receipt: RemoteCoreUpgradeReceipt; observed?: Observed; releaseDirectory?: string; nativeRuns?: RemoteCoreUpgradeNativeRun[] }
export type RemoteCoreUpgradeOptions = {
  stateDirectory: string; packageRoot?: string
  /** The execution port supports a headless client without Desktop ownership. */
  executionHost?: (host: RemoteCoreUpgradeHost) => ExecutionHost
  artifact?: () => Promise<PortableCoreArtifact>
}
export function remoteCoreUpgradeTargetDigest(host: RemoteCoreUpgradeHost): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(host).filter(([key]) => key !== 'label').sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const wait = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 250))
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
function maintenanceScope(input: RemoteCoreUpgradeHost): string {
  // A verified durable Runtime UUID is the authority, even when SSH uses another
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
    if (input.kind !== 'ssh') throw new AgentMuxError('Only explicitly configured SSH headless Core owners can be upgraded here.', 'CORE_UPGRADE_UNAVAILABLE')
    return this.options.executionHost?.(input) ?? new SshExecutionHost(input)
  }
  private async program<T>(input: RemoteCoreUpgradeHost, command: string, args: string[], params: unknown): Promise<T> {
    const result = await this.host(input).run(command, args, { input: JSON.stringify(params), timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0) throw new AgentMuxError(result.stderr.trim() || 'The maintenance command did not complete.', 'CORE_UPGRADE_UNAVAILABLE')
    try { return JSON.parse(result.stdout.trim()) as T }
    catch { throw new AgentMuxError('The maintenance command returned an unknown receipt.', 'CORE_UPGRADE_RESPONSE_UNKNOWN') }
  }
  private async observe(input: RemoteCoreUpgradeHost): Promise<Observed> {
    if (input.kind !== 'ssh' || !input.remoteCommand?.startsWith('/') || !input.remoteSocketPath?.startsWith('/') || !input.runtimeId) {
      throw new AgentMuxError('Save an explicit remote Core command, socket and verified Runtime identity before upgrading.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    const launch = await this.program<Launch>(input, '/usr/bin/python3', ['-c', INSPECT_CORE_OWNER], {
      socket: input.remoteSocketPath, runtimeId: input.runtimeId })
    if (launch.platform !== 'linux-x64' || !/^\d+$/u.test(launch.startTicks) || !/^\d+$/u.test(launch.nativeStartTicks) ||
      !Number.isSafeInteger(launch.processId) || launch.processId < 1 || !Number.isSafeInteger(launch.nativeProcessId) || launch.nativeProcessId < 1 ||
      !launch.node.startsWith('/') || !/^[a-f0-9]{64}$/u.test(launch.deploymentDigest)) {
      throw new AgentMuxError('The original process launch identity is not qualified.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    const observed = parseRemoteCoreMaintenanceObservation(await this.program(input, launch.node, ['-e', READ_CORE_MAINTENANCE], {
      launch, socket: input.remoteSocketPath, runtimeId: input.runtimeId }))
    if (observed.owner.runtimeId !== input.runtimeId || observed.owner.processId !== launch.processId || observed.bootstrap.storePath !== launch.storePath ||
      observed.nativeRuntime.daemonInstanceId !== launch.nativeInstanceId || observed.nativeRuntime.runtimeId !== launch.nativeRuntimeId || observed.nativeRuntime.buildId !== launch.nativeBuildId) {
      throw new AgentMuxError('The maintenance observation belongs to another process, Native or Store.', 'CORE_UPGRADE_UNAVAILABLE')
    }
    assertAgentMuxRuntimeCompatibility(observed.nativeRuntime)
    // Recheck OS leases, image and package after the producer's strict read.
    const after = await this.program<Launch>(input, '/usr/bin/python3', ['-c', INSPECT_CORE_OWNER], {
      pid: launch.processId, startTicks: launch.startTicks, nativePid: launch.nativeProcessId,
      socket: input.remoteSocketPath, store: launch.storePath, runtimeId: input.runtimeId })
    if (JSON.stringify(after) !== JSON.stringify(launch)) throw new AgentMuxError('The original process or software changed during observation.', 'CORE_UPGRADE_UNAVAILABLE')
    return { ...observed, launch }
  }
  private expected(input: RemoteCoreUpgradeHost, artifact: PortableCoreArtifact, observed: Observed): RemoteCoreUpgradeExpected {
    return { targetDigest: remoteCoreUpgradeTargetDigest(input), runtimeId: observed.owner.runtimeId,
      ownerInstanceId: observed.owner.ownerInstanceId, processId: observed.owner.processId, startTicks: observed.launch.startTicks,
      candidateDigest: artifact.digest, nativeInstanceId: observed.owner.ctxmux.instanceId, nativeProcessId: observed.launch.nativeProcessId, nativeStartTicks: observed.launch.nativeStartTicks }
  }
  async check(input: RemoteCoreUpgradeHost): Promise<RemoteCoreUpgradeCheck> {
    const captured = structuredClone(input), artifact = await this.artifact()
    const candidate = { digest: artifact.digest, sourceCommit: artifact.sourceCommit, protocolVersion: artifact.protocolVersion }
    const latestOperation = await this.latest(captured)
    const prior = latestOperation ? { latestOperation } : {}
    if (latestOperation?.status === 'unknown' || latestOperation?.status === 'running') return { input: captured, candidate, ...prior, eligible: false, reason: 'unverified',
      detail: '此前的升级结果尚未确认。请复查原操作；不会再次停止或启动 Core。' }
    const scoped = await this.unconfirmedInScope(captured)
    if (scoped) return { input: captured, candidate, ...prior, eligible: false, reason: 'unverified',
      detail: `同一 Core 的连接 ${scoped.input.id} 有未确认的维护操作 ${scoped.operationId}。请复查该原操作；不会再次停止或启动 Core。` }
    try {
      const observed = await this.observe(captured)
      return { input: captured, candidate, ...prior, eligible: true, reason: 'ready', expected: this.expected(captured, artifact, observed),
        detail: '已核对原 Core、启动目录和 Runtime。升级仅重启 Core 服务，保留原 Session 和运行进程。' }
    } catch (error) { return { input: captured, candidate, ...prior, eligible: false,
      reason: error instanceof AgentMuxError && error.code === 'CTXMUX_OWNER_IDENTITY_UNPROVEN' ? 'runtime-update-required' : 'unverified', detail: errorText(error) } }
  }
  private path(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new AgentMuxError('Upgrade operation ID is invalid.', 'INVALID_CONTROL_REQUEST')
    return join(this.options.stateDirectory, 'operations', operationId + '.json')
  }
  private async read(operationId: string): Promise<RetainedOperation | null> {
    try { return JSON.parse(await readFile(this.path(operationId), 'utf8')) as RetainedOperation }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
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
  private async latest(input: RemoteCoreUpgradeHost): Promise<RemoteCoreUpgradeReceipt | undefined> {
    let names: string[]
    try { names = await readdir(join(this.options.stateDirectory, 'operations')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const matches: RemoteCoreUpgradeReceipt[] = []
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name)) continue
      const value = await this.read(name.slice(0, -5))
      if (value && this.matches(input, value.receipt)) matches.push(value.receipt)
    }
    matches.sort((a, b) => Number(b.status === 'running' || b.status === 'unknown') - Number(a.status === 'running' || a.status === 'unknown') || b.updatedAt - a.updatedAt)
    return matches[0] ? (await this.inspect(input, matches[0].operationId)) ?? undefined : undefined
  }
  private async unconfirmedInScope(input: RemoteCoreUpgradeHost, excluding?: string): Promise<RemoteCoreUpgradeReceipt | undefined> {
    let names: string[]
    try { names = await readdir(join(this.options.stateDirectory, 'operations')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/u.test(name) || name === excluding + '.json') continue
      const value = await this.read(name.slice(0, -5))
      if (value && maintenanceScope(value.receipt.input) === maintenanceScope(input) &&
        (value.receipt.status === 'running' || value.receipt.status === 'unknown')) return value.receipt
    }
    return undefined
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
    if (retained.receipt.status === 'unknown' && retained.observed && retained.releaseDirectory && retained.receipt.remoteCommand && retained.receipt.input.kind === 'ssh') {
      try {
        const next = await this.observe({ ...retained.receipt.input, remoteCommand: retained.receipt.remoteCommand })
        this.verify(retained.observed, next, retained.receipt.expected.candidateDigest)
        if (!retained.nativeRuns) throw new AgentMuxError('The original Native inventory is unknown.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
        this.verifyRuns(retained.nativeRuns, await this.nativeRuns(retained.receipt.input, retained.observed.launch, retained.releaseDirectory, retained.receipt.expected.nativeInstanceId))
        retained.receipt.status = 'completed'; retained.receipt.stage = 'completed'; retained.receipt.detail = '已复查原操作：新 Core 已运行，原 Runtime 和 Session/Run 绑定保留。'
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
      const reservation = await open(this.path(operationId), 'wx', 0o600)
      try { await reservation.writeFile(JSON.stringify(value) + '\n'); await reservation.sync() }
      finally { await reservation.close() }
      admitted = true
      await this.save(value)
      const artifact = await this.artifact(), observed = await this.observe(input)
      if (JSON.stringify(this.expected(input, artifact, observed)) !== JSON.stringify(expected)) throw new AgentMuxError('The checked owner or candidate changed. Check again before upgrading.', 'CONFIG_CONFLICT')
      value.observed = observed
      const stage = await this.program<{ releaseDirectory: string; remoteCommand: string; digest: string }>(input, observed.launch.node, ['-e', STAGE_CORE], {
        stateDirectory: observed.launch.stateDirectory, node: observed.launch.node, digest: artifact.digest, operationId,
        archive: (await readFile(artifact.archivePath)).toString('base64'), archiveDigest: artifact.archiveDigest, files: artifact.files })
      if (stage.digest !== artifact.digest || stage.releaseDirectory !== join(observed.launch.stateDirectory, 'core-releases', artifact.digest) || stage.remoteCommand !== join(stage.releaseDirectory, 'launcher', 'amux')) {
        throw new AgentMuxError('The staging receipt belongs to another artifact.', 'CONTROL_PROTOCOL_ERROR')
      }
      value.releaseDirectory = stage.releaseDirectory; value.receipt.remoteCommand = stage.remoteCommand
      value.receipt.stage = 'staged'; value.receipt.detail = '候选已核验，正在重新核对原服务。'; await this.save(value)
      const current = await this.observe(input)
      if (JSON.stringify(this.expected(input, artifact, current)) !== JSON.stringify(expected) || current.launch.nativeSha256 !== observed.launch.nativeSha256 || current.launch.deploymentDigest !== observed.launch.deploymentDigest) throw new AgentMuxError('The original owner or software changed while staging; no owner was stopped.', 'CONFIG_CONFLICT')
      value.nativeRuns = await this.nativeRuns(input, observed.launch, stage.releaseDirectory, expected.nativeInstanceId)
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
      value.receipt.stage = 'starting'; value.receipt.detail = '正在原目录和 namespace 中启动新 Core。'; await this.save(value)
      await this.program(input, observed.launch.node, ['-e', START_CORE], { ...observed.launch, operationId, releaseDirectory: stage.releaseDirectory })
      value.receipt.stage = 'verifying'; value.receipt.detail = '正在核对原 Runtime、Session 和运行进程。'; await this.save(value)
      const target = { ...input, remoteCommand: stage.remoteCommand }
      let next: Observed | undefined, last: unknown
      for (let attempt = 0; attempt < 30; attempt++) {
        try { next = await this.observe(target); break } catch (error) { last = error; await wait() }
      }
      if (!next) throw new AgentMuxError(`新 Core 的启动结果尚未确认：${errorText(last)}`, 'CORE_UPGRADE_RESPONSE_UNKNOWN')
      this.verify(observed, next, artifact.digest)
      this.verifyRuns(value.nativeRuns, await this.nativeRuns(target, next.launch, stage.releaseDirectory, expected.nativeInstanceId))
      value.receipt.status = 'completed'; value.receipt.stage = 'completed'; value.receipt.detail = 'Core 已升级，原 Runtime、Session 和运行进程已保留。'
    } catch (error) {
      if (!admitted) throw error
      value.receipt.status = mutation ? 'unknown' : 'failed'
      value.receipt.detail = errorText(error) + (mutation ? ' 原操作不会自动重放；请复查此操作。' : ' 原 Core 和运行进程未停止。')
    } finally {
      try { if (admitted) await this.save(value) }
      finally { await lease?.close() }
    }
    return structuredClone(value.receipt)
  }
  private verify(previous: Observed, next: Observed, digest: string): void {
    if (next.launch.deploymentDigest !== digest || next.owner.runtimeId !== previous.owner.runtimeId || next.owner.ownerInstanceId === previous.owner.ownerInstanceId ||
        next.owner.ctxmux.instanceId !== previous.owner.ctxmux.instanceId || next.launch.nativeProcessId !== previous.launch.nativeProcessId ||
        next.launch.nativeStartTicks !== previous.launch.nativeStartTicks || next.launch.nativeSha256 !== previous.launch.nativeSha256) {
      throw new AgentMuxError('The new Core did not retain the original Runtime or candidate identity.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    for (const session of previous.bootstrap.sessions) {
      const retained = next.bootstrap.sessions.find(candidate => candidate.agentSessionId === session.agentSessionId)
      if (!retained || JSON.stringify(retained.run) !== JSON.stringify(session.run)) throw new AgentMuxError('An original Session/Run binding is unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    this.verifyRuns(previous.runs, next.runs)
  }
  private async nativeRuns(input: RemoteCoreUpgradeHost, launch: Launch, releaseDirectory: string, instanceId: string): Promise<RemoteCoreUpgradeNativeRun[]> {
    const result = await this.program<{ instanceId: string; protocolVersion: number; runs: RemoteCoreUpgradeNativeRun[] }>(input, launch.node, ['-e', NATIVE_RUN_INVENTORY], {
      releaseDirectory, socketPath: join(launch.runtimeDirectory, 'ctxmux.sock'), instanceId })
    if (result.instanceId !== instanceId || result.protocolVersion !== (await this.artifact()).protocolVersion || !Array.isArray(result.runs)) throw new AgentMuxError('The original Native inventory is unconfirmed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    for (const run of result.runs) if (typeof run.runId !== 'string' || !run.runId ||
      !['running', 'exited', 'interrupted'].includes(run.state) || run.pid !== null && (!Number.isSafeInteger(run.pid) || run.pid < 1) ||
      !Number.isSafeInteger(run.outputBytes) || run.outputBytes < 0 || run.inputBytes !== null && (!Number.isSafeInteger(run.inputBytes) || run.inputBytes < 0)) {
      throw new AgentMuxError('A Native Run observation is malformed.', 'CORE_UPGRADE_RESPONSE_UNKNOWN')
    }
    return result.runs
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

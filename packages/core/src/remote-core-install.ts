import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { durableWriteFile } from './durable-write.js'
import { SshExecutionHost, type ExecutionHost } from './execution-host.js'
import type { PortableCoreArtifact } from './portable-core-artifact.js'
import { linuxNodeArchive, type LinuxNodeArchive } from './linux-node.js'
import { remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeHost } from './remote-core-upgrade.js'
import { STAGE_CORE, SELECT_CORE_RELEASE } from './remote-core-upgrade-programs.js'
import { PROBE_CORE_INSTALL, INSTALL_NODE, INSTALL_SERVICE, READ_INSTALLED_OWNER } from './remote-core-install-programs.js'

export type RemoteCoreKeepRunning = 'start-script' | 'systemd'
/** What a read-only probe of the target Host found. */
export type RemoteCoreInstallProbe = {
  platform: string; machine: string; glibc: string | null; home: string; prefix: string; user: string
  /** A release is already installed under the prefix. */
  installed: boolean
  /** What answers on the prefix's control socket. */
  socket: 'absent' | 'stale' | 'serving' | 'other-file' | 'unknown'
  availableBytes: number
  systemd: { user: boolean; linger: boolean | null }
}
export type RemoteCoreInstallExpected = { targetDigest: string; prefix: string; candidateDigest: string; nodeSha256: string; keepRunning: RemoteCoreKeepRunning }
export type RemoteCoreInstallCheck = {
  input: RemoteCoreUpgradeHost
  probe?: RemoteCoreInstallProbe
  eligible: boolean
  /** ready: nothing installed and nothing serving; installed: only an upgrade applies. */
  reason: 'ready' | 'installed' | 'unsupported' | 'unverified'
  detail: string
  candidate?: { digest: string; sourceCommit: string | null; version: string | null }
  node?: { version: string; sha256: string }
  /** Ways the Core can stay running on this Host, in the order offered. */
  keepRunning?: { mode: RemoteCoreKeepRunning; available: boolean; startsAtBoot: boolean | null }[]
  /** Admission without keepRunning; the confirmation adds the chosen one. */
  expected?: Omit<RemoteCoreInstallExpected, 'keepRunning'>
}
export type RemoteCoreInstallReceipt = {
  input: RemoteCoreUpgradeHost; operationId: string; expected: RemoteCoreInstallExpected
  status: 'running' | 'completed' | 'failed' | 'unknown'
  stage: 'preparing' | 'pushing-node' | 'staging-core' | 'starting' | 'confirming' | 'completed'
  detail: string; updatedAt: number
  /** Filled as each stage confirms it; a completed install has all of them. */
  installed?: { remoteCommand: string; remoteSocketPath: string; runtimeId: string; startScript: string; unit: string | null }
}
export type RemoteCoreInstallOptions = {
  stateDirectory: string
  executionHost?: (host: RemoteCoreUpgradeHost) => ExecutionHost
  artifact: () => Promise<PortableCoreArtifact>
  node?: () => Promise<LinuxNodeArchive>
  /** How long to wait between identity reads while the new Core starts. */
  startPollMs?: number
}
type Retained = { receipt: RemoteCoreInstallReceipt }

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const MIN_GLIBC = [2, 34]
/** Room for the Core release, Node and the first state, well above their measured size. */
const MIN_FREE_BYTES = 512 * 1024 * 1024

function glibcSupported(version: string | null): boolean {
  const [major = 0, minor = 0] = (version ?? '').split('.').map(Number)
  return major > MIN_GLIBC[0]! || major === MIN_GLIBC[0] && minor >= MIN_GLIBC[1]!
}

/** Owns a first install of a remote headless Core. It never replaces a serving Core:
 * an installed or answering prefix is refused and left to the upgrade owner. */
export class RemoteCoreInstallManager {
  private readonly active = new Map<string, Promise<RemoteCoreInstallReceipt>>()
  constructor(private readonly options: RemoteCoreInstallOptions) {}
  private host(input: RemoteCoreUpgradeHost): ExecutionHost {
    if (input.kind !== 'ssh' || input.transport === 'tailcat') throw new AgentMuxError('A first Core install needs a saved SSH Host; Tailcat only reaches a Core that already runs.', 'CORE_INSTALL_UNAVAILABLE')
    return this.options.executionHost?.(input) ?? new SshExecutionHost(input)
  }
  private async run(input: RemoteCoreUpgradeHost, command: string, args: string[], stdin: string | Uint8Array): Promise<string> {
    const result = await this.host(input).run(command, args, { input: stdin, timeoutMs: 300_000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0) throw new AgentMuxError(result.stderr.trim() || 'The install command did not complete.', 'CORE_INSTALL_UNAVAILABLE')
    return result.stdout.trim()
  }
  private async program<T>(input: RemoteCoreUpgradeHost, command: string, args: string[], params: unknown): Promise<T> {
    const out = await this.run(input, command, args, JSON.stringify(params))
    try { return JSON.parse(out) as T } catch { throw new AgentMuxError('The install command returned an unknown receipt.', 'CORE_INSTALL_RESPONSE_UNKNOWN') }
  }
  private async node(): Promise<LinuxNodeArchive> {
    return await (this.options.node ?? (() => linuxNodeArchive(join(this.options.stateDirectory, 'linux-node'))))()
  }
  private async probe(input: RemoteCoreUpgradeHost, prefix: string | undefined): Promise<RemoteCoreInstallProbe> {
    return await this.program<RemoteCoreInstallProbe>(input, '/usr/bin/python3', ['-c', PROBE_CORE_INSTALL], { prefix: prefix ?? null })
  }
  private expected(input: RemoteCoreUpgradeHost, probe: RemoteCoreInstallProbe, artifact: PortableCoreArtifact, node: LinuxNodeArchive): Omit<RemoteCoreInstallExpected, 'keepRunning'> {
    return { targetDigest: remoteCoreUpgradeTargetDigest(input), prefix: probe.prefix, candidateDigest: artifact.digest, nodeSha256: node.sha256 }
  }
  /** Read-only. Nothing is written on the Host or in local operation records. */
  async check(input: RemoteCoreUpgradeHost, prefix?: string): Promise<RemoteCoreInstallCheck> {
    const captured = structuredClone(input)
    let probe: RemoteCoreInstallProbe
    try { probe = await this.probe(captured, prefix) }
    catch (error) { return { input: captured, eligible: false, reason: 'unverified', detail: `The Host could not be probed: ${errorText(error)}` } }
    const base = { input: captured, probe }
    if (probe.platform !== 'linux' || !['x86_64', 'amd64'].includes(probe.machine)) {
      return { ...base, eligible: false, reason: 'unsupported', detail: `This Host is ${probe.platform} ${probe.machine}; a first install supports Linux x64 only.` }
    }
    if (!glibcSupported(probe.glibc)) {
      return { ...base, eligible: false, reason: 'unsupported', detail: `This Host has glibc ${probe.glibc ?? 'unknown'}; the bundled runtime needs ${MIN_GLIBC.join('.')} or newer.` }
    }
    if (probe.installed || probe.socket === 'serving') {
      return { ...base, eligible: false, reason: 'installed', detail: 'A Core is already installed or serving here. Save its service command and socket, then use Core update; a first install never replaces it.' }
    }
    if (probe.socket === 'other-file' || probe.socket === 'unknown') {
      return { ...base, eligible: false, reason: 'unverified', detail: `The control socket under ${probe.prefix} could not be confirmed free (${probe.socket}). Nothing was changed.` }
    }
    if (probe.availableBytes < MIN_FREE_BYTES) {
      return { ...base, eligible: false, reason: 'unsupported', detail: `Installing needs ${MIN_FREE_BYTES} free bytes near ${probe.prefix}; ${probe.availableBytes} are available.` }
    }
    let artifact: PortableCoreArtifact, node: LinuxNodeArchive
    try { [artifact, node] = await Promise.all([this.options.artifact(), this.node()]) }
    catch (error) { return { ...base, eligible: false, reason: 'unverified', detail: `This app's install bundle is unavailable: ${errorText(error)}` } }
    return { ...base, eligible: true, reason: 'ready',
      detail: `Nothing is installed under ${probe.prefix}. Review how the Core stays running, then install.`,
      candidate: { digest: artifact.digest, sourceCommit: artifact.sourceCommit, version: artifact.version },
      node: { version: node.version, sha256: node.sha256 },
      keepRunning: [{ mode: 'start-script', available: true, startsAtBoot: false },
        { mode: 'systemd', available: probe.systemd.user, startsAtBoot: probe.systemd.user ? probe.systemd.linger : null }],
      expected: this.expected(captured, probe, artifact, node) }
  }
  private path(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new AgentMuxError('Install operation ID is invalid.', 'INVALID_CONTROL_REQUEST')
    return join(this.options.stateDirectory, 'install-operations', operationId + '.json')
  }
  private async read(operationId: string): Promise<Retained | null> {
    try { return JSON.parse(await readFile(this.path(operationId), 'utf8')) as Retained }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async save(value: Retained): Promise<void> {
    value.receipt.updatedAt = Date.now()
    await durableWriteFile(this.path(value.receipt.operationId), JSON.stringify(value) + '\n', { requireDirectorySync: true })
  }
  /** Reads the original operation. It never repeats a stage of it. */
  async inspect(input: RemoteCoreUpgradeHost, operationId: string): Promise<RemoteCoreInstallReceipt | null> {
    const retained = await this.read(operationId)
    if (!retained) return null
    if (retained.receipt.expected.targetDigest !== remoteCoreUpgradeTargetDigest(input)) throw new AgentMuxError('This install belongs to another Host configuration.', 'CONFIG_CONFLICT')
    if (retained.receipt.status === 'running' && !this.active.has(operationId)) {
      retained.receipt.status = 'unknown'
      retained.receipt.detail = 'The install owner stopped before confirming this install. It is kept as unknown and is not repeated.'
      await this.save(retained)
    }
    return structuredClone(retained.receipt)
  }
  async install(input: RemoteCoreUpgradeHost, expected: RemoteCoreInstallExpected, operationId: string): Promise<RemoteCoreInstallReceipt> {
    const captured = structuredClone(input)
    this.path(operationId)
    if (expected.targetDigest !== remoteCoreUpgradeTargetDigest(captured)) throw new AgentMuxError('Host input changed after the install check.', 'CONFIG_CONFLICT')
    if (expected.keepRunning !== 'start-script' && expected.keepRunning !== 'systemd') throw new AgentMuxError('Choose how the Core stays running.', 'INVALID_CONTROL_REQUEST')
    const retained = await this.read(operationId)
    if (retained) {
      if (JSON.stringify(retained.receipt.expected) !== JSON.stringify(expected)) throw new AgentMuxError('This operation ID belongs to another install.', 'CONFIG_CONFLICT')
      return await this.active.get(operationId) ?? (await this.inspect(captured, operationId))!
    }
    const work = this.execute(captured, expected, operationId)
    this.active.set(operationId, work)
    try { return await work } finally { this.active.delete(operationId) }
  }
  private async execute(input: RemoteCoreUpgradeHost, expected: RemoteCoreInstallExpected, operationId: string): Promise<RemoteCoreInstallReceipt> {
    const value: Retained = { receipt: { input, expected, operationId, status: 'running', stage: 'preparing', detail: 'Checking the Host again before installing.', updatedAt: Date.now() } }
    // Reserve the original ID exclusively, so another owner cannot admit the same operation.
    await mkdir(join(this.options.stateDirectory, 'install-operations'), { recursive: true, mode: 0o700 })
    const staging = `${this.path(operationId)}.${process.pid}.${mintObjectId()}.reserve`
    const reservation = await open(staging, 'wx', 0o600)
    try { await reservation.writeFile(JSON.stringify(value) + '\n'); await reservation.sync() } finally { await reservation.close() }
    try { await link(staging, this.path(operationId)) } finally { await unlink(staging).catch(() => {}) }
    let changed = false
    try {
      const [probe, artifact, node] = await Promise.all([this.probe(input, expected.prefix), this.options.artifact(), this.node()])
      const admitted = probe.prefix === expected.prefix && !probe.installed && (probe.socket === 'absent' || probe.socket === 'stale') &&
        artifact.digest === expected.candidateDigest && node.sha256 === expected.nodeSha256 && (expected.keepRunning !== 'systemd' || probe.systemd.user)
      if (!admitted) throw new AgentMuxError('The Host, the bundled Core or the chosen way to keep running changed since the check. Check again; nothing was installed.', 'CONFIG_CONFLICT')
      changed = true
      value.receipt.stage = 'pushing-node'; value.receipt.detail = `Copying Node ${node.version} to the Host.`; await this.save(value)
      const nodeBytes = await readFile(node.path)
      const { node: remoteNode } = JSON.parse(await this.run(input, '/bin/sh', ['-c', INSTALL_NODE, 'install-node', expected.prefix, node.version, node.sha256], Buffer.from(nodeBytes).toString('base64'))) as { node: string }
      if (remoteNode !== join(expected.prefix, 'node', node.version, 'bin', 'node')) throw new AgentMuxError('The Node install receipt names another location.', 'CORE_INSTALL_RESPONSE_UNKNOWN')
      value.receipt.stage = 'staging-core'; value.receipt.detail = 'Verifying and unpacking the Core release.'; await this.save(value)
      const state = join(expected.prefix, 'state')
      const staged = await this.program<{ releaseDirectory: string; digest: string }>(input, remoteNode, ['-e', STAGE_CORE], {
        stateDirectory: state, node: remoteNode, digest: artifact.digest, operationId,
        archive: (await readFile(artifact.archivePath)).toString('base64'), archiveDigest: artifact.archiveDigest, files: artifact.files })
      if (staged.digest !== artifact.digest || staged.releaseDirectory !== join(state, 'core-releases', artifact.digest)) throw new AgentMuxError('The staging receipt belongs to another release.', 'CORE_INSTALL_RESPONSE_UNKNOWN')
      const selected = await this.program<{ current?: unknown }>(input, remoteNode, ['-e', SELECT_CORE_RELEASE], { stateDirectory: state, digest: artifact.digest, operationId })
      if (selected.current !== artifact.digest) throw new AgentMuxError('The current release receipt belongs to another release.', 'CORE_INSTALL_RESPONSE_UNKNOWN')
      value.receipt.stage = 'starting'
      value.receipt.detail = expected.keepRunning === 'systemd' ? 'Writing the user service and starting the Core.' : 'Writing the start script and starting the Core.'; await this.save(value)
      const service = await this.program<{ remoteCommand: string; remoteSocketPath: string; startScript: string; unit: string | null }>(input, remoteNode, ['-e', INSTALL_SERVICE],
        { prefix: expected.prefix, node: remoteNode, home: probe.home, keepRunning: expected.keepRunning })
      if (service.remoteCommand !== join(expected.prefix, 'bin', 'amux') || service.remoteSocketPath !== join(expected.prefix, 'runtime', 'control.sock') ||
          (expected.keepRunning === 'systemd') !== (service.unit !== null)) throw new AgentMuxError('The service receipt names another location.', 'CORE_INSTALL_RESPONSE_UNKNOWN')
      value.receipt.stage = 'confirming'; value.receipt.detail = 'Reading the new Core identity.'; await this.save(value)
      let owner: { runtimeId?: unknown; availability?: unknown } | undefined, last: unknown
      for (let attempt = 0; attempt < 60 && !owner; attempt++) {
        try { owner = (await this.program<{ owner: { runtimeId?: unknown; availability?: unknown } }>(input, remoteNode, ['-e', READ_INSTALLED_OWNER], { releaseDirectory: staged.releaseDirectory, socket: service.remoteSocketPath })).owner }
        catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, this.options.startPollMs ?? 500)) }
      }
      if (!owner || typeof owner.runtimeId !== 'string' || !owner.runtimeId || owner.availability !== 'connected') {
        throw new AgentMuxError(`The new Core did not confirm its identity: ${errorText(last ?? 'no owner identity')}`, 'CORE_INSTALL_RESPONSE_UNKNOWN')
      }
      value.receipt.installed = { remoteCommand: service.remoteCommand, remoteSocketPath: service.remoteSocketPath, runtimeId: owner.runtimeId, startScript: service.startScript, unit: service.unit }
      value.receipt.status = 'completed'; value.receipt.stage = 'completed'
      value.receipt.detail = expected.keepRunning === 'systemd'
        ? probe.systemd.linger ? 'Installed. The Core runs as a user service and starts at boot.' : 'Installed. The Core runs as a user service; it starts at boot only after linger is enabled for this user.'
        : `Installed. After this machine restarts, run ${service.startScript} or start it from this app.`
    } catch (error) {
      // Before any remote write the install simply did not happen; after one, its outcome is unknown.
      value.receipt.status = changed ? 'unknown' : 'failed'
      value.receipt.detail = errorText(error) + (changed ? ' The install is kept as unknown; inspect this operation. It is not repeated or cleaned up.' : '')
    } finally { await this.save(value) }
    return structuredClone(value.receipt)
  }
}

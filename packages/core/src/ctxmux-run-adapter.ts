import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  Attachment,
  CtxmuxClient,
  CtxmuxCommandError,
  CtxmuxProtocolError,
  PROTOCOL_VERSION,
  RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_INPUT,
  RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_STOP,
  RUNTIME_CAPABILITY_NATIVE_START,
  RUNTIME_CAPABILITY_PERSISTENT_STATE,
  RUNTIME_CAPABILITY_PLANNED_EXEC_UPGRADE_CONTINUITY,
  createOperationKey,
  defineRun,
  type OutputChunk,
  type RecoverableStopOperation,
  type RunEvent,
  type RunInfo,
  type RuntimeIdentity
} from '@ctxmux/sdk'
import { AgentMuxError } from './errors.js'
import { classifyReplayGap } from './ctxmux-replay-gap.js'
import { classifyStreamEnd } from './ctxmux-stream-end.js'
import type { AgentMuxRunInputData } from './types.js'
import {
  reclaimOrphanEndpointDirectories,
  type EndpointReclaimOutcome
} from './runtime-endpoint-reclaim.js'
import {
  CTXMUX_MANIFEST_SHA256,
  defaultAgentMuxRuntimeDirectory,
  defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory
} from './runtime-paths.js'

// CTXMUX_COMMIT / CTXMUX_VERSION are exported because they are the SHA-verified originals: this
// module asserts them against the vendored manifest.json at load time (see verifyArtifacts —
// manifest.source.commit === CTXMUX_COMMIT and manifest.product.version === CTXMUX_VERSION, guarded
// by CTXMUX_MANIFEST_SHA256). Consumers that need to report the running runtime's version/commit
// (client.ts's runtimeDiagnostics and terminalEnvironment) MUST import these rather than retype the
// literals — a hand-copied '0.1.0' or 40-char SHA in client.ts drifts silently the moment the
// vendored artifact is bumped, and the doctor/about surface then confidently reports the wrong
// runtime with no compile error. Binding two consumers to this one validated source is the fix.
export const CTXMUX_COMMIT = 'c168c0ab9cd849bfade68461b62684982c71f688'
const CTXMUX_TREE = 'a2cc33fe7adac2b25110df58370e3dac17850e00'
export const CTXMUX_VERSION = '0.1.0'
const CTXMUX_RUNTIME_BUILD_ID = `ctxmuxd/${CTXMUX_VERSION}`
const REQUIRED_RUNTIME_CAPABILITIES = {
  [RUNTIME_CAPABILITY_NATIVE_START]: 1,
  [RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_INPUT]: 1,
  [RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_STOP]: 1,
  [RUNTIME_CAPABILITY_PERSISTENT_STATE]: 1,
  [RUNTIME_CAPABILITY_PLANNED_EXEC_UPGRADE_CONTINUITY]: 1
} as const
const DAEMON_READY_TIMEOUT_MS = 5_000
const DAEMON_POLL_INTERVAL_MS = 20
const DAEMON_READINESS_MAX_BYTES = 8 * 1024
const DAEMON_SHUTDOWN_TIMEOUT_MS = 2_000
const execFileAsync = promisify(execFile)

type ArtifactDescriptor = {
  name: string
  version: string
  protocol: number
  path: string
  sha256: string
  bytes: number
  mode: string
}

type ArtifactManifest = {
  schema: string
  source: { commit: string; tree: string; worktree_clean: boolean }
  product: { version: string; protocol: number }
  support: { platform: string; architecture: string; transport: string }
  sdk: { archive: { path: string; sha256: string; bytes: number; mode: string } }
  binaries: ArtifactDescriptor[]
}

type VerifiedArtifacts = {
  daemonPath: string
  daemonSha256: string
}

type OwnerReceipt = {
  schema: 'agentmux.ctxmux-owner.v1'
  sourceCommit: string
  sourceTree: string
  manifestSha256: string
  daemonSha256: string
  daemonPath: string
  socketPath: string
  stateDirectory: string
  daemonInstanceId: string
  runtimeId: string
  runtimeBuildId: string
}

export type CtxmuxAdapterStopOperation = {
  daemonInstance: string
  operationKey: string
  runId: string
}

export type CtxmuxAdapterRun = {
  runId: string
  lifecycleOperationId: string | null
  program: string | null
  args: readonly string[]
  workspacePath: string | null
  pid: number | null
  state:
    | { type: 'running' }
    | { type: 'exited'; code: number; signal: string | null }
    | { type: 'interrupted'; reason: string }
  /**
   * Owner-confirmed live PTY size, or `null` when no owner can confirm one.
   * This is `RunInfo.current_size`, never `RunSpec.size`.
   *
   * `null` is a real answer, not a missing one: a tmux-backed Run whose pane ctxmux only observes, or
   * a historical Run recovered without a live PTY. Consumers that compare a rendered screen for strict
   * equality must refuse to run on `null` rather than substitute a guess — see `screen-evidence.ts`,
   * where it becomes `TERMINAL_SIZE_UNKNOWN`.
   */
  cols: number | null
  rows: number | null
  latestOutputBytes: number
  firstAvailableByte: number
  acceptedInputBytes: number | null
}

export type CtxmuxAdapterDataEvent = {
  type: 'data'
  runId: string
  startByte: number
  endByte: number
  data: string
  dataBytes: Uint8Array
}

export type CtxmuxAdapterExitEvent = {
  type: 'exit'
  runId: string
  state: CtxmuxAdapterRun['state']
  observedAt: number
}

export type CtxmuxAdapterGapEvent = {
  type: 'gap'
  runId: string
  latestOutputBytes: number
}

export type CtxmuxAdapterResizedEvent = {
  type: 'resized'
  runId: string
  cols: number
  rows: number
}

export type CtxmuxAdapterEvent =
  | CtxmuxAdapterDataEvent
  | CtxmuxAdapterExitEvent
  | CtxmuxAdapterGapEvent
  | CtxmuxAdapterResizedEvent

export type CtxmuxAdapterObservationEvent =
  | CtxmuxAdapterEvent
  | { type: 'error'; runId: string; error: AgentMuxError }

export type CtxmuxAdapterAttachment = {
  run: CtxmuxAdapterRun
  replay: CtxmuxAdapterDataEvent[]
  gap: { requestedAfterByte: number; firstAvailableByte: number } | null
}

export type CtxmuxAdapterOutputObservation = CtxmuxAdapterAttachment & {
  close(): Promise<void>
}

export type CtxmuxAdapterInputOperation = {
  ownerInstanceId: string
  operationId: string
  expectedByte: number
  // string 走 UTF-8、Uint8Array 逐字节透传：旧式鼠标上报的 latin1 坐标字节只能走后者，
  // 否则 SDK 的 bytes() 会把 ≥128 的字节 UTF-8 编码成两字节、坐标就错了。
  data: AgentMuxRunInputData
}

type LiveAttachment = {
  attachment: Attachment
  token: symbol
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function localProcessEnvironment(): Record<string, string> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AgentMux',
    // Same SHA-verified source as everywhere else — CTXMUX_VERSION is asserted against manifest.json
    // above; a hand-copied '0.1.0' here would drift on the next artifact bump.
    TERM_PROGRAM_VERSION: CTXMUX_VERSION,
    FORCE_HYPERLINK: '1'
  }
  delete environment.NO_COLOR
  if (environment.FORCE_COLOR === '0') delete environment.FORCE_COLOR
  if (environment.CLICOLOR === '0') delete environment.CLICOLOR
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function readDaemonReadiness(child: ChildProcess, stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = ''
    let settled = false
    const finish = (error: Error | null, daemonInstanceId?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      if (error) reject(error)
      else resolve(daemonInstanceId as string)
    }
    const timer = setTimeout(() => {
      finish(new AgentMuxError(
        'The spawned CtxMux daemon did not publish its readiness receipt in time.',
        'CTXMUX_OWNER_IDENTITY_UNPROVEN'
      ))
    }, DAEMON_READY_TIMEOUT_MS)
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      content += chunk
      if (Buffer.byteLength(content) > DAEMON_READINESS_MAX_BYTES) {
        finish(new AgentMuxError(
          'The spawned CtxMux daemon readiness receipt exceeded its bound.',
          'CTXMUX_OWNER_IDENTITY_UNPROVEN'
        ))
        return
      }
      const newline = content.indexOf('\n')
      if (newline < 0) return
      try {
        if (content.slice(newline + 1).trim()) throw new Error('multiple readiness records')
        const receipt = JSON.parse(content.slice(0, newline)) as unknown
        if (
          typeof receipt !== 'object' ||
          receipt === null ||
          Array.isArray(receipt) ||
          JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(['daemon_instance', 'schema']) ||
          (receipt as { schema?: unknown }).schema !== 'ctxmux.daemon-ready.v1' ||
          typeof (receipt as { daemon_instance?: unknown }).daemon_instance !== 'string' ||
          !(receipt as { daemon_instance: string }).daemon_instance
        ) throw new Error('invalid readiness record')
        finish(null, (receipt as { daemon_instance: string }).daemon_instance)
      } catch (error) {
        finish(new AgentMuxError(
          `The spawned CtxMux daemon published an invalid readiness receipt: ${error instanceof Error ? error.message : String(error)}`,
          'CTXMUX_OWNER_IDENTITY_UNPROVEN'
        ))
      }
    })
    stream.once('error', (error) => finish(new AgentMuxError(
      `The spawned CtxMux readiness channel failed: ${error.message}`,
      'CTXMUX_OWNER_IDENTITY_UNPROVEN'
    )))
    stream.once('close', () => {
      if (!content.includes('\n')) finish(new AgentMuxError(
        `The spawned CtxMux daemon closed its readiness channel before proving startup${child.exitCode === null ? '' : ` (exit ${child.exitCode})`}.`,
        'CTXMUX_OWNER_IDENTITY_UNPROVEN'
      ))
    })
    child.once('error', (error) => finish(new AgentMuxError(
      `The CtxMux daemon artifact could not be spawned: ${error.message}`,
      'CTXMUX_UNAVAILABLE'
    )))
  })
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateSpawnedDaemon(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitForChildExit(child, DAEMON_SHUTDOWN_TIMEOUT_MS)) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (await waitForChildExit(child, DAEMON_SHUTDOWN_TIMEOUT_MS)) return
  throw new AgentMuxError(
    `The spawned CtxMux daemon ${child.pid} did not terminate during failed activation cleanup.`,
    'CTXMUX_OWNER_IDENTITY_UNPROVEN'
  )
}

function ownerReceiptPath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'owner.json')
}

export { defaultCtxmuxSocketPath, defaultCtxmuxStateDirectory }

function artifactDirectory(): string {
  return fileURLToPath(new URL(
    `../vendor/ctxmux/${process.platform}-${process.arch}/`,
    import.meta.url
  ))
}

function translateCtxmuxError(error: unknown): AgentMuxError {
  if (error instanceof CtxmuxCommandError) {
    return new AgentMuxError(error.message, `CTXMUX_${error.code}`, error.disposition)
  }
  if (error instanceof CtxmuxProtocolError) {
    return new AgentMuxError(error.message, `CTXMUX_${error.code}`)
  }
  return error instanceof AgentMuxError
    ? error
    : new AgentMuxError(
        error instanceof Error ? error.message : String(error),
        'CTXMUX_UNAVAILABLE'
      )
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function verifyArtifact(
  root: string,
  descriptor: { path: string; sha256: string; bytes: number; mode: string },
  expectedMode: number,
  expectedModeText: string
): Promise<void> {
  if (descriptor.path.startsWith('/') || descriptor.path.includes('..')) {
    throw new AgentMuxError('CtxMux artifact manifest contains an unsafe path.', 'CTXMUX_ARTIFACT_INVALID')
  }
  const path = join(root, descriptor.path)
  const metadata = await stat(path)
  if (
    !metadata.isFile() ||
    descriptor.mode !== expectedModeText ||
    metadata.size !== descriptor.bytes ||
    (metadata.mode & 0o777) !== expectedMode ||
    await sha256(path) !== descriptor.sha256
  ) {
    throw new AgentMuxError(`CtxMux artifact does not match its manifest: ${descriptor.path}`, 'CTXMUX_ARTIFACT_INVALID')
  }
}

async function verifyArtifacts(): Promise<VerifiedArtifacts> {
  const root = artifactDirectory()
  let manifest: ArtifactManifest
  try {
    const manifestBytes = await readFile(join(root, 'manifest.json'))
    if (createHash('sha256').update(manifestBytes).digest('hex') !== CTXMUX_MANIFEST_SHA256) {
      throw new Error('manifest digest mismatch')
    }
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ArtifactManifest
  } catch (error) {
    throw new AgentMuxError(
      `CtxMux artifact manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'CTXMUX_ARTIFACT_INVALID'
    )
  }
  if (
    manifest.schema !== 'ctxmux.local-artifacts.v1' ||
    manifest.source.commit !== CTXMUX_COMMIT ||
    manifest.source.tree !== CTXMUX_TREE ||
    manifest.source.worktree_clean !== true ||
    manifest.product.version !== CTXMUX_VERSION ||
    manifest.product.protocol !== PROTOCOL_VERSION ||
    manifest.support.platform !== process.platform ||
    manifest.support.architecture !== process.arch ||
    manifest.support.transport !== 'unix'
  ) {
    throw new AgentMuxError('CtxMux artifact manifest does not match this AgentMux build.', 'CTXMUX_ARTIFACT_INVALID')
  }
  await verifyArtifact(root, manifest.sdk.archive, 0o644, '0644')
  const daemon = manifest.binaries.find((binary) => binary.name === 'ctxmuxd')
  const cli = manifest.binaries.find((binary) => binary.name === 'ctxmux')
  if (!daemon || !cli || manifest.binaries.length !== 2) {
    throw new AgentMuxError('CtxMux artifact manifest is missing required binaries.', 'CTXMUX_ARTIFACT_INVALID')
  }
  await Promise.all([
    verifyArtifact(root, daemon, 0o755, '0755'),
    verifyArtifact(root, cli, 0o755, '0755')
  ])
  const daemonPath = join(root, daemon.path)
  try {
    // 没有挂钟预算。这是本机进程打印一行版本号，唯一的失败模式是"它不是我们钉的那个二进制"——
    // 而那由下面的字符串比对判定。加一个挂钟上限只会引入第二种"失败"：机器被压满时它变慢，
    // 于是一个**完好**的二进制被判成不满足版本合同，也就是把调度饥饿报成产物损坏。
    //
    // 实测（2026-09-01，负载 ~120，14 核）：同一台机器上解一个 84KB tarball 用了 3 分 42 秒挂钟、
    // 0.01 秒 CPU。5 秒预算在这种负载下必然先触发。而 execFile 超时的报错**从不说自己是超时**
    // （`Command failed: …`，stderr 空，signal=SIGTERM），于是这里会包出一条断言产物损坏的错误，
    // 把用户和排查者一起指向错误的方向——这比慢得多严重：慢只是慢，错误的诊断会让人去换二进制。
    //
    // 真正的卡死由调用方的生命周期负责（守护进程起不来会在 handshake 处显形），不由这一行兜。
    const version = await execFileAsync(daemonPath, ['--version'], {
      maxBuffer: 64 * 1024
    })
    // 括号里是一串**开放的**身份事实，不只有 protocol：ctxmuxd 还在同一对括号里声明它能接受的
    // handoff schema（`--version` 是 exec-in-place 升级前唯一能问出这件事的通道）。所以这里读到
    // protocol 号就停，但**必须**要求它后面紧跟 `,` 或 `)`——否则 `protocol 17` 会把 `protocol 170`
    // 也认成合法，即放过一个真正不兼容的产物。
    //
    // 把 `)` 钉在 protocol 数字后面，正是上游 vendor 构建被打断的原因（`build-local-artifacts.mjs`
    // 那条正则，已由上游 `c35f621` 修掉）：二进制是对的，正则是错的。我们这条断言当时有同一个缺陷，
    // 只是还没撞上——protocol 17 起 ctxmuxd 就会多印一段，于是一个**完好**的产物会被判成合同不符。
    const versionText = version.stdout.trim()
    const versionPrefix = `ctxmuxd ${CTXMUX_VERSION} (protocol ${PROTOCOL_VERSION}`
    const delimiter = versionText.slice(versionPrefix.length, versionPrefix.length + 1)
    if (!versionText.startsWith(versionPrefix) || (delimiter !== ',' && delimiter !== ')')) {
      throw new Error(`unexpected version: ${versionText}`)
    }
  } catch (error) {
    throw new AgentMuxError(
      `CtxMux daemon artifact did not satisfy its public version contract: ${error instanceof Error ? error.message : String(error)}`,
      'CTXMUX_ARTIFACT_INVALID'
    )
  }
  return { daemonPath, daemonSha256: daemon.sha256 }
}

function expectedOwnerReceipt(
  artifacts: VerifiedArtifacts,
  socketPath: string,
  stateDirectory: string,
  runtime: RuntimeIdentity
): OwnerReceipt {
  return {
    schema: 'agentmux.ctxmux-owner.v1',
    sourceCommit: CTXMUX_COMMIT,
    sourceTree: CTXMUX_TREE,
    manifestSha256: CTXMUX_MANIFEST_SHA256,
    daemonSha256: artifacts.daemonSha256,
    daemonPath: artifacts.daemonPath,
    socketPath,
    stateDirectory,
    daemonInstanceId: runtime.daemonInstanceId,
    runtimeId: runtime.runtimeId,
    runtimeBuildId: runtime.buildId
  }
}

const OWNER_RECEIPT_KEYS = [
  'schema',
  'sourceCommit',
  'sourceTree',
  'manifestSha256',
  'daemonSha256',
  'daemonPath',
  'socketPath',
  'stateDirectory',
  'daemonInstanceId',
  'runtimeId',
  'runtimeBuildId'
].sort()

function ownerReceiptMatchesExpected(receipt: unknown, expected: OwnerReceipt): boolean {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return false
  const candidate = receipt as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  return (
    keys.length === OWNER_RECEIPT_KEYS.length &&
    keys.every((key, index) => key === OWNER_RECEIPT_KEYS[index]) &&
    candidate.schema === expected.schema &&
    candidate.sourceCommit === expected.sourceCommit &&
    candidate.sourceTree === expected.sourceTree &&
    candidate.manifestSha256 === expected.manifestSha256 &&
    candidate.daemonSha256 === expected.daemonSha256 &&
    typeof candidate.daemonPath === 'string' &&
    isAbsolute(candidate.daemonPath) &&
    candidate.socketPath === expected.socketPath &&
    candidate.stateDirectory === expected.stateDirectory &&
    candidate.daemonInstanceId === expected.daemonInstanceId &&
    candidate.runtimeId === expected.runtimeId &&
    candidate.runtimeBuildId === expected.runtimeBuildId
  )
}

function assertRuntimeIdentity(runtime: RuntimeIdentity): void {
  const missingCapability = Object.entries(REQUIRED_RUNTIME_CAPABILITIES).find(
    ([capability, requiredVersion]) => runtime.capabilities[capability] !== requiredVersion
  )
  if (
    runtime.protocolGeneration !== PROTOCOL_VERSION ||
    runtime.runtimeIdPersistence !== 'state_dir' ||
    runtime.buildId !== CTXMUX_RUNTIME_BUILD_ID ||
    runtime.platform !== 'macos' ||
    runtime.arch !== 'aarch64' ||
    missingCapability
  ) {
    throw new AgentMuxError(
      `The responding CtxMux Runtime does not satisfy the pinned Local contract${missingCapability ? `: ${missingCapability[0]}` : '.'}`,
      'CTXMUX_OWNER_IDENTITY_UNPROVEN'
    )
  }
}

async function verifyOwnerReceipt(
  artifacts: VerifiedArtifacts,
  socketPath: string,
  stateDirectory: string,
  runtime: RuntimeIdentity
): Promise<void> {
  try {
    const path = ownerReceiptPath()
    const metadata = await stat(path)
    const receipt: unknown = JSON.parse(await readFile(path, 'utf8'))
    const expected = expectedOwnerReceipt(artifacts, socketPath, stateDirectory, runtime)
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      !ownerReceiptMatchesExpected(receipt, expected)
    ) {
      throw new Error('owner receipt mismatch')
    }
  } catch (error) {
    throw new AgentMuxError(
      `The responding CtxMux peer is not the artifact-owned AgentMux daemon: ${error instanceof Error ? error.message : String(error)}`,
      'CTXMUX_OWNER_IDENTITY_UNPROVEN'
    )
  }
}

async function writeOwnerReceipt(
  artifacts: VerifiedArtifacts,
  socketPath: string,
  stateDirectory: string,
  runtime: RuntimeIdentity
): Promise<void> {
  const path = ownerReceiptPath()
  const temporaryPath = join(dirname(path), `.owner-${process.pid}-${randomUUID()}.json`)
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(expectedOwnerReceipt(artifacts, socketPath, stateDirectory, runtime))}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function decodeChunk(
  runId: string,
  decoder: TextDecoder,
  chunk: OutputChunk
): CtxmuxAdapterDataEvent {
  const dataBytes = Uint8Array.from(chunk.data)
  return {
    type: 'data',
    runId,
    startByte: chunk.start_byte,
    endByte: chunk.end_byte,
    data: decoder.decode(dataBytes, { stream: true }),
    dataBytes
  }
}

type OwnerConfirmedSize = { cols: number; rows: number }

/**
 * `RunInfo.current_size` is the snapshot authority: the size an owner confirmed for the PTY as it is
 * now. `null` is the protocol's explicit unknown and must NOT be replaced by `RunSpec.size` — that one
 * is the size requested at launch and stops being the current value the moment anything resizes.
 *
 * Since protocol 16 the field is REQUIRED on every snapshot (no `skip_serializing_if` on the Rust
 * struct), so every projection has a real answer and there is no "field absent" case to fall back
 * from. There used to be a local ledger of resizes we issued, standing in while the field did not
 * exist; it is gone, because the daemon's own answer now arrives ahead of it on every path — the
 * resize response snapshots `current_size` strictly after committing `applied_size` (both read the
 * one native-control mutex, on the one thread), so the ledger could only ever have restated what the
 * snapshot already said.
 */
function snapshotCurrentSize(run: RunInfo): OwnerConfirmedSize | null {
  return run.current_size
}

function liveResizedSize(event: RunEvent): OwnerConfirmedSize | null {
  if (event.type !== 'resized') return null
  const size = event.size
  if (
    !Number.isInteger(size.cols) ||
    size.cols <= 0 ||
    !Number.isInteger(size.rows) ||
    size.rows <= 0
  ) {
    return null
  }
  return { cols: size.cols, rows: size.rows }
}

export class CtxmuxRunAdapter {
  readonly socketPath = defaultCtxmuxSocketPath()
  readonly stateDirectory = defaultCtxmuxStateDirectory()
  private client: CtxmuxClient | null = null
  private runtime: RuntimeIdentity | null = null
  /**
   * 本次 connect() 那趟孤儿目录回收的结果。null 表示还没连过。
   *
   * 回收在启动路径上自愈式地跑，成功时不该打扰任何人；但失败必须能被看见，否则一个每次都删不掉的
   * 目录会无声地一直堆着。诊断读这里，而不是让回收自己去打日志——Core 没有日志设施，为这一个用途
   * 造一个是没必要的熵。
   */
  lastEndpointReclaim: EndpointReclaimOutcome | null = null
  /** Compatibility is independent of whether this process owns daemon cleanup rights. */
  runtimeOwnership: 'owned' | 'unverified' | null = null
  private readonly attachments = new Map<string, LiveAttachment>()

  private eventListener: ((event: CtxmuxAdapterEvent) => void) | null = null
  private errorListener: ((error: AgentMuxError, runId?: string) => void) | null = null
  private connectionLostListener: (() => void) | null = null

  private projectRun(run: RunInfo): CtxmuxAdapterRun {
    const size = snapshotCurrentSize(run)
    return {
      runId: run.id,
      lifecycleOperationId: run.spec?.env.AGENTMUX_LIFECYCLE_OPERATION_ID ?? null,
      program: run.spec?.program ?? null,
      args: run.spec?.args ?? [],
      workspacePath: run.spec?.cwd ?? null,
      pid: run.pid,
      state: run.state,
      cols: size?.cols ?? null,
      rows: size?.rows ?? null,
      latestOutputBytes: run.latest_output_bytes,
      firstAvailableByte: run.first_available_byte,
      acceptedInputBytes: run.applied_input_bytes
    }
  }

  onEvent(listener: (event: CtxmuxAdapterEvent) => void): () => void {
    this.eventListener = listener
    return () => {
      if (this.eventListener === listener) this.eventListener = null
    }
  }

  onError(listener: (error: AgentMuxError, runId?: string) => void): () => void {
    this.errorListener = listener
    return () => {
      if (this.errorListener === listener) this.errorListener = null
    }
  }

  /**
   * 通知「与 daemon 的实时连接断了」。单 daemon 语义下，任何一个 attachment 的传输失败、或 daemon
   * 优雅关流却没交代 run 下场，都意味着我们与 daemon 的实时通道没了——这是唯一的连接，不是某个 run
   * 的局部错误。listener 由 client 装，用来置 `connected=false`、发 disconnected、排重连。
   *
   * 与 {@link onError}（一个 run 的语义错误）分居两处：连接断了要驱动整套重连，一个 run 出错不该。
   */
  onConnectionLost(listener: () => void): () => void {
    this.connectionLostListener = listener
    return () => {
      if (this.connectionLostListener === listener) this.connectionLostListener = null
    }
  }

  /**
   * 把实时连接标记为丢失：拆掉所有 attachment、把 client/runtime 置空（于是 {@link isConnected} 如实
   * 报 false、后续控制操作经 requireClient 响亮失败、connect() 会重建），再通知 listener。
   *
   * 幂等：client 已为 null（已断或已主动 disconnect）时直接返回，避免重连风暴里重复通知。
   */
  private markConnectionLost(): void {
    if (this.client === null) return
    for (const { attachment } of this.attachments.values()) attachment.close()
    this.attachments.clear()
    this.client = null
    this.runtime = null
    this.runtimeOwnership = null
    this.connectionLostListener?.()
  }

  async connect(): Promise<void> {
    if (this.client !== null) return
    const artifacts = await verifyArtifacts()
    await Promise.all([
      mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 }),
      mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    ])
    // 每次 artifact 升级都会派生一个新的 endpoint 目录，旧的连同它 110MB 级的 state.sqlite3 会永远
    // 留在盘上。连接是唯一必经、且此刻我们恰好知道「当前 endpoint 是哪个」的时点，回收挂在这里。
    // 它自己吞掉所有失败（返回 outcome、不抛），所以回收不了也绝不阻断启动。
    //
    // 结果留在实例上，供 `agentmux doctor` 读取：回收失败若无处可看，「不阻断启动、只留可诊断信息」
    // 就只剩前半句——每次启动都删不掉的目录会无声地一直堆着。
    this.lastEndpointReclaim = await reclaimOrphanEndpointDirectories(dirname(this.socketPath))
    await Promise.all([
      chmod(dirname(this.socketPath), 0o700),
      chmod(this.stateDirectory, 0o700)
    ])
    const diagnosticsClient = new CtxmuxClient({ socketPath: this.socketPath })
    let runtime: RuntimeIdentity | null = null
    try {
      runtime = await diagnosticsClient.runtimeInfo()
      assertRuntimeIdentity(runtime)
      try {
        await verifyOwnerReceipt(artifacts, this.socketPath, this.stateDirectory, runtime)
        this.runtimeOwnership = 'owned'
      } catch (error) {
        // A compatible daemon may have been started by an earlier App instance. Receipt ownership
        // controls cleanup authority, never protocol compatibility or access to existing Runs.
        if (error instanceof AgentMuxError && error.code === 'CTXMUX_OWNER_IDENTITY_UNPROVEN') {
          this.runtimeOwnership = 'unverified'
        } else throw error
      }
    } catch (error) {
      // A responding but incompatible Runtime is not an invitation to spawn a replacement.
      if (runtime !== null) throw error
      const child = spawn(artifacts.daemonPath, [
        '--socket',
        this.socketPath,
        '--state-dir',
        this.stateDirectory,
        '--readiness-fd',
        '3'
      ], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        env: localProcessEnvironment()
      })
      child.unref()
      try {
        const readinessStream = child.stdio[3] as Readable | null
        if (!readinessStream) {
          throw new AgentMuxError(
            'The CtxMux daemon readiness channel was not created.',
            'CTXMUX_OWNER_IDENTITY_UNPROVEN'
          )
        }
        const spawnedDaemonInstanceId = await readDaemonReadiness(child, readinessStream)
        const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
        let lastError: unknown = null
        while (Date.now() <= deadline) {
          if (child.exitCode !== null) {
            throw new AgentMuxError(
              `The spawned CtxMux daemon exited before public handshake (exit ${child.exitCode}).`,
              'CTXMUX_OWNER_IDENTITY_UNPROVEN'
            )
          }
          try {
            runtime = await diagnosticsClient.runtimeInfo()
            assertRuntimeIdentity(runtime)
            if (runtime.daemonInstanceId !== spawnedDaemonInstanceId) {
              throw new AgentMuxError(
                'The CtxMux socket responder does not match the exact daemon child that AgentMux spawned.',
                'CTXMUX_OWNER_IDENTITY_UNPROVEN'
              )
            }
            lastError = null
            break
          } catch (error) {
            if (error instanceof AgentMuxError && error.code === 'CTXMUX_OWNER_IDENTITY_UNPROVEN') {
              throw error
            }
            lastError = error
            await delay(DAEMON_POLL_INTERVAL_MS)
          }
        }
        if (lastError !== null || runtime === null) throw lastError
        try {
          await writeOwnerReceipt(artifacts, this.socketPath, this.stateDirectory, runtime)
          this.runtimeOwnership = 'owned'
        } catch {
          // The inherited readiness receipt already proved this exact child. A disk failure
          // recording provenance must not terminate a compatible daemon or its working Runs.
          this.runtimeOwnership = 'unverified'
        }
      } catch (error) {
        try {
          await terminateSpawnedDaemon(child)
        } catch (cleanupError) {
          throw new AgentMuxError(
            `CtxMux activation failed and its exact spawned daemon could not be cleaned up: ${error instanceof Error ? error.message : String(error)}; cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            'CTXMUX_OWNER_IDENTITY_UNPROVEN'
          )
        }
        throw error
      }
    }
    if (runtime === null) {
      throw new AgentMuxError('CtxMux did not report its daemon instance.', 'CTXMUX_OWNER_IDENTITY_UNPROVEN')
    }
    const client = new CtxmuxClient({
      socketPath: this.socketPath,
      expectedRuntimeIdentity: runtime,
      requiredCapabilities: REQUIRED_RUNTIME_CAPABILITIES
    })
    this.runtime = runtime
    this.client = client
  }

  disconnect(): void {
    for (const { attachment } of this.attachments.values()) attachment.close()
    this.attachments.clear()
    this.client = null
    this.runtime = null
    this.runtimeOwnership = null
  }

  isConnected(): boolean {
    return this.client !== null
  }

  identity(): { daemonInstanceId: string; protocolVersion: number; buildIdentity: string } {
    if (this.runtime === null) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
    return {
      daemonInstanceId: this.runtime.daemonInstanceId,
      protocolVersion: PROTOCOL_VERSION,
      buildIdentity: `ctxmux@${CTXMUX_VERSION}+${CTXMUX_COMMIT}`
    }
  }

  /**
   * Protocol 16 thinned `list()` to {@link RunSummary} — id/backend/pid/state/bytes/attachments, no
   * `spec`. Two consumers here need what the summary dropped: `assertAgentRun` compares
   * `run.workspacePath` against the Session's (that comparison IS the Run-identity guard), and
   * `projectRunWith` publishes it. The SDK's own answer is to read the full `RunInfo` with `status`,
   * so that is what this does.
   *
   * ponytail: N summaries ⇒ N `status` round trips, issued concurrently. Ceiling: a fleet with hundreds
   * of retained Runs pays hundreds of requests on every list. Upgrade path if that shows up in a trace:
   * hand the two consumers a summary-shaped type and let each fetch the one Run it actually inspects —
   * `assertAgentRun` only ever looks at Runs that have a Session, which is a small subset. Not built now;
   * the call sites are cold-start and reconnect, not a hot loop.
   *
   * A Run that ends between the list and its `status` is dropped rather than failed: `list` is already a
   * best-effort snapshot (the SDK pages it non-atomically), so a Run disappearing mid-walk is a normal
   * outcome of the walk, not an error to propagate. Every other failure still throws.
   */
  async list(): Promise<CtxmuxAdapterRun[]> {
    try {
      const summaries = await this.requireClient().list()
      const runs = await Promise.all(summaries.map(async (summary) => {
        try {
          return await this.requireClient().status(summary.id)
        } catch (error) {
          if (translateCtxmuxError(error).code === 'CTXMUX_run_not_found') return null
          throw error
        }
      }))
      return runs.flatMap((run) => (run === null ? [] : [this.projectRun(run)]))
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async status(runId: string): Promise<CtxmuxAdapterRun> {
    try {
      return this.projectRun(await this.requireClient().status(runId))
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async start(input: {
    operationKey: string
    program: string
    args: readonly string[]
    cwd: string
    env?: Readonly<Record<string, string>>
    cols?: number
    rows?: number
  }): Promise<CtxmuxAdapterRun> {
    try {
      const run = await this.requireClient().start(defineRun(input.program, {
        args: input.args,
        cwd: input.cwd,
        // The daemon can outlive this application. Every new local Run receives the current
        // client environment; explicit Run overrides remain authoritative.
        env: { ...localProcessEnvironment(), ...input.env },
        initialSize: { cols: input.cols ?? 80, rows: input.rows ?? 24 }
      }), createOperationKey(input.operationKey))
      return this.projectRun(run)
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async attach(
    runId: string,
    afterByte: number,
    beforeLive?: (snapshot: CtxmuxAdapterAttachment) => void
  ): Promise<CtxmuxAdapterAttachment> {
    if (this.attachments.has(runId)) {
      throw new AgentMuxError('This client already owns an Attachment for the Run.', 'ATTACHMENT_EXISTS')
    }
    try {
      const attachment = await this.requireClient().attach(runId, afterByte)
      const decoder = new TextDecoder()
      const replay = attachment.snapshot.replay.chunks.map((chunk) => (
        decodeChunk(runId, decoder, chunk)
      ))
      const snapshot = {
        run: this.projectRun(attachment.snapshot.run),
        replay,
        gap: classifyReplayGap({
          truncated: attachment.snapshot.replay.truncated,
          requestedAfterByte: afterByte,
          firstAvailableByte: attachment.snapshot.replay.first_available_byte
        })
      }
      // Reconnect consumers publish this snapshot synchronously before the live iterator is read.
      // No second queue: the SDK attachment owns all bytes until its pump starts.
      try { beforeLive?.(snapshot) } catch (error) {
        try { await attachment.detach() } catch (cleanupError) {
          attachment.close()
          throw new AggregateError([error, cleanupError], 'Run snapshot delivery and attachment cleanup failed.')
        }
        throw error
      }
      const token = Symbol(runId)
      this.attachments.set(runId, { attachment, token })
      void this.pump(runId, token, attachment, decoder)
      return snapshot
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  hasAttachment(runId: string): boolean {
    return this.attachments.has(runId)
  }

  async replay(runId: string, afterByte: number): Promise<CtxmuxAdapterAttachment> {
    let attachment: Attachment | null = null
    try {
      attachment = await this.requireClient().attach(runId, afterByte)
      const decoder = new TextDecoder()
      return {
        run: this.projectRun(attachment.snapshot.run),
        replay: attachment.snapshot.replay.chunks.map((chunk) => (
          decodeChunk(runId, decoder, chunk)
        )),
        gap: classifyReplayGap({
          truncated: attachment.snapshot.replay.truncated,
          requestedAfterByte: afterByte,
          firstAvailableByte: attachment.snapshot.replay.first_available_byte
        })
      }
    } catch (error) {
      throw translateCtxmuxError(error)
    } finally {
      if (attachment) {
        if (attachment.snapshot.run.state.type !== 'running') {
          // Historical Runs may close the wire immediately after their
          // terminal event, so there is no live View left to acknowledge.
          attachment.close()
        } else {
          try {
            await attachment.detach()
          } catch (error) {
            attachment.close()
            let current: RunInfo
            try {
              current = await this.requireClient().status(runId)
            } catch {
              throw translateCtxmuxError(error)
            }
            if (current.state.type === 'running') throw translateCtxmuxError(error)
          }
        }
      }
    }
  }

  async observeOutput(
    runId: string,
    afterByte: number,
    listener: (event: CtxmuxAdapterObservationEvent) => void
  ): Promise<CtxmuxAdapterOutputObservation> {
    let attachment: Attachment | null = null
    try {
      attachment = await this.requireClient().attach(runId, afterByte)
      const decoder = new TextDecoder()
      let closed = false
      const active = attachment
      const snapshot = active.snapshot
      // replay 与 live 必须共用**同一个** decoder，且 replay 先喂：`decodeChunk` 用的是有状态的
      // 流式解码（`{ stream: true }`），一个多字节 UTF-8 字符被切在 replay 的最后一个 chunk 与第一个
      // live chunk 之间时，前半截留在 decoder 的内部状态里、由下一个（live）chunk 补齐。若给 live 与
      // replay 各建一个 decoder，那半个字符会永远补不齐，而 live decoder 从零把续字节当成新字符开头，
      // 接缝处解出替换字符 / 乱码。
      //
      // 承重的只有「同一个 decoder」这一条，**不含**这个 `.map` 与下面 IIFE 的先后。此处此前写着「故必须
      // 先决出 replay，再让 live 循环接着喂」，那是错的：把 `.map` 挪到 IIFE 下面实测 2/2 全绿。原因是
      // `for await` 一定先在迭代器的 `.next()` promise 上挂起、之后才跑循环体，所以 IIFE 之后的同步语句
      // 照样先执行完。真正的（更弱的）不变量是「replay 的 `.map` 必须是同步的，不许挪到某个 `await` 之后」
      // ——两种摆法都满足它。因此顺序无人守，不是缺口：没有能杀死它的变异。
      const replay = snapshot.replay.chunks.map((chunk) => decodeChunk(runId, decoder, chunk))
      void (async () => {
        try {
          for await (const event of active.events()) {
            if (closed) return
            listener(this.translateLiveEvent(runId, decoder, event))
          }
        } catch (error) {
          if (!closed) this.errorListener?.(translateCtxmuxError(error), runId)
        }
      })()
      return {
        run: this.projectRun(snapshot.run),
        replay,
        gap: classifyReplayGap({
          truncated: snapshot.replay.truncated,
          requestedAfterByte: afterByte,
          firstAvailableByte: snapshot.replay.first_available_byte
        }),
        close: async () => {
          if (closed) return
          closed = true
          await active.detach()
        }
      }
    } catch (error) {
      if (attachment) await attachment.detach().catch(() => {})
      throw translateCtxmuxError(error)
    }
  }

  async detach(runId: string): Promise<void> {
    const live = this.attachments.get(runId)
    if (!live) return
    this.attachments.delete(runId)
    try {
      await live.attachment.detach()
    } catch (error) {
      live.attachment.close()
      throw translateCtxmuxError(error)
    }
  }

  async input(
    runId: string,
    operation: CtxmuxAdapterInputOperation
  ): Promise<{
    run: CtxmuxAdapterRun
    appliedByteRange: { startByte: number; endByte: number }
  }> {
    const recoverable = {
      daemonInstance: operation.ownerInstanceId,
      operationKey: operation.operationId,
      runId,
      expectedByte: operation.expectedByte,
      data: operation.data
    }
    try {
      const accepted = await this.requireClient().recoverableInput(recoverable)
      return {
        run: this.projectRun(accepted.run),
        appliedByteRange: {
          startByte: accepted.receipt.start_byte,
          endByte: accepted.receipt.end_byte
        }
      }
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async resize(runId: string, cols: number, rows: number): Promise<{ run: CtxmuxAdapterRun; cols: number; rows: number }> {
    try {
      const accepted = await this.requireClient().resize(runId, { cols, rows })
      // `applied_size` is the size the PTY confirmed for THIS command, and the snapshot beside it was
      // taken strictly after that value was committed (both go through the one native-control mutex on
      // the one thread), so `accepted.run.current_size` already carries it. Report `applied_size` as the
      // command's own answer and let `projectRun` read the snapshot — they agree by construction.
      const applied = accepted.receipt.applied_size
      return {
        run: this.projectRun(accepted.run),
        cols: applied.cols,
        rows: applied.rows
      }
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async interrupt(runId: string): Promise<void> {
    try {
      await this.requireClient().interrupt(runId)
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async prepareStop(runId: string, operationKey?: string): Promise<CtxmuxAdapterStopOperation> {
    if (this.runtime === null) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
    return {
      daemonInstance: this.runtime.daemonInstanceId,
      operationKey: operationKey ?? randomUUID(),
      runId
    }
  }

  async stop(operation: CtxmuxAdapterStopOperation): Promise<void> {
    let recovery: Awaited<ReturnType<CtxmuxClient['attachRecoverableStop']>> | null = null
    try {
      await this.detach(operation.runId)
      recovery = await this.requireClient().attachRecoverableStop(
        operation as RecoverableStopOperation,
        0
      )
    } catch (error) {
      throw translateCtxmuxError(error)
    } finally {
      recovery?.attachment.close()
    }
  }

  private requireClient(): CtxmuxClient {
    if (this.client === null) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
    return this.client
  }

  private async pump(
    runId: string,
    token: symbol,
    attachment: Attachment,
    decoder: TextDecoder
  ): Promise<void> {
    let threw = false
    let sawTerminalEvent = false
    try {
      for await (const event of attachment.events()) {
        if (this.attachments.get(runId)?.token !== token) return
        if (event.type === 'exited' || event.type === 'interrupted') sawTerminalEvent = true
        this.emitRunEvent(runId, decoder, event)
      }
    } catch (error) {
      threw = true
      this.errorListener?.(translateCtxmuxError(error), runId)
    } finally {
      const stillOwned = this.attachments.get(runId)?.token === token
      if (stillOwned) this.attachments.delete(runId)
      // 这条流怎么结束的，决定了要不要对账。分类是纯函数（ctxmux-stream-end），三种结局：
      // - detached：我们自己换/删了 attachment，什么都不做。
      // - run-exited：发过终结事件、干净结束，退出已如实发出，无需再做。
      // - connection-lost：抛错（wire 断），或 daemon 优雅关流却没交代 run 下场（历史缺陷：旧 pump
      //   在这一支只删 attachment、不发任何东西，run 永远停在最后状态）。两者都判连接丢失，交给
      //   markConnectionLost 驱动整套重连去问 daemon 真相，而不是在此刻瞎猜这个 run 死没死。
      const end = classifyStreamEnd({ threw, sawTerminalEvent, stillOwned })
      if (end === 'connection-lost') this.markConnectionLost()
    }
  }

  private translateLiveEvent(
    runId: string,
    decoder: TextDecoder,
    event: RunEvent
  ): CtxmuxAdapterObservationEvent {
    const resized = liveResizedSize(event)
    if (resized) {
      return { type: 'resized', runId, cols: resized.cols, rows: resized.rows }
    }
    if (event.type === 'resized') {
      // `size` is a required field since protocol 16, so reaching here means it carried a size that is
      // not a usable grid (non-integer, zero or negative). Refuse it rather than record it: this value
      // feeds the strict screen comparison, where a wrong grid is silent non-submission.
      return {
        type: 'error',
        runId,
        error: new AgentMuxError(
          'A native AgentMux Run received a resized event whose size is not a usable terminal grid.',
          'CTXMUX_EVENT_INVALID'
        )
      }
    }
    if (event.type === 'output') return decodeChunk(runId, decoder, event.chunk)
    if (event.type === 'gap') {
      return { type: 'gap', runId, latestOutputBytes: event.latest_output_bytes }
    }
    if (event.type === 'tmux' || event.type === 'observation_discontinuity') {
      return {
        type: 'error',
        runId,
        error: new AgentMuxError(
          `A native AgentMux Run received an unexpected ${event.type} event.`,
          'CTXMUX_EVENT_INVALID'
        )
      }
    }
    return {
      type: 'exit',
      runId,
      state: event.type === 'exited'
        ? event.state
        : { type: 'interrupted', reason: event.reason },
      observedAt: Date.now()
    }
  }

  private emitRunEvent(runId: string, decoder: TextDecoder, event: RunEvent): void {
    const translated = this.translateLiveEvent(runId, decoder, event)
    if (translated.type === 'error') {
      this.errorListener?.(translated.error, runId)
      return
    }
    this.eventListener?.(translated)
  }
}

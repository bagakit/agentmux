import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  Attachment,
  CtxmuxClient,
  CtxmuxCommandError,
  CtxmuxProtocolError,
  PROTOCOL_VERSION,
  createOperationKey,
  defineRun,
  type OutputChunk,
  type RunEvent,
  type RunInfo
} from '@ctxmux/sdk'
import { AgentMuxError } from './errors.js'

const CTXMUX_COMMIT = '3b94288c3a7896bb355e028135409c8e8bbaf764'
const CTXMUX_TREE = '58f3630477881e75f0f022d3fbb98a93ff2f46c4'
const CTXMUX_VERSION = '0.1.0'
const CTXMUX_MANIFEST_SHA256 = 'c1bab5039f6270c4c6c546d81699df251fe583477546a56a26a3f9332020ef42'
const CTXMUX_RUNTIME_ID = '88e8377ecc4341b655d47306'
const DAEMON_READY_TIMEOUT_MS = 5_000
const DAEMON_POLL_INTERVAL_MS = 20
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
}

export type CtxmuxAdapterRun = {
  runId: string
  program: string | null
  args: readonly string[]
  workspacePath: string | null
  pid: number | null
  state:
    | { type: 'running' }
    | { type: 'exited'; code: number; signal: string | null }
    | { type: 'interrupted'; reason: string }
  cols: number
  rows: number
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

export type CtxmuxAdapterEvent =
  | CtxmuxAdapterDataEvent
  | CtxmuxAdapterExitEvent
  | CtxmuxAdapterGapEvent

export type CtxmuxAdapterAttachment = {
  run: CtxmuxAdapterRun
  replay: CtxmuxAdapterDataEvent[]
  gap: { requestedAfterByte: number; firstAvailableByte: number } | null
}

export type CtxmuxAdapterInputOperation = {
  ownerInstanceId: string
  operationId: string
  expectedByte: number
  data: string
}

type LiveAttachment = {
  attachment: Attachment
  token: symbol
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runtimeRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `amx-${uid}-${CTXMUX_RUNTIME_ID}`)
}

export function defaultCtxmuxSocketPath(): string {
  return join(runtimeRoot(), 'ctxmux.sock')
}

export function defaultCtxmuxStateDirectory(): string {
  return join(runtimeRoot(), 'state')
}

function ownerReceiptPath(): string {
  return join(runtimeRoot(), 'owner.json')
}

function artifactDirectory(): string {
  return fileURLToPath(new URL(
    `../vendor/ctxmux/${process.platform}-${process.arch}/`,
    import.meta.url
  ))
}

function projectRun(run: RunInfo): CtxmuxAdapterRun {
  return {
    runId: run.id,
    program: run.spec?.program ?? null,
    args: run.spec?.args ?? [],
    workspacePath: run.spec?.cwd ?? null,
    pid: run.pid,
    state: run.state,
    cols: run.spec?.size.cols ?? 80,
    rows: run.spec?.size.rows ?? 24,
    latestOutputBytes: run.latest_output_bytes,
    firstAvailableByte: run.first_available_byte,
    acceptedInputBytes: run.applied_input_bytes
  }
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
    const version = await execFileAsync(daemonPath, ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })
    if (version.stdout.trim() !== `ctxmuxd ${CTXMUX_VERSION} (protocol ${PROTOCOL_VERSION})`) {
      throw new Error(`unexpected version: ${version.stdout.trim()}`)
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
  daemonInstanceId: string
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
    daemonInstanceId
  }
}

async function verifyOwnerReceipt(
  artifacts: VerifiedArtifacts,
  socketPath: string,
  stateDirectory: string,
  daemonInstanceId: string
): Promise<void> {
  try {
    const path = ownerReceiptPath()
    const metadata = await stat(path)
    const receipt = JSON.parse(await readFile(path, 'utf8')) as OwnerReceipt
    const expected = expectedOwnerReceipt(artifacts, socketPath, stateDirectory, daemonInstanceId)
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      JSON.stringify(receipt) !== JSON.stringify(expected)
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
  daemonInstanceId: string
): Promise<void> {
  const path = ownerReceiptPath()
  const temporaryPath = join(dirname(path), `.owner-${process.pid}-${randomUUID()}.json`)
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(expectedOwnerReceipt(artifacts, socketPath, stateDirectory, daemonInstanceId))}\n`,
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
  return {
    type: 'data',
    runId,
    startByte: chunk.start_byte,
    endByte: chunk.end_byte,
    data: decoder.decode(Uint8Array.from(chunk.data), { stream: true })
  }
}

export class CtxmuxRunAdapter {
  readonly socketPath = defaultCtxmuxSocketPath()
  readonly stateDirectory = defaultCtxmuxStateDirectory()
  private client: CtxmuxClient | null = null
  private daemonInstanceId: string | null = null
  private readonly attachments = new Map<string, LiveAttachment>()
  private eventListener: ((event: CtxmuxAdapterEvent) => void) | null = null
  private errorListener: ((error: AgentMuxError, runId?: string) => void) | null = null

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

  async connect(): Promise<void> {
    if (this.client !== null) return
    const artifacts = await verifyArtifacts()
    await Promise.all([
      mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 }),
      mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    ])
    await Promise.all([
      chmod(dirname(this.socketPath), 0o700),
      chmod(this.stateDirectory, 0o700)
    ])
    const client = new CtxmuxClient({ socketPath: this.socketPath })
    let daemonInstanceId: string | null = null
    try {
      daemonInstanceId = await client.daemonInstance()
      await verifyOwnerReceipt(artifacts, this.socketPath, this.stateDirectory, daemonInstanceId)
    } catch {
      if (daemonInstanceId !== null) {
        throw new AgentMuxError(
          'An unowned CtxMux peer already occupies the exact AgentMux runtime endpoint.',
          'CTXMUX_OWNER_IDENTITY_UNPROVEN'
        )
      }
      const child = spawn(artifacts.daemonPath, [
        '--socket',
        this.socketPath,
        '--state-dir',
        this.stateDirectory
      ], {
        detached: true,
        stdio: 'ignore'
      })
      let spawnError: Error | null = null
      child.once('error', (error) => { spawnError = error })
      child.unref()
      const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
      let lastError: unknown = spawnError
      while (Date.now() <= deadline) {
        try {
          daemonInstanceId = await client.daemonInstance()
          lastError = null
          break
        } catch (error) {
          lastError = spawnError ?? error
          await delay(DAEMON_POLL_INTERVAL_MS)
        }
      }
      if (lastError !== null) throw lastError
      await writeOwnerReceipt(
        artifacts,
        this.socketPath,
        this.stateDirectory,
        daemonInstanceId as string
      )
    }
    if (daemonInstanceId === null) {
      throw new AgentMuxError('CtxMux did not report its daemon instance.', 'CTXMUX_OWNER_IDENTITY_UNPROVEN')
    }
    this.daemonInstanceId = daemonInstanceId
    this.client = client
  }

  disconnect(): void {
    for (const { attachment } of this.attachments.values()) attachment.close()
    this.attachments.clear()
    this.client = null
    this.daemonInstanceId = null
  }

  isConnected(): boolean {
    return this.client !== null
  }

  identity(): { daemonInstanceId: string; protocolVersion: number; buildIdentity: string } {
    if (this.daemonInstanceId === null) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
    return {
      daemonInstanceId: this.daemonInstanceId,
      protocolVersion: PROTOCOL_VERSION,
      buildIdentity: `ctxmux@${CTXMUX_VERSION}+${CTXMUX_COMMIT}`
    }
  }

  async list(): Promise<CtxmuxAdapterRun[]> {
    try {
      return (await this.requireClient().list()).map(projectRun)
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async status(runId: string): Promise<CtxmuxAdapterRun> {
    try {
      return projectRun(await this.requireClient().status(runId))
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
        env: input.env ?? {},
        size: { cols: input.cols ?? 80, rows: input.rows ?? 24 }
      }), createOperationKey(input.operationKey))
      return projectRun(run)
    } catch (error) {
      throw translateCtxmuxError(error)
    }
  }

  async attach(runId: string, afterByte: number): Promise<CtxmuxAdapterAttachment> {
    if (this.attachments.has(runId)) {
      throw new AgentMuxError('This client already owns an Attachment for the Run.', 'ATTACHMENT_EXISTS')
    }
    try {
      const attachment = await this.requireClient().attach(runId, afterByte)
      const decoder = new TextDecoder()
      const replay = attachment.snapshot.replay.chunks.map((chunk) => (
        decodeChunk(runId, decoder, chunk)
      ))
      const token = Symbol(runId)
      this.attachments.set(runId, { attachment, token })
      void this.pump(runId, token, attachment, decoder)
      return {
        run: projectRun(attachment.snapshot.run),
        replay,
        gap: attachment.snapshot.replay.truncated
          ? {
              requestedAfterByte: afterByte,
              firstAvailableByte: attachment.snapshot.replay.first_available_byte
            }
          : null
      }
    } catch (error) {
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const accepted = await this.requireClient().recoverableInput(recoverable)
        return {
          run: projectRun(accepted.run),
          appliedByteRange: {
            startByte: accepted.receipt.start_byte,
            endByte: accepted.receipt.end_byte
          }
        }
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof CtxmuxCommandError &&
          error.disposition === 'unknown'
        ) continue
        throw translateCtxmuxError(error)
      }
    }
    throw new AgentMuxError('Recoverable CtxMux Input did not resolve.', 'CTXMUX_INPUT_UNRESOLVED')
  }

  async resize(runId: string, cols: number, rows: number): Promise<{ run: CtxmuxAdapterRun; cols: number; rows: number }> {
    try {
      const accepted = await this.requireClient().resize(runId, { cols, rows })
      return {
        run: projectRun(accepted.run),
        cols: accepted.receipt.applied_size.cols,
        rows: accepted.receipt.applied_size.rows
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

  async stop(runId: string): Promise<void> {
    try {
      await this.detach(runId)
      await this.requireClient().stop(runId)
    } catch (error) {
      throw translateCtxmuxError(error)
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
    try {
      for await (const event of attachment.events()) {
        if (this.attachments.get(runId)?.token !== token) return
        this.emitRunEvent(runId, decoder, event)
      }
    } catch (error) {
      this.errorListener?.(translateCtxmuxError(error), runId)
    } finally {
      if (this.attachments.get(runId)?.token === token) this.attachments.delete(runId)
    }
  }

  private emitRunEvent(runId: string, decoder: TextDecoder, event: RunEvent): void {
    if (event.type === 'output') {
      this.eventListener?.(decodeChunk(runId, decoder, event.chunk))
      return
    }
    if (event.type === 'gap') {
      this.eventListener?.({ type: 'gap', runId, latestOutputBytes: event.latest_output_bytes })
      return
    }
    if (event.type === 'tmux') {
      this.errorListener?.(new AgentMuxError(
        'A native AgentMux Run received an unexpected tmux event.',
        'CTXMUX_EVENT_INVALID'
      ), runId)
      return
    }
    this.eventListener?.({
      type: 'exit',
      runId,
      state: event.type === 'exited' ? event.state : { type: 'interrupted', reason: event.reason },
      observedAt: Date.now()
    })
  }
}

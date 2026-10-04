import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdtemp, open, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeProcessFiles, nativeProcessBirth, openNativeProcessImage, type NativeProcessImage } from '../agent-native-process.js'
import { runProcess } from '../process-runner.js'
import { AgentMuxError } from '../errors.js'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence } from '../types.js'
import { codexFailure } from './codex-errors.js'

const TAIL_BYTES = 512 * 1024
const HEADER_BYTES = 512 * 1024
export const codexNativeSourceId = (sessionId: string, source: { dev: bigint; ino: bigint }): string =>
  createHash('sha256').update(`[${JSON.stringify(sessionId)},${source.dev},${source.ino}]`).digest('base64url')

export function codexTurnRecordEvidence(value: unknown, sourceId: string, nativeSessionId: string): AgentPromptExecutionEvidence | null {
  const item = value as { timestamp?: unknown; type?: unknown; ordinal?: unknown; payload?: {
    type?: unknown; turn_id?: unknown; thread_id?: unknown; reason?: unknown; error?: unknown
  } }
  const event = item?.payload
  const boundary = item?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(event?.type))
  const turnRecord = item?.type === 'turn_context' || (item?.type === 'event_msg' &&
    event?.type === 'item_completed' && event.thread_id === nativeSessionId)
  if ((!boundary && !turnRecord) || !event || (event.thread_id !== undefined && event.thread_id !== nativeSessionId)) return null
  if (typeof event.turn_id !== 'string' || !event.turn_id || !Number.isSafeInteger(item.ordinal)) return null
  const state = !boundary || event.type === 'task_started' ? 'working' : 'ended'
  const failure = state === 'ended' && event.error != null ? codexFailure(event.error, event.turn_id) : undefined
  const observedAt = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN
  return { sourceId, id: createHash('sha256').update(JSON.stringify([sourceId, item.ordinal, item.type, event.type, event.turn_id])).digest('base64url'),
    nativeTurnId: event.turn_id, nativeOrdinal: Number(item.ordinal), state,
    ...(Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
    ...(failure ? { endReason: 'failed', failure } : event.type === 'task_complete' ? { endReason: 'completed' } :
      event.type === 'turn_aborted' && event.reason === 'interrupted' ? { endReason: 'interrupted' } : {}) }
}

/** Only a local, exact native writer can prove an old default TUI is embedded.
 * Native writer ownership survives removal of the control socket path.
 * The pinned native TUI either connects remotely or owns the in-process writer;
 * anonymous runtime socketpairs do not imply a remote connection.
 * Never infer past startup mode from today's missing control pathname.
 */
async function readImageVersion(image: NativeProcessImage, signal: AbortSignal): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amux-native-version-'))
  try {
    const executable = join(root, 'native')
    // Execute only bytes from the held OS image. A launcher or a replacement at
    // its former pathname says nothing about the process writing this Session.
    // The kernel FD link refers to the held image even if its former pathname
    // changes. Let the filesystem clone it when supported, otherwise copy bytes.
    await copyFile(`${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${image.file.fd}`,
      executable, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    await chmod(executable, 0o700)
    signal.throwIfAborted()
    await image.assertCurrent(signal)
    const result = await runProcess(executable, ['--version'], { cwd: root, signal, timeoutMs: 20_000, maxOutputBytes: 4096 })
    if (result.exitCode !== 0 || result.stderr || !/^codex-cli [^\r\n]+\r?\n?$/u.test(result.stdout)) {
      throw new AgentMuxError('The current native writer version could not be confirmed. Ordinary input remains available.', 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED')
    }
    return result.stdout.trim().slice('codex-cli '.length)
  } finally { await rm(root, { recursive: true, force: true }) }
}

/** A single image-version fact per Provider; never cache input authorization. */
export function createCodexPromptExecutionTransportVerifier(): (context: AgentProviderPromptExecutionContext) => Promise<boolean> {
  let versionFact: { identity: string; result: Promise<string> } | undefined
  return async (context) => {
    if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) return false
    if (!context.processId || !Number.isSafeInteger(context.processId) || context.processId <= 0) return false
    const handle = context.nativeHandle
    if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return false
    const signal = AbortSignal.timeout(8_000)
    const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try {
      source = await file.stat({ bigint: true })
      if (!source.isFile()) return false
      if (!context.nativeSourceId || codexNativeSourceId(handle.sessionId, source) !== context.nativeSourceId) return false
      const header = Buffer.alloc(Number(source.size < BigInt(HEADER_BYTES) ? source.size : BigInt(HEADER_BYTES)))
      await file.read(header, 0, header.length, 0)
      const end = header.indexOf(10)
      if (end < 0) return false
      const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
      // Resume appends to the creator's rollout. Its version is historical metadata.
      if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return false
    } finally { await file.close() }
    const rootBirth = await nativeProcessBirth(context.processId, signal)
    const matches = (await nativeProcessFiles(context.processId, signal)).filter(file => file.path === handle.transcriptPath &&
      file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const owners = [...new Set(matches.map(file => file.processId))]
    if (owners.length !== 1) return false
    const nativePid = owners[0]!
    const nativeBirth = await nativeProcessBirth(nativePid, signal)
    const image = await openNativeProcessImage(nativePid, signal)
    try {
      if (versionFact?.identity !== image.identity) {
        // Cold Darwin copy + executable validation was measured at ~20s for the
        // pinned 241MB image. This budget applies only to a new version fact.
        const fact = { identity: image.identity, result: readImageVersion(image, AbortSignal.timeout(35_000)) }
        versionFact = fact
        void fact.result.catch(() => { if (versionFact === fact) versionFact = undefined })
      }
      const version = await versionFact.result
      const verificationSignal = AbortSignal.timeout(8_000)
      await image.assertCurrent(verificationSignal)
      if (version !== '0.160.1') {
        throw new AgentMuxError(`The current native writer version ${version} does not support verified immediate execution. Ordinary input remains available.`, 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED')
      }
      const after = (await nativeProcessFiles(context.processId, verificationSignal)).filter(file =>
        file.path === handle.transcriptPath && file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
      const afterOwners = [...new Set(after.map(file => file.processId))]
      return afterOwners.length === 1 && afterOwners[0] === nativePid &&
        after.some(file => matches.some(old => old.processId === file.processId && old.descriptor === file.descriptor)) &&
        await nativeProcessBirth(context.processId, verificationSignal) === rootBirth && await nativeProcessBirth(nativePid, verificationSignal) === nativeBirth
    } finally { await image.file.close() }
  }
}

/** Decode only the Provider's native turn records, with bounded work per operation.
 * Native pending steers are not written here; the complete visible pane guards them.
 * A truncated suffix without an actual turn boundary remains unknown.
 */
export async function readCodexPromptExecutionEvidence(context: AgentProviderPromptExecutionContext): Promise<AgentPromptExecutionEvidence | null> {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return null
  const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile()) return null
    const size = Number(stat.size)
    if (!Number.isSafeInteger(size)) return null
    const header = Buffer.alloc(Math.min(size, HEADER_BYTES))
    await file.read(header, 0, header.length, 0)
    const headerEnd = header.indexOf(10)
    if (headerEnd < 0) return null
    const meta = JSON.parse(header.subarray(0, headerEnd).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return null
    const sourceId = codexNativeSourceId(handle.sessionId, stat)
    const predecessor = context.nativePromptPredecessor
    // The retained source must be exactly the one Core observed before this Run
    // started. A replacement cannot inherit an initial-idle authorization.
    if (predecessor && predecessor.sourceId !== sourceId) return null
    const currentEvidence = (evidence: AgentPromptExecutionEvidence): AgentPromptExecutionEvidence =>
      predecessor?.evidenceId === evidence.id
        ? { sourceId, id: createHash('sha256').update(JSON.stringify([
          'resumed-native-initial', predecessor.run.runId, sourceId, predecessor.evidenceId
        ])).digest('base64url'), state: 'idle' }
        : evidence
    const start = Math.max(0, size - TAIL_BYTES)
    const tail = Buffer.alloc(size - start)
    await file.read(tail, 0, tail.length, start)
    const completeEnd = tail.lastIndexOf(10)
    if (completeEnd < 0) return null
    const first = start ? tail.indexOf(10) + 1 : 0
    if (first <= 0 && start) return null
    const lines = tail.subarray(first, completeEnd).toString('utf8').split('\n')
    let latest: AgentPromptExecutionEvidence | null = null
    for (const line of lines) {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string; thread_id?: string } }
      const payload = record.payload
      const relevant = (record.type === 'turn_context' || (record.type === 'event_msg' &&
        ['task_started', 'task_complete', 'turn_aborted', 'item_completed'].includes(payload?.type ?? ''))) &&
        (payload?.thread_id === undefined || payload.thread_id === handle.sessionId) &&
        (payload?.type !== 'item_completed' || payload.thread_id === handle.sessionId)
      if (!relevant) continue
      const evidence = codexTurnRecordEvidence(record, sourceId, handle.sessionId)
      // A malformed current boundary cannot resurrect a prior success.
      if (!evidence) return null
      if (latest && evidence.nativeOrdinal! <= latest.nativeOrdinal!) continue
      if (latest && evidence.state === 'ended' && evidence.nativeTurnId !== latest.nativeTurnId) continue
      if (latest?.state === 'ended' && payload?.type === 'item_completed') continue
      latest = evidence
    }
    if (latest) return currentEvidence(latest)
    // A complete, small new transcript with no turn can prove initial idle. A
    // retained suffix cannot make the same assertion.
    return start === 0 ? currentEvidence({ sourceId, id: sourceId, state: 'idle' }) : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  } finally { await file.close() }
}

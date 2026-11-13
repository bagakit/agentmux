import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import { APP_CAPTURE_LIMITS, parseAppCaptureFrame, parseAppCaptureParams, parseAppRecording,
  type AppCaptureContext, type AppCaptureFrame, type AppCaptureMethod, type AppCaptureParamsMap,
  type AppCaptureResultMap, type AppCaptureTarget, type AppRecordPage, type AppRecordStart, type AppRecording } from '@agentmux/core/app-capture'
import { AppRecordingEncoder } from './app-recording-encoder.js'

type RecordMethod = Exclude<AppCaptureMethod, 'app.capture'>
type FrameObservation = Pick<AppCaptureFrame, 'startedAt' | 'observedAt' | 'bounds' | 'layers'>
type Producer = { pid: number; instanceId: string }
type Active = { recording: AppRecording; done: Promise<void>; stop: boolean; interrupted: boolean; abort: AbortController; wake?: () => void }
type Options = { directory: string; capture(target: AppCaptureTarget): Promise<AppCaptureFrame> }
const terminal = (record: AppRecording) => ['completed', 'partial', 'failed', 'interrupted'].includes(record.state)
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const issue = (error: unknown) => error instanceof Error ? error.message : String(error)
// These bound a consumer's observation, never an original page's lifetime.
const SOURCE_WAIT_MS = 15_000, ENCODER_WAIT_MS = 5_000, STOP_WAIT_MS = 500
const STOP_PENDING_ISSUE = `Stop was requested; its original source or encoder has not settled within ${STOP_WAIT_MS} ms. The operation remains stopping; inspect it without replaying start.`
class RecordingObservationEnded extends Error {}
async function observed<T>(promise: Promise<T>, signal: AbortSignal, stage: string, budget: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined
  const ended = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    timer = setTimeout(() => reject(new RecordingObservationEnded(`${stage} observation exceeded ${budget} ms; original native completion is unconfirmed. Inspect this operation; no healthy page was stopped.`)), budget)
  })
  try { return await Promise.race([promise, ended]) }
  finally { clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted) }
}
async function waitForSettlement(promise: Promise<unknown>, budget: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), budget) })]) }
  finally { clearTimeout(timer) }
}

/** One original Desktop recording. No Agent lifecycle, input or focus operation lives here. */
export class AppRecordingOwner {
  private readonly active = new Map<string, Active>()
  private readonly starts = new Map<string, Promise<AppRecordPage>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly producers = new WeakMap<AppRecording, Producer>()
  private readonly producer: Producer = { pid: process.pid, instanceId: randomUUID() }
  private disposed = false
  constructor(private readonly options: Options) {}

  async call<M extends RecordMethod>(method: M, raw: AppCaptureParamsMap[M], context: AppCaptureContext): Promise<AppCaptureResultMap[M]> {
    const input = parseAppCaptureParams(method, raw)
    context.signal?.throwIfAborted(); await context.assertCurrent?.(); context.signal?.throwIfAborted()
    const id = (input as { operationId: string }).operationId
    if (method === 'app.record.start') {
      // Admission is serialized by original identity, including simultaneous starts.
      const pending = this.starts.get(id)
      if (pending) {
        await pending
        const original = await this.load(id, context)
        if (!original) throw new AgentMuxError('The original recording receipt is unavailable. Keep this operation ID; no recording was replayed.', 'APP_RECORDING_UNAVAILABLE')
        this.sameStart(original, input as AppRecordStart)
        return { recording: structuredClone(original) } as AppCaptureResultMap[M]
      }
      const start = this.start(input as AppRecordStart, context)
      this.starts.set(id, start)
      try { return await start as AppCaptureResultMap[M] }
      finally { if (this.starts.get(id) === start) this.starts.delete(id) }
    }
    const pending = this.starts.get(id)
    if (pending) await pending
    const recording = await this.load(id, context)
    if (!recording) return { recording: null } as AppCaptureResultMap[M]
    if (method === 'app.record.stop') {
      const active = this.active.get(id)
      if (active && !terminal(active.recording)) {
        active.stop = true; active.recording.state = 'stopping'; active.wake?.()
        await this.save(active.recording)
        if (!await waitForSettlement(active.done, STOP_WAIT_MS)) {
          if (!terminal(active.recording)) {
            if (!active.recording.issues.includes(STOP_PENDING_ISSUE)) active.recording.issues.push(STOP_PENDING_ISSUE)
            await this.save(active.recording)
          }
        }
        return { recording: structuredClone(active.recording) } as AppCaptureResultMap[M]
      }
      if (!terminal(recording)) throw new AgentMuxError('The original recording producer is not owned here and its end is unconfirmed. Inspect it at its original Desktop; no page or Agent was stopped.', 'APP_RECORDING_OWNER_UNCONFIRMED')
    }
    if (method !== 'app.record.read' || recording.bytes === 0) return { recording: structuredClone(recording) } as AppCaptureResultMap[M]
    const bytes = await readFile(this.path(id, 'webm'))
    if (bytes.length !== recording.bytes || digest(bytes) !== recording.sha256) {
      throw new AgentMuxError('The original recording artifact does not match its saved receipt. Keep the operation ID; it was not rerecorded.', 'APP_RECORDING_ARTIFACT_UNCONFIRMED')
    }
    const frames = JSON.parse(await readFile(this.path(id, 'frames.json'), 'utf8')) as FrameObservation[]
    return { recording: structuredClone(recording), video: { format: 'webm', data: bytes.toString('base64') }, frames } as AppCaptureResultMap[M]
  }

  private path(id: string, extension: string): string { return join(this.options.directory, `${digest(id)}.${extension}`) }
  private async write(path: string, bytes: string | Uint8Array, createOnly = false): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const temporary = path + `.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      if (createOnly) await link(temporary, path)
      else await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => {}) }
    const directory = await open(this.options.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  private save(recording: AppRecording, createOnly = false): Promise<void> {
    const id = recording.operationId, producer = this.producers.get(recording)
    if (!producer) throw new Error('The original recording producer is unconfirmed; no record was replaced.')
    const bytes = JSON.stringify({ schema: 'agentmux.app-recording.v1', producer, recording }) + '\n'
    const saved = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.write(this.path(id, 'json'), bytes, createOnly))
    this.writes.set(id, saved)
    void saved.finally(() => { if (this.writes.get(id) === saved) this.writes.delete(id) }).catch(() => {})
    return saved
  }
  private sameStart(original: AppRecording, input: AppRecordStart): void {
    if (!isDeepStrictEqual({ operationId: original.operationId, target: original.target, durationMs: original.durationMs, fps: original.fps }, input)) {
      throw new AgentMuxError('This recording operation already belongs to another original intent. Read it; no new recording was started.', 'APP_RECORDING_OPERATION_CONFLICT')
    }
  }
  private async load(id: string, context: AppCaptureContext): Promise<AppRecording | null> {
    const live = this.active.get(id)
    let recording: AppRecording
    if (live) recording = live.recording
    else {
      try {
        const file = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'))
        if (file.schema !== 'agentmux.app-recording.v1' || !Number.isSafeInteger(file.producer?.pid) || file.producer.pid <= 0 || typeof file.producer.instanceId !== 'string' || !file.producer.instanceId) throw new Error('The original recording producer identity is unconfirmed.')
        recording = parseAppRecording(file.recording)
        this.producers.set(recording, file.producer)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    if (recording.operationId !== id || !isDeepStrictEqual(recording.actor, context.actor)) {
      throw new AgentMuxError('This recording belongs to another original actor. No capture or Agent was changed.', 'CONTROL_PERMISSION_DENIED')
    }
    if (!live && !terminal(recording)) {
      const producer = this.producers.get(recording)!
      let ended = false
      try { process.kill(producer.pid, 0) }
      catch (error) { ended = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!ended) {
        recording.issues.push('The original recording process still exists or its liveness is unconfirmed. This owner did not stop or replace it; the saved state is the last confirmed observation.')
        return recording
      }
      recording.state = 'interrupted'
      recording.issues = recording.issues.filter(message => message !== STOP_PENDING_ISSUE)
      recording.issues.push('The original Desktop recording owner ended; native completion and its end time were not confirmed.')
      // The artifact can have reached disk before the final receipt. Recover only
      // those exact original bytes; this never resumes sampling or claims completion.
      try {
        const bytes = await readFile(this.path(id, 'webm'))
        const frames = JSON.parse(await readFile(this.path(id, 'frames.json'), 'utf8')) as FrameObservation[]
        if (!bytes.length || bytes.length > APP_CAPTURE_LIMITS.maxVideoBytes || bytes.subarray(0, 4).toString('hex') !== '1a45dfa3' ||
          !Array.isArray(frames) || !frames.length || frames.length > APP_CAPTURE_LIMITS.maxDurationMs * APP_CAPTURE_LIMITS.maxFps / 1000 + 1) {
          throw new Error('The retained original artifact is unconfirmed.')
        }
        recording.bytes = bytes.length; recording.sha256 = digest(bytes); recording.frameCount = frames.length
        recording.issues.push('The original encoded bytes and frame observations were retained before the final receipt was saved.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recording.issues.push('Original artifact recovery: ' + issue(error))
      }
      await this.save(recording)
    }
    return recording
  }
  private async start(input: AppRecordStart, context: AppCaptureContext): Promise<AppRecordPage> {
    const original = await this.load(input.operationId, context)
    if (original) { this.sameStart(original, input); return { recording: structuredClone(original) } }
    if (this.disposed) throw new AgentMuxError('This Desktop recording owner is unavailable. Original workfaces and Agents remain available.', 'CONTROL_UNAVAILABLE')
    context.signal?.throwIfAborted(); await context.assertCurrent?.(); context.signal?.throwIfAborted()
    const recording: AppRecording = { ...input, target: structuredClone(input.target), actor: { ...context.actor }, state: 'starting', requestedAt: Date.now(),
      startedAt: null, finishedAt: null, width: null, height: null, frameCount: 0, bytes: 0, sha256: null, gaps: [], issues: [] }
    this.producers.set(recording, this.producer)
    try { await this.save(recording, true) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const retained = await this.load(input.operationId, context)
      if (!retained) throw error
      this.sameStart(retained, input); return { recording: retained }
    }
    // The business effect is admitted. Reader cancellation cannot replay or stop it.
    const active: Active = { recording, stop: this.disposed, interrupted: this.disposed, abort: new AbortController(), done: Promise.resolve() }
    this.active.set(input.operationId, active)
    active.done = this.run(active)
    return { recording: structuredClone(recording) }
  }
  private async run(active: Active): Promise<void> {
    const record = active.recording, frames: FrameObservation[] = []
    let encoder: AppRecordingEncoder | undefined, deadline: ReturnType<typeof setTimeout> | undefined
    let stage = 'capture', unconfirmed = false
    let finishRequested = false
    const pause = (ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(() => { delete active.wake; resolve() }, ms)
      active.wake = () => { clearTimeout(timer); delete active.wake; resolve() }
    })
    const capture = async (): Promise<AppCaptureFrame | null> => {
      const startedAt = Date.now()
      try { return parseAppCaptureFrame(await observed(this.options.capture(record.target), active.abort.signal, 'Source frame', SOURCE_WAIT_MS), record.target) }
      catch (error) {
        if ((error as { code?: string }).code !== 'APP_CAPTURE_FRAME_CHANGED') throw error
        record.gaps.push({ code: 'APP_CAPTURE_FRAME_CHANGED', startedAt, observedAt: Date.now() })
        return null
      }
    }
    const publish = async (bytes: Buffer) => {
      await this.write(this.path(record.operationId, 'frames.json'), JSON.stringify(frames) + '\n', true)
      await this.write(this.path(record.operationId, 'webm'), bytes, true)
      record.bytes = bytes.length; record.sha256 = digest(bytes)
    }
    try {
      if (active.stop) { record.state = 'interrupted'; record.issues.push('The Desktop recording owner ended before the first capture.'); return }
      const start = performance.now(), interval = 1000 / record.fps
      deadline = setTimeout(() => { active.stop = true; record.state = 'stopping'; active.wake?.() }, record.durationMs)
      let first: AppCaptureFrame | null = null
      while (!first && !active.stop) {
        first = await capture()
        if (!first) {
          if (performance.now() - start >= record.durationMs) break
          await pause(interval)
        }
      }
      if (active.stop || performance.now() - start >= record.durationMs) { record.state = 'interrupted'; record.issues.push('Recording stopped before the first frame was encoded.'); return }
      if (!first) throw new Error('No original frame was available for this recording.')
      stage = 'encoder-start'
      encoder = await observed(AppRecordingEncoder.start(first, active.abort.signal), active.abort.signal, 'Encoder start', ENCODER_WAIT_MS)
      record.width = encoder.width; record.height = encoder.height
      record.startedAt = Date.now(); record.state = active.stop ? 'stopping' : 'recording'; record.frameCount = 1
      frames.push({ startedAt: first.startedAt, observedAt: first.observedAt, bounds: first.bounds, layers: first.layers })
      await this.save(record)
      let next = performance.now() + interval
      while (!active.stop && performance.now() - start < record.durationMs) {
        const wait = Math.min(next, start + record.durationMs) - performance.now()
        if (wait > 0) await pause(wait)
        if (active.stop || performance.now() - start >= record.durationMs) break
        stage = 'capture'
        const frame = await capture()
        if (!frame) { next = performance.now() + interval; continue }
        if (active.stop || active.interrupted || performance.now() - start >= record.durationMs) break
        stage = 'append'
        await observed(encoder.append(frame), active.abort.signal, 'Frame encoding', ENCODER_WAIT_MS)
        record.frameCount++
        frames.push({ startedAt: frame.startedAt, observedAt: frame.observedAt, bounds: frame.bounds, layers: frame.layers })
        // Sampling never catches up by flooding the source with overlapping frames.
        next = performance.now() > next + interval ? performance.now() + interval : next + interval
      }
      record.state = 'stopping'; await this.save(record)
      finishRequested = true
      stage = 'finish'
      const bytes = await observed(encoder.finish(), active.abort.signal, 'Encoder finish', ENCODER_WAIT_MS)
      await publish(bytes)
      record.state = active.interrupted ? 'interrupted' : record.gaps.length ? 'partial' : 'completed'
      if (active.interrupted) record.issues.push('The Desktop recording owner ended after preserving this partial artifact.')
    } catch (error) {
      unconfirmed = error instanceof RecordingObservationEnded || active.abort.signal.aborted
      record.state = active.interrupted ? 'interrupted' : unconfirmed ? 'stopping' : 'failed'; record.issues.push(issue(error))
      // A lost source must not throw away frames already encoded by this operation.
      if (encoder && !finishRequested && record.frameCount && stage === 'capture' && !active.interrupted) {
        finishRequested = true
        try { await publish(await observed(encoder.finish(), active.abort.signal, 'Partial encoder finish', ENCODER_WAIT_MS)) }
        catch (cleanupError) { record.issues.push('Partial recording finalization failed: ' + issue(cleanupError)) }
      }
    } finally {
      clearTimeout(deadline); active.wake?.()
      active.abort.abort(new RecordingObservationEnded('This original recording consumer ended; late pixel observations are not appended.'))
      encoder?.dispose()
      record.finishedAt = unconfirmed ? null : Date.now()
      if (!unconfirmed && terminal(record)) record.issues = record.issues.filter(message => message !== STOP_PENDING_ISSUE)
      try { await this.save(record); this.active.delete(record.operationId) }
      catch (error) { record.issues.push('Original recording receipt save is unconfirmed: ' + issue(error)) }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await waitForSettlement(Promise.allSettled(this.starts.values()), STOP_WAIT_MS)
    const pending = [...this.active.values()]
    for (const active of pending) {
      active.interrupted = true; active.stop = true; active.wake?.()
      active.abort.abort(new RecordingObservationEnded('The original Desktop recording owner was disposed; any in-flight source observation remains unconfirmed.'))
    }
    await waitForSettlement(Promise.allSettled(pending.map(active => active.done)), STOP_WAIT_MS)
  }
}

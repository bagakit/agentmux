import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile, DurableWriteError } from '@agentmux/core'
import {
  parseRendererSceneCaptureInput,
  parseRendererSceneInspectInput,
  parseRendererPerformanceScene,
  parseRendererSceneCaptureResult,
  parseRendererSceneResources,
  rendererCaptureIssue,
  rendererSceneJSON,
  rendererSceneMetadata,
  rendererSceneStatus,
  sameRendererV8ProfileTarget,
  RENDERER_SCENE_MAX_BYTES,
  RENDERER_SCENE_METADATA_BYTES,
  RENDERER_SCENE_OBSERVATION_MS,
  type RendererSceneCaptureInput,
  type RendererSceneInspectInput,
  type RendererSceneCaptureResult,
  type RendererSceneInspection,
  type RendererPerformanceScene,
  type RendererScenePhase,
  type RendererSceneLoaded,
  type RendererV8ProfileTarget,
  type AgentMuxMetricsPort,
  type MetricsObservation
} from '@agentmux/core/control'

export type PerformanceSceneDependencies = {
  currentTarget(): RendererV8ProfileTarget | null
  loaded(): RendererSceneLoaded
  resources(signal: AbortSignal): Promise<MetricsObservation>
  captureProfile: NonNullable<AgentMuxMetricsPort['captureProfile']>
  captureAllocations: NonNullable<AgentMuxMetricsPort['captureAllocations']>
  captureTrace: NonNullable<AgentMuxMetricsPort['captureTrace']>
  inspectMemory: NonNullable<AgentMuxMetricsPort['inspectMemory']>
}
/** One App-lifetime request and one durable document. No Window registry or resource facts cache. */
export class PerformanceSceneOwner {
  private active: AbortController | null = null
  private disposed = false
  constructor(
    private readonly path: string,
    private readonly write: typeof durableWriteFile = durableWriteFile
  ) {}
  dispose() {
    this.disposed = true
    this.active?.abort(new AgentMuxError('Original App scene owner ended.', 'CONTROL_OWNER_LOST'))
  }
  async inspect(raw: RendererSceneInspectInput, signal?: AbortSignal): Promise<RendererSceneInspection> {
    const input = parseRendererSceneInspectInput(raw)
    signal?.throwIfAborted()
    let file
    try {
      file = await open(this.path, 'r')
      const stat = await file.stat()
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > RENDERER_SCENE_MAX_BYTES)
        throw new AgentMuxError('Retained scene is not a bounded regular file.', 'CONTROL_PROTOCOL_ERROR')
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        signal?.throwIfAborted()
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > stat.size)
        throw new AgentMuxError('Retained scene exceeds its original byte budget.', 'CONTROL_PROTOCOL_ERROR')
      const scene = parseRendererPerformanceScene(JSON.parse(bytes.subarray(0, length).toString('utf8')))
      if (input.captureId !== undefined && scene.captureId !== input.captureId)
        return {
          status: 'mismatch',
          scene: null,
          issue: rendererCaptureIssue(
            'inspect',
            new AgentMuxError(
              'Original captureId is no longer the one retained scene; no capture was started.',
              'METRICS_SCENE_NOT_RETAINED'
            )
          )
        }
      signal?.throwIfAborted()
      return { status: 'available', scene, issue: null }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', scene: null, issue: null }
      return { status: 'unavailable', scene: null, issue: rendererCaptureIssue('inspect', error) }
    } finally {
      await file?.close()
    }
  }
  async capture(
    raw: RendererSceneCaptureInput,
    deps: PerformanceSceneDependencies,
    signal?: AbortSignal
  ): Promise<RendererSceneCaptureResult> {
    const target = { ...parseRendererSceneCaptureInput(raw).target }
    const verify = () => {
      const current = deps.currentTarget()
      if (!current || !sameRendererV8ProfileTarget(current, target))
        throw new AgentMuxError(
          'The original five-field scene target is no longer current. Existing work remains available.',
          'CONTROL_OWNER_LOST'
        )
    }
    signal?.throwIfAborted()
    if (this.disposed) throw new AgentMuxError('App scene owner is unavailable.', 'CONTROL_UNAVAILABLE')
    if (this.active)
      throw new AgentMuxError(
        'The original App scene request is still active. Only this scene request was refused.',
        'METRICS_SCENE_BUSY'
      )
    verify()
    const loaded = structuredClone(deps.loaded())
    const controller = new AbortController()
    this.active = controller
    const abort = () =>
      controller.abort(
        signal?.reason ?? new AgentMuxError('Original scene request was cancelled.', 'CONTROL_CANCELLED')
      )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const deadline = setTimeout(
      () =>
        controller.abort(
          new AgentMuxError(
            'Scene exceeded its 20-second observation budget; unconfirmed native work was not retried.',
            'CONTROL_TIMEOUT'
          )
        ),
      RENDERER_SCENE_OBSERVATION_MS
    )
    const skipped = <T>(reason: unknown): RendererScenePhase<T> => ({
      status: 'skipped',
      requestedAt: null,
      finishedAt: Date.now(),
      result: null,
      issue: rendererCaptureIssue('skip', reason)
    })
    const pending = new AgentMuxError('This original phase has not been requested.', 'SCENE_NOT_REQUESTED')
    const scene: RendererPerformanceScene = {
      schema: 'agentmux.performance-scene.v1',
      captureId: randomUUID(),
      target,
      durationMs: 2000,
      status: 'failed',
      requestedAt: Date.now(),
      finishedAt: Date.now(),
      loaded,
      before: { resources: skipped(pending), memory: skipped(pending) },
      cpu: skipped(pending),
      allocations: skipped(pending),
      timeline: skipped(pending),
      after: { resources: skipped(pending), memory: skipped(pending) }
    }
    let nativeBlocked: unknown = null,
      materialBytes = 0
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    void cancelled.catch(() => {})
    const phase = async <T>(name: string, run: () => Promise<T>, native: boolean): Promise<RendererScenePhase<T>> => {
      if (nativeBlocked && native) return skipped(nativeBlocked)
      if (controller.signal.aborted) return skipped(controller.signal.reason)
      const requestedAt = Date.now()
      try {
        verify()
        // Native owners already race cancellation and finish their original cleanup before returning.
        const result = native ? await run() : await Promise.race([run(), cancelled])
        if (!native) verify()
        const value = result as {
          status?: 'completed' | 'failed' | 'unknown'
          cleanup?: { detached: string }
          lifecycle?: { detached: string }
        }
        if (native) {
          const detached = value.cleanup?.detached ?? value.lifecycle?.detached
          if (value.status === 'unknown' || detached === 'unconfirmed' || detached === 'owner-lost')
            nativeBlocked = new AgentMuxError(
              'Original native completion or release is unconfirmed; later native phases were not acquired.',
              'SCENE_NATIVE_RELEASE_UNKNOWN'
            )
        }
        const bytes = Buffer.byteLength(JSON.stringify(result))
        if (bytes > RENDERER_SCENE_MAX_BYTES - RENDERER_SCENE_METADATA_BYTES - materialBytes)
          throw new AgentMuxError(
            `Original ${name} material (${bytes} bytes) exceeds the remaining scene budget; it was not truncated. Sibling originals remain retained.`,
            'SCENE_MATERIAL_TOO_LARGE'
          )
        materialBytes += bytes
        return { status: value.status ?? 'completed', requestedAt, finishedAt: Date.now(), result, issue: null }
      } catch (error) {
        const uncertain = controller.signal.aborted || (error as { code?: string }).code === 'CONTROL_OWNER_LOST'
        if (native && uncertain) nativeBlocked = error
        return {
          status: uncertain ? 'unknown' : 'failed',
          requestedAt,
          finishedAt: Date.now(),
          result: null,
          issue: rendererCaptureIssue(name, error)
        }
      }
    }
    try {
      scene.before.resources = await phase(
        'resources-before',
        async () => parseRendererSceneResources(await deps.resources(controller.signal), target, 'CONTROL_OWNER_LOST'),
        false
      )
      scene.before.memory = await phase('memory-before', () => deps.inspectMemory({ target }, controller.signal), true)
      const input = { target, durationMs: 2000 }
      scene.cpu = await phase('cpu', () => deps.captureProfile(input, controller.signal), true)
      scene.allocations = await phase('allocations', () => deps.captureAllocations(input, controller.signal), true)
      scene.timeline = await phase('timeline', () => deps.captureTrace(input, controller.signal), true)
      scene.after.resources = await phase(
        'resources-after',
        async () => parseRendererSceneResources(await deps.resources(controller.signal), target, 'CONTROL_OWNER_LOST'),
        false
      )
      scene.after.memory = await phase('memory-after', () => deps.inspectMemory({ target }, controller.signal), true)
      scene.finishedAt = Date.now()
      scene.status = rendererSceneStatus(scene)
      // Metadata never includes raw domain materials. Oversized originals were rejected by their phase above.
      if (Buffer.byteLength(JSON.stringify(rendererSceneMetadata(scene))) > RENDERER_SCENE_METADATA_BYTES)
        throw new AgentMuxError('Scene metadata exceeded its fixed budget.', 'CONTROL_PROTOCOL_ERROR')
      parseRendererPerformanceScene(scene, { target })
      clearTimeout(deadline)
      let persistence: RendererSceneCaptureResult['persistence']
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await this.write(this.path, rendererSceneJSON(scene), { mode: 0o600, requireDirectorySync: true })
        persistence = { status: 'confirmed', phase: null, issue: null }
      } catch (error) {
        const after = error instanceof DurableWriteError && error.phase === 'after-replace'
        persistence = {
          status: after ? 'unknown' : 'failed',
          phase: after ? 'after-replace' : 'before-replace',
          issue: rendererCaptureIssue('save', error)
        }
      }
      return parseRendererSceneCaptureResult({ scene, persistence }, { target })
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      if (this.active === controller) this.active = null
    }
  }
}

/** One bounded point read of the original metrics producer; source timestamps remain untouched. */
export async function readSceneResources(
  metrics: AgentMuxMetricsPort,
  signal: AbortSignal
): Promise<MetricsObservation> {
  let resolve!: (v: MetricsObservation) => void, reject!: (e: unknown) => void
  const result = new Promise<MetricsObservation>((yes, no) => {
    resolve = yes
    reject = no
  })
  void result.catch(() => {})
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let subscription: Awaited<ReturnType<AgentMuxMetricsPort['subscribe']>> | undefined
  let released: typeof subscription
  const release = (value: NonNullable<typeof subscription>) => {
    if (released !== value) {
      released = value
      value.dispose()
    }
  }
  const opening = metrics.subscribe(
    resolve,
    (e) => reject(e ?? new AgentMuxError('Metrics source ended before a scene observation.', 'CONTROL_UNAVAILABLE')),
    signal
  )
  void opening.then((value) => {
    if (signal.aborted) release(value)
  }, reject)
  try {
    subscription = await opening
    return await result
  } finally {
    signal.removeEventListener('abort', abort)
    if (subscription) release(subscription)
  }
}

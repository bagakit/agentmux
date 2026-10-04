import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FileBuildKind, FileBuildRequest, FileBuildSnapshot } from '../../../../shared/file-build'
import { api } from '../api'

export type FileRegionBuildResult = {
  regionId: string; buildId: string
  status: FileBuildSnapshot['status'] | 'stale' | 'missing' | 'unsupported'
  message: string | null; log: string; artifact: { kind: 'pdf'; byteLength: number } | null
}
export type FileBuildSource = {
  workspaceId: string; path: string; kind: FileBuildKind | null; content: string
  generation: number; model: object; region: object; resource: { hostId: string; path: string }
}
export type FileRegionBuildAdapter = {
  snapshot(): FileBuildSource | null
  isCurrent(source: FileBuildSource): boolean
  watch(source: FileBuildSource, invalidate: () => void): () => void
}
type Reading = { result: FileRegionBuildResult; pdf?: Uint8Array }
type Job = {
  id: string; regionId: string; adapter: FileRegionBuildAdapter; source: FileBuildSource
  reading: Reading; active: boolean; unwatch(): void; abortCleanup(): void
  start?: Promise<FileBuildSnapshot>; stopping?: Promise<FileRegionBuildResult>
  epoch: number; cancelling?: Promise<FileRegionBuildResult> | undefined
}
const adapters = new Map<string, FileRegionBuildAdapter>()
const jobs = new Map<string, Job>()
const regionJobs = new Map<string, Job>()
const listeners = new Map<string, Set<() => void>>()
const terminal = new Set<FileRegionBuildResult['status']>(['succeeded', 'failed', 'cancelled', 'unavailable', 'missing'])

function result(regionId: string, buildId: string, status: FileRegionBuildResult['status'], message: string | null, log = ''): FileRegionBuildResult {
  return { regionId, buildId, status, message, log, artifact: null }
}
function publish(job: Job, reading: Reading): void {
  job.reading = reading
  for (const listener of listeners.get(job.regionId) ?? []) listener()
}
function stop(job: Job, status: 'stale' | 'cancelled', message: string): Promise<FileRegionBuildResult> {
  if (!job.active) return job.stopping ?? Promise.resolve(job.reading.result)
  job.active = false
  job.unwatch(); job.unwatch = () => {}; job.abortCleanup(); job.abortCleanup = () => {}
  publish(job, { result: result(job.regionId, job.id, status === 'stale' ? 'stale' : 'running', status === 'stale' ? message : 'Cancelling document build…', job.reading.result.log) })
  job.stopping = (async () => {
    try {
      // Cancellation can precede the asynchronous start response. Wait for registration,
      // then Main waits for the exact process group to exit before confirming cancellation.
      await job.start?.catch(() => undefined)
      let snapshot: FileBuildSnapshot | undefined
      try { snapshot = await api.files.cancelBuild(job.id) }
      finally { await api.files.releaseBuild(job.id) }
      if (status !== 'stale' && !job.adapter.isCurrent(job.source)) {
        publish(job, { result: result(job.regionId, job.id, 'stale', 'The original File draft changed while cancelling. Build the current draft again.', snapshot?.log ?? job.reading.result.log) })
      } else if (status !== 'stale') {
        const value = result(job.regionId, job.id, snapshot?.status ?? 'missing', snapshot?.message ?? message, snapshot?.log ?? job.reading.result.log)
        if (snapshot?.status === 'succeeded') {
          if (snapshot.pdf?.byteLength) { value.artifact = { kind: 'pdf', byteLength: snapshot.pdf.byteLength }; publish(job, { result: value, pdf: snapshot.pdf }) }
          else publish(job, { result: result(job.regionId, job.id, 'failed', 'The compiler returned no PDF artifact.', value.log) })
        } else publish(job, { result: value })
      }
    } catch (error) {
      if (status !== 'stale') publish(job, { result: result(job.regionId, job.id, 'unknown', presentError(error), job.reading.result.log) })
    }
    return job.reading.result
  })()
  return job.stopping
}
function current(job: Job): boolean {
  return job.active && jobs.get(job.id) === job && regionJobs.get(job.regionId) === job &&
    adapters.get(job.regionId) === job.adapter && job.adapter.isCurrent(job.source)
}
function accept(job: Job, snapshot: FileBuildSnapshot | undefined): FileRegionBuildResult {
  if (!current(job)) {
    void stop(job, 'stale', 'The original File draft or Workspace changed. Build the current draft again.')
    return job.reading.result
  }
  if (!snapshot) {
    publish(job, { result: result(job.regionId, job.id, 'missing', 'This build is no longer available. Build the current draft again.') })
    return job.reading.result
  }
  if (snapshot.id !== job.id || snapshot.workspaceId !== job.source.workspaceId || snapshot.path !== job.source.path || snapshot.kind !== job.source.kind) {
    void stop(job, 'stale', 'The build response belongs to a different File. Build the current draft again.')
    return job.reading.result
  }
  if (snapshot.status === 'succeeded' && (!snapshot.pdf || snapshot.pdf.byteLength === 0)) {
    publish(job, { result: result(job.regionId, job.id, 'failed', 'The compiler returned no PDF artifact. See the build log.', snapshot.log) })
  } else {
    const value = result(job.regionId, job.id, snapshot.status, snapshot.message, snapshot.log)
    if (snapshot.status === 'succeeded' && snapshot.pdf) {
      value.artifact = { kind: 'pdf', byteLength: snapshot.pdf.byteLength }
      publish(job, { result: value, pdf: snapshot.pdf })
    } else publish(job, { result: value })
  }
  return job.reading.result
}

/** A live File supplies its existing document capability; no new text owner is created. */
export function registerFileRegionBuilder(regionId: string, adapter: FileRegionBuildAdapter): () => void {
  const previous = regionJobs.get(regionId)
  if (previous) releaseFileRegionBuild(regionId)
  adapters.set(regionId, adapter)
  return () => {
    if (adapters.get(regionId) !== adapter) return
    releaseFileRegionBuild(regionId)
    adapters.delete(regionId)
  }
}
export function subscribeFileRegionBuild(regionId: string, listener: () => void): () => void {
  let set = listeners.get(regionId)
  if (!set) { set = new Set(); listeners.set(regionId, set) }
  set.add(listener)
  return () => { set.delete(listener); if (!set.size) listeners.delete(regionId) }
}
export function readFileRegionBuild(regionId: string): Reading | undefined { return regionJobs.get(regionId)?.reading }
export function releaseFileRegionBuild(regionId: string): void {
  const job = regionJobs.get(regionId)
  if (!job) return
  void stop(job, 'stale', 'The build preview or original File closed. Build the current draft again.')
  regionJobs.delete(regionId); jobs.delete(job.id)
  for (const listener of listeners.get(regionId) ?? []) listener()
}

/** Explicit GUI/public action; starting a preview never invokes this function. */
export async function buildFileRegion(regionId: string, signal?: AbortSignal, buildId: string = crypto.randomUUID()): Promise<FileRegionBuildResult> {
  if (signal?.aborted) return result(regionId, buildId, 'cancelled', 'Document build cancelled. The draft is unchanged.')
  const adapter = adapters.get(regionId)
  if (!adapter) return result(regionId, buildId, 'unavailable', 'The original File Region is not visible. Open it before building.')
  let source: FileBuildSource | null
  try { source = adapter.snapshot() }
  catch (error) { return result(regionId, buildId, 'failed', presentError(error)) }
  if (!source) return result(regionId, buildId, 'unavailable', 'The current File draft or resource binding is unavailable. Retry build.')
  if (!source.kind) return result(regionId, buildId, 'unsupported', 'This File has no document compiler.')
  if (jobs.has(buildId)) return result(regionId, buildId, 'failed', 'This build id is already owned by a document job.')
  releaseFileRegionBuild(regionId)
  const job: Job = { id: buildId, regionId, adapter, source, active: true, epoch: 0, unwatch: () => {}, abortCleanup: () => {},
    reading: { result: result(regionId, buildId, 'running', null) } }
  jobs.set(buildId, job); regionJobs.set(regionId, job)
  const abort = () => { void stop(job, 'cancelled', 'Document build cancelled. The draft is unchanged.') }
  signal?.addEventListener('abort', abort, { once: true })
  job.abortCleanup = () => signal?.removeEventListener('abort', abort)
  publish(job, job.reading)
  try {
    const cleanup = adapter.watch(source, () => { void stop(job, 'stale', 'The original File draft or Workspace changed. Build the current draft again.') })
    if (job.active) job.unwatch = cleanup
    else cleanup()
    if (signal?.aborted) abort()
    if (!job.active) return await (job.stopping ?? Promise.resolve(job.reading.result))
    const request: FileBuildRequest = { id: buildId, kind: source.kind, path: source.path, content: source.content, resource: source.resource }
    const startedEpoch = ++job.epoch
    job.start = api.files.build(source.workspaceId, request)
    const snapshot = await job.start
    if (!job.active) return await (job.stopping ?? Promise.resolve(job.reading.result))
    job.abortCleanup(); job.abortCleanup = () => {}
    if (job.epoch !== startedEpoch) return job.reading.result
    return accept(job, snapshot)
  } catch (error) {
    if (job.active) {
      job.abortCleanup(); job.abortCleanup = () => {}
      publish(job, { result: result(regionId, buildId, 'failed', presentError(error), job.reading.result.log) })
      void api.files.releaseBuild(buildId).catch(() => {})
    }
    return job.reading.result
  }
}
export async function inspectFileRegionBuild(regionId: string, buildId: string): Promise<FileRegionBuildResult> {
  const job = jobs.get(buildId)
  if (!job || job.regionId !== regionId) return result(regionId, buildId, 'missing', 'This build does not belong to the original File Region.')
  if (!job.active) return job.reading.result
  if (job.cancelling || terminal.has(job.reading.result.status)) return job.reading.result
  const inspectedEpoch = ++job.epoch
  try {
    const snapshot = await api.files.inspectBuild(buildId)
    if (job.epoch !== inspectedEpoch) return job.reading.result
    return accept(job, snapshot)
  }
  catch (error) {
    if (job.active && job.epoch === inspectedEpoch) publish(job, { result: result(regionId, buildId, 'unknown', presentError(error), job.reading.result.log) })
    return job.reading.result
  }
}
export async function cancelFileRegionBuild(regionId: string, buildId: string): Promise<FileRegionBuildResult> {
  const job = jobs.get(buildId)
  if (!job || job.regionId !== regionId) return result(regionId, buildId, 'missing', 'This build does not belong to the original File Region.')
  if (!job.active) return await (job.stopping ?? Promise.resolve(job.reading.result))
  if (job.cancelling) return await job.cancelling
  if (terminal.has(job.reading.result.status)) return job.reading.result
  const cancelledEpoch = ++job.epoch
  publish(job, { result: result(regionId, buildId, 'running', 'Cancelling document build…', job.reading.result.log) })
  job.cancelling = (async () => {
    try {
      await job.start
      const snapshot = await api.files.cancelBuild(buildId)
      const confirmed = accept(job, snapshot)
      // A compiler can finish before cancellation reaches it. Preserve that real PDF result.
      if (confirmed.status !== 'succeeded') await api.files.releaseBuild(buildId)
    } catch (error) {
      if (job.active && job.epoch === cancelledEpoch) publish(job, { result: result(regionId, buildId, 'unknown', presentError(error), job.reading.result.log) })
    } finally { job.cancelling = undefined }
    return job.reading.result
  })()
  return await job.cancelling
}

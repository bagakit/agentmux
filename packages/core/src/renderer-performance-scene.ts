import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMetricsObservation, type MetricsObservation } from './metrics.js'
import { parseRendererMemoryResult, type RendererMemoryResult } from './renderer-memory.js'
import { parseRendererTraceResult, type RendererTraceResult } from './renderer-trace.js'
import { parseRendererAllocationsResult, type RendererAllocationsResult } from './renderer-allocations.js'
import {
  parseRendererV8Target,
  parseRendererV8ProfileResult,
  sameRendererV8ProfileTarget,
  type RendererV8ProfileTarget,
  type RendererV8ProfileResult,
  type RendererV8ProfileIssue
} from './renderer-v8-profile.js'
export const RENDERER_SCENE_MAX_BYTES = 32 * 1024 * 1024
export const RENDERER_SCENE_RESOURCE_MAX_BYTES = 3 * 1024 * 1024
export const RENDERER_SCENE_METADATA_BYTES = 128 * 1024
export const RENDERER_SCENE_DURATION_MS = 2000
export const RENDERER_SCENE_OBSERVATION_MS = 20000
export type RendererSceneCaptureInput = { target: RendererV8ProfileTarget }
export type RendererSceneInspectInput = { captureId?: string }
export type RendererScenePhase<T> = {
  status: 'completed' | 'failed' | 'unknown' | 'skipped'
  requestedAt: number | null
  finishedAt: number
  result: T | null
  issue: RendererV8ProfileIssue | null
}
export type RendererSceneLoaded = {
  mainPid: number
  package: {
    schema: 'agentmux.package-identity.v1'
    sourceCommit: string
    sourceTree: string
    appVersion: string
    platform: string
    arch: string
  } | null
  renderer: { kind: 'bundled' | 'staged'; id: string; identity: { shell: string; ctxmux: string } } | null
}
export type RendererPerformanceScene = {
  schema: 'agentmux.performance-scene.v1'
  captureId: string
  target: RendererV8ProfileTarget
  durationMs: 2000
  status: 'completed' | 'partial' | 'failed' | 'unknown'
  requestedAt: number
  finishedAt: number
  loaded: RendererSceneLoaded
  before: { resources: RendererScenePhase<MetricsObservation>; memory: RendererScenePhase<RendererMemoryResult> }
  cpu: RendererScenePhase<RendererV8ProfileResult>
  allocations: RendererScenePhase<RendererAllocationsResult>
  timeline: RendererScenePhase<RendererTraceResult>
  after: { resources: RendererScenePhase<MetricsObservation>; memory: RendererScenePhase<RendererMemoryResult> }
}
export type RendererSceneCaptureResult = {
  scene: RendererPerformanceScene
  persistence: {
    status: 'confirmed' | 'failed' | 'unknown'
    phase: 'before-replace' | 'after-replace' | null
    issue: RendererV8ProfileIssue | null
  }
}
export type RendererSceneInspection = {
  status: 'available' | 'absent' | 'unavailable' | 'mismatch'
  scene: RendererPerformanceScene | null
  issue: RendererV8ProfileIssue | null
}
const bad = (code = 'CONTROL_PROTOCOL_ERROR'): never => {
  throw new AgentMuxError('Renderer performance scene contract is invalid.', code)
}
const fields = (v: unknown, keys: string[], code = 'CONTROL_PROTOCOL_ERROR') => {
  const r = rpcRecord(v, keys, code)
  if (Object.keys(r).length !== keys.length) bad(code)
  return r
}
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const id = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 512 && !/[\0\r\n]/u.test(v)
function issue(v: unknown) {
  if (v === null) return
  const r = fields(v, ['stage', 'code', 'message', 'messageTruncated'])
  if (
    typeof r.stage !== 'string' ||
    r.stage.length > 80 ||
    typeof r.code !== 'string' ||
    r.code.length > 128 ||
    typeof r.message !== 'string' ||
    r.message.length > 2048 ||
    typeof r.messageTruncated !== 'boolean'
  )
    bad()
}
export function parseRendererSceneCaptureInput(
  v: unknown,
  code = 'INVALID_CONTROL_REQUEST'
): RendererSceneCaptureInput {
  const r = fields(v, ['target'], code)
  parseRendererV8Target(r.target, code)
  return r as RendererSceneCaptureInput
}
export function parseRendererSceneInspectInput(
  v: unknown,
  code = 'INVALID_CONTROL_REQUEST'
): RendererSceneInspectInput {
  const r = rpcRecord(v, ['captureId'], code)
  if (r.captureId !== undefined && !id(r.captureId)) bad(code)
  return r as RendererSceneInspectInput
}
export function rendererScenePhases(scene: RendererPerformanceScene) {
  return [
    scene.before.resources,
    scene.before.memory,
    scene.cpu,
    scene.allocations,
    scene.timeline,
    scene.after.resources,
    scene.after.memory
  ]
}
export function rendererSceneStatus(scene: RendererPerformanceScene): RendererPerformanceScene['status'] {
  const states = rendererScenePhases(scene).map((x) => x.status)
  return states.every((x) => x === 'completed')
    ? 'completed'
    : states.some((x) => x === 'completed')
      ? 'partial'
      : states.some((x) => x === 'unknown')
        ? 'unknown'
        : 'failed'
}
export function rendererSceneMetadata(scene: RendererPerformanceScene) {
  const phase = (p: RendererScenePhase<unknown>) => ({ ...p, result: null })
  return {
    ...scene,
    before: { resources: phase(scene.before.resources), memory: phase(scene.before.memory) },
    cpu: phase(scene.cpu),
    allocations: phase(scene.allocations),
    timeline: phase(scene.timeline),
    after: { resources: phase(scene.after.resources), memory: phase(scene.after.memory) }
  }
}
export function rendererSceneJSON(scene: RendererPerformanceScene): string {
  const text = JSON.stringify(scene)
  if (new TextEncoder().encode(text).byteLength > RENDERER_SCENE_MAX_BYTES) bad()
  return text
}
/** Window-scoped facts may not silently move to a later Renderer inside an original scene. */
export function parseRendererSceneResources(
  value: unknown,
  target: RendererV8ProfileTarget,
  code = 'CONTROL_PROTOCOL_ERROR'
): MetricsObservation {
  const observation = parseMetricsObservation(value)
  const matches = (window: MetricsObservation['window']) =>
    !window ||
    (window.windowId === target.windowId &&
      window.webContentsId === target.webContentsId &&
      window.generation === target.generation)
  const renderer = observation.renderer.data
  if (
    !matches(observation.window) ||
    (renderer &&
      (!matches(renderer.window) ||
        (renderer.process.pid !== null && renderer.process.pid !== target.pid) ||
        (renderer.process.creationTime !== null && renderer.process.creationTime !== target.creationTime)))
  ) {
    throw new AgentMuxError(
      'Resource observation belongs to another Renderer identity; original scene and sibling materials remain available.',
      code
    )
  }
  if (new TextEncoder().encode(JSON.stringify(observation)).byteLength > RENDERER_SCENE_RESOURCE_MAX_BYTES)
    throw new AgentMuxError(
      'Original resource point read exceeds its 3 MiB scene budget; no truncated observation was returned.',
      'SCENE_MATERIAL_TOO_LARGE'
    )
  return observation
}
export function parseRendererPerformanceScene(v: unknown, input?: RendererSceneCaptureInput): RendererPerformanceScene {
  const r = fields(v, [
    'schema',
    'captureId',
    'target',
    'durationMs',
    'status',
    'requestedAt',
    'finishedAt',
    'loaded',
    'before',
    'cpu',
    'allocations',
    'timeline',
    'after'
  ])
  const target = parseRendererV8Target(r.target, 'CONTROL_PROTOCOL_ERROR')
  if (input && !sameRendererV8ProfileTarget(target, input.target)) bad()
  if (
    r.schema !== 'agentmux.performance-scene.v1' ||
    !id(r.captureId) ||
    r.durationMs !== 2000 ||
    !['completed', 'partial', 'failed', 'unknown'].includes(String(r.status)) ||
    !number(r.requestedAt) ||
    !number(r.finishedAt) ||
    r.finishedAt < r.requestedAt
  )
    bad()
  const loaded = fields(r.loaded, ['mainPid', 'package', 'renderer'])
  if (!Number.isSafeInteger(loaded.mainPid) || Number(loaded.mainPid) <= 0) bad()
  if (loaded.package !== null) {
    const p = fields(loaded.package, ['schema', 'sourceCommit', 'sourceTree', 'appVersion', 'platform', 'arch'])
    if (
      p.schema !== 'agentmux.package-identity.v1' ||
      ['sourceCommit', 'sourceTree', 'appVersion', 'platform', 'arch'].some((k) => !id(p[k]))
    )
      bad()
  }
  if (loaded.renderer !== null) {
    const p = fields(loaded.renderer, ['kind', 'id', 'identity']),
      identity = fields(p.identity, ['shell', 'ctxmux'])
    if (
      !['bundled', 'staged'].includes(String(p.kind)) ||
      typeof p.id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(p.id) ||
      !id(identity.shell) ||
      !id(identity.ctxmux)
    )
      bad()
  }
  const phase = (value: unknown, parse: (v: unknown) => unknown) => {
    const p = fields(value, ['status', 'requestedAt', 'finishedAt', 'result', 'issue'])
    if (
      !['completed', 'failed', 'unknown', 'skipped'].includes(String(p.status)) ||
      (p.requestedAt !== null && !number(p.requestedAt)) ||
      !number(p.finishedAt) ||
      (p.requestedAt !== null && p.finishedAt < Number(p.requestedAt))
    )
      bad()
    issue(p.issue)
    if (p.result !== null) {
      parse(p.result)
      if (p.issue !== null || p.status === 'skipped' || p.requestedAt === null) bad()
      const s = (p.result as { status?: string }).status
      if (s !== undefined && s !== p.status) bad()
    } else if (p.issue === null || p.status === 'completed') bad()
    if (p.status === 'skipped' && p.requestedAt !== null) bad()
  }
  const nativeInput = { target, durationMs: 2000 }
  for (const side of ['before', 'after']) {
    const p = fields(r[side], ['resources', 'memory'])
    phase(p.resources, (v) => parseRendererSceneResources(v, target))
    phase(p.memory, (v) => parseRendererMemoryResult(v, { target }))
  }
  phase(r.cpu, (v) => parseRendererV8ProfileResult(v, nativeInput))
  phase(r.allocations, (v) => parseRendererAllocationsResult(v, nativeInput))
  phase(r.timeline, (v) => parseRendererTraceResult(v, nativeInput))
  const scene = r as unknown as RendererPerformanceScene
  if (scene.status !== rendererSceneStatus(scene)) bad()
  rendererSceneJSON(scene)
  if (new TextEncoder().encode(JSON.stringify(rendererSceneMetadata(scene))).byteLength > RENDERER_SCENE_METADATA_BYTES)
    bad()
  return scene
}
export function parseRendererSceneCaptureResult(
  v: unknown,
  input?: RendererSceneCaptureInput
): RendererSceneCaptureResult {
  const r = fields(v, ['scene', 'persistence'])
  parseRendererPerformanceScene(r.scene, input)
  const p = fields(r.persistence, ['status', 'phase', 'issue'])
  if (
    !['confirmed', 'failed', 'unknown'].includes(String(p.status)) ||
    !['before-replace', 'after-replace', null].includes(p.phase as string | null)
  )
    bad()
  issue(p.issue)
  if (
    (p.status === 'confirmed' && (p.issue !== null || p.phase !== null)) ||
    (p.status !== 'confirmed' && p.issue === null) ||
    (p.status === 'failed' && p.phase !== 'before-replace') ||
    (p.status === 'unknown' && p.phase !== 'after-replace')
  )
    bad()
  return r as unknown as RendererSceneCaptureResult
}
export function parseRendererSceneInspection(
  v: unknown,
  input: RendererSceneInspectInput = {}
): RendererSceneInspection {
  const r = fields(v, ['status', 'scene', 'issue'])
  if (!['available', 'absent', 'unavailable', 'mismatch'].includes(String(r.status))) bad()
  issue(r.issue)
  if (r.status === 'available') {
    const scene = parseRendererPerformanceScene(r.scene)
    if (r.issue !== null || (input.captureId !== undefined && scene.captureId !== input.captureId)) bad()
  } else if (
    r.scene !== null ||
    (r.status === 'absent' && r.issue !== null) ||
    (r.status !== 'absent' && r.issue === null)
  )
    bad()
  return r as unknown as RendererSceneInspection
}

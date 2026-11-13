import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parsePngImage } from './png-image.js'
import { parseAppWindowTarget, type AppWindowActor, type AppWindowTarget } from './public-rpc-windows.js'
import type { NativeDesktopPng } from './native-desktop-types.js'

/** Explicit capture budgets protect one image/RPC/encoder, never a healthy Run. */
export const APP_CAPTURE_LIMITS = Object.freeze({ maxPixels: 16 * 1024 * 1024, maxVideoBytes: 16 * 1024 * 1024,
  maxDurationMs: 60_000, maxFps: 30, maxVideoWidth: 1920, maxVideoHeight: 1080 })
export type AppCaptureTarget = { windowId: string; documentGeneration: string; region?: Extract<AppWindowTarget, { kind: 'region' }> }
export type AppCaptureRect = { x: number; y: number; width: number; height: number }
export type AppCaptureLayer = { kind: 'renderer' | 'browser'; webContentsId: number; browserId: string | null; bounds: AppCaptureRect }
export type AppCaptureFrame = { target: AppCaptureTarget; startedAt: number; observedAt: number;
  bounds: AppCaptureRect; image: NativeDesktopPng; layers: AppCaptureLayer[] }
export type AppRecordStart = { operationId: string; target: AppCaptureTarget; durationMs: number; fps: number }
export type AppCaptureGap = { startedAt: number; observedAt: number; code: 'APP_CAPTURE_FRAME_CHANGED' }
export type AppRecording = AppRecordStart & { actor: AppWindowActor;
  state: 'starting' | 'recording' | 'stopping' | 'completed' | 'partial' | 'failed' | 'interrupted';
  requestedAt: number; startedAt: number | null; finishedAt: number | null;
  width: number | null; height: number | null;
  /** Successful source observations delivered to the encoder, not a promised fixed frame rate. */
  frameCount: number; bytes: number; sha256: string | null; gaps: AppCaptureGap[]; issues: string[] }
export type AppRecordPage = { recording: AppRecording | null; video?: { format: 'webm'; data: string }; frames?: { startedAt: number; observedAt: number; bounds: AppCaptureRect; layers: AppCaptureLayer[] }[] }
export type AppCaptureParamsMap = {
  'app.capture': { target: AppCaptureTarget }
  'app.record.start': AppRecordStart
  'app.record.inspect': { operationId: string }
  'app.record.stop': { operationId: string }
  'app.record.read': { operationId: string }
}
export type AppCaptureResultMap = { 'app.capture': AppCaptureFrame } & { [M in Exclude<AppCaptureMethod, 'app.capture'>]: AppRecordPage }
export type AppCaptureMethod = keyof AppCaptureParamsMap
export const APP_CAPTURE_METHODS = { 'app.capture': 'long', 'app.record.start': 'long',
  'app.record.inspect': 'short', 'app.record.stop': 'long', 'app.record.read': 'long' } as const
export function isAppCaptureMethod(value: unknown): value is AppCaptureMethod {
  return typeof value === 'string' && Object.hasOwn(APP_CAPTURE_METHODS, value)
}
export type AppCaptureContext = { actor: AppWindowActor; signal?: AbortSignal; assertCurrent?(): void | Promise<void> }
export interface AppCapturePort {
  call<M extends AppCaptureMethod>(method: M, input: AppCaptureParamsMap[M], context: AppCaptureContext): Promise<AppCaptureResultMap[M]>
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message + ' Original workfaces and Agents remain available.', code) }
function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value === 'self' || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) invalid('An exact capture identity is required.', code)
  return value
}
function count(value: unknown, max: number, code: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid('Capture count or budget is invalid.', code)
  return value
}
export function parseAppCaptureTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AppCaptureTarget {
  const p = rpcRecord(value, ['windowId', 'documentGeneration', 'region'], code)
  const target: AppCaptureTarget = { windowId: identity(p.windowId, code), documentGeneration: identity(p.documentGeneration, code) }
  if (p.region !== undefined) {
    const region = parseAppWindowTarget(p.region, code)
    if (region.kind !== 'region') invalid('Capture needs the exact Region occurrence.', code)
    target.region = region
  }
  return target
}
export function parseAppCaptureParams<M extends AppCaptureMethod>(method: M, value: unknown, code = 'INVALID_CONTROL_REQUEST'): AppCaptureParamsMap[M] {
  const fields = method === 'app.capture' ? ['target'] : method === 'app.record.start' ? ['operationId', 'target', 'durationMs', 'fps'] : ['operationId']
  const p = rpcRecord(value, fields, code)
  const result = method === 'app.capture' ? { target: parseAppCaptureTarget(p.target, code) }
    : method === 'app.record.start' ? { operationId: identity(p.operationId, code), target: parseAppCaptureTarget(p.target, code),
      durationMs: count(p.durationMs, APP_CAPTURE_LIMITS.maxDurationMs, code, 100), fps: count(p.fps, APP_CAPTURE_LIMITS.maxFps, code, 1) }
    : { operationId: identity(p.operationId, code) }
  return result as AppCaptureParamsMap[M]
}
function rect(value: unknown, code: string): AppCaptureRect {
  const p = rpcRecord(value, ['x', 'y', 'width', 'height'], code)
  if (!['x', 'y', 'width', 'height'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k])) || Number(p.width) <= 0 || Number(p.height) <= 0) invalid('Capture geometry is unconfirmed.', code)
  return p as AppCaptureRect
}
function parseLayers(value: unknown, code: string): AppCaptureLayer[] {
  if (!Array.isArray(value) || !value.length) invalid('Capture has no observed source.', code)
  return value.map(v => {
    const l = rpcRecord(v, ['kind', 'webContentsId', 'browserId', 'bounds'], code)
    if (l.kind !== 'renderer' && l.kind !== 'browser') invalid('Capture layer kind is invalid.', code)
    if (l.kind === 'renderer' ? l.browserId !== null : typeof l.browserId !== 'string') invalid('Capture source identity is unconfirmed.', code)
    return { kind: l.kind, webContentsId: count(l.webContentsId, Number.MAX_SAFE_INTEGER, code, 1),
      browserId: l.browserId === null ? null : identity(l.browserId, code), bounds: rect(l.bounds, code) }
  })
}
export function parseAppCaptureFrame(value: unknown, target?: AppCaptureTarget): AppCaptureFrame {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['target', 'startedAt', 'observedAt', 'bounds', 'image', 'layers'], code)
  const observedTarget = parseAppCaptureTarget(p.target, code)
  if (target && JSON.stringify(target) !== JSON.stringify(observedTarget)) invalid('Captured pixels belong to another target.', code)
  const startedAt = count(p.startedAt, Number.MAX_SAFE_INTEGER, code), observedAt = count(p.observedAt, Number.MAX_SAFE_INTEGER, code)
  if (observedAt < startedAt) invalid('Capture observation precedes its start.', code)
  const image = parsePngImage(p.image, code), bounds = rect(p.bounds, code)
  if (image.width !== bounds.width || image.height !== bounds.height || image.scale !== 1) invalid('Capture pixels do not match their original logical crop.', code)
  if (image.width * image.height > APP_CAPTURE_LIMITS.maxPixels) invalid('Capture exceeds its pixel memory budget.', code)
  if (!Array.isArray(p.layers) || !p.layers.length) invalid('Capture has no observed source.', code)
  const layers = parseLayers(p.layers, code)
  return { target: observedTarget, startedAt, observedAt, bounds, image, layers }
}
export function parseAppRecording(value: unknown): AppRecording {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'target', 'durationMs', 'fps', 'actor', 'state',
    'requestedAt', 'startedAt', 'finishedAt', 'width', 'height', 'frameCount', 'bytes', 'sha256', 'gaps', 'issues'], code)
  const start = parseAppCaptureParams('app.record.start', { operationId: p.operationId, target: p.target, durationMs: p.durationMs, fps: p.fps }, code)
  const a = rpcRecord(p.actor, ['kind', 'id'], code)
  if (!['agent', 'user', 'device'].includes(String(a.kind)) || !['starting', 'recording', 'stopping', 'completed', 'partial', 'failed', 'interrupted'].includes(String(p.state))) invalid('Recording owner or state is invalid.', code)
  const actor: AppWindowActor = { kind: a.kind as AppWindowActor['kind'], id: identity(a.id, code) }
  const nullable = (v: unknown, max = Number.MAX_SAFE_INTEGER) => v === null ? null : count(v, max, code)
  const requestedAt = count(p.requestedAt, Number.MAX_SAFE_INTEGER, code), startedAt = nullable(p.startedAt), finishedAt = nullable(p.finishedAt)
  const width = nullable(p.width, APP_CAPTURE_LIMITS.maxVideoWidth), height = nullable(p.height, APP_CAPTURE_LIMITS.maxVideoHeight)
  const frameCount = count(p.frameCount, Number.MAX_SAFE_INTEGER, code), bytes = count(p.bytes, APP_CAPTURE_LIMITS.maxVideoBytes, code)
  if (p.sha256 !== null && (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256))) invalid('Recording digest is invalid.', code)
  if (!Array.isArray(p.issues) || p.issues.some(v => typeof v !== 'string')) invalid('Recording diagnostics are invalid.', code)
  if (startedAt !== null && startedAt < requestedAt || finishedAt !== null && finishedAt < (startedAt ?? requestedAt)) invalid('Recording time order is invalid.', code)
  if ((p.state === 'completed' || p.state === 'partial') && (!frameCount || !bytes || !width || !height || !p.sha256 || startedAt === null || finishedAt === null)) invalid('Completed recording lacks actual pixels or encoding.', code)
  if (!Array.isArray(p.gaps) || p.gaps.length > APP_CAPTURE_LIMITS.maxDurationMs / 1000 * APP_CAPTURE_LIMITS.maxFps + 1) invalid('Recording gaps are invalid.', code)
  const gaps: AppCaptureGap[] = p.gaps.map(value => {
    const gap = rpcRecord(value, ['startedAt', 'observedAt', 'code'], code)
    const startedAt = count(gap.startedAt, Number.MAX_SAFE_INTEGER, code), observedAt = count(gap.observedAt, Number.MAX_SAFE_INTEGER, code)
    if (gap.code !== 'APP_CAPTURE_FRAME_CHANGED' || observedAt < startedAt) invalid('The original frame gap is invalid.', code)
    return { startedAt, observedAt, code: 'APP_CAPTURE_FRAME_CHANGED' }
  })
  if (p.state === 'partial' && !gaps.length || p.state === 'completed' && gaps.length) invalid('Recording completeness differs from its original observation gaps.', code)
  return { ...start, actor, state: p.state as AppRecording['state'], requestedAt, startedAt, finishedAt, width, height,
    frameCount, bytes, sha256: p.sha256 as string | null, gaps, issues: p.issues as string[] }
}
export function parseAppCaptureResult<M extends AppCaptureMethod>(method: M, value: unknown, input: AppCaptureParamsMap[M], actor?: AppWindowActor): AppCaptureResultMap[M] {
  if (method === 'app.capture') return parseAppCaptureFrame(value, (input as AppCaptureParamsMap['app.capture']).target) as AppCaptureResultMap[M]
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['recording', 'video', 'frames'], code)
  const recording = p.recording === null ? null : parseAppRecording(p.recording)
  if (recording && recording.operationId !== (input as { operationId: string }).operationId) invalid('Recording belongs to another original operation.', code)
  if (method === 'app.record.start') {
    const start = input as AppRecordStart
    if (!recording || JSON.stringify(recording.target) !== JSON.stringify(start.target) || recording.durationMs !== start.durationMs || recording.fps !== start.fps) invalid('Recording intent changed.', code)
  }
  if (recording && actor && (recording.actor.kind !== actor.kind || recording.actor.id !== actor.id)) invalid('Recording belongs to another original actor.', code)
  let video: AppRecordPage['video']
  if (p.video !== undefined) {
    const v = rpcRecord(p.video, ['format', 'data'], code)
    if (method !== 'app.record.read' || !recording || v.format !== 'webm' || typeof v.data !== 'string' ||
      v.data.length > Math.ceil(APP_CAPTURE_LIMITS.maxVideoBytes / 3) * 4) invalid('Recording payload is invalid.', code)
    const data = Buffer.from(v.data, 'base64')
    if (!data.length || data.toString('base64') !== v.data || data.length !== recording.bytes || data.subarray(0, 4).toString('hex') !== '1a45dfa3') invalid('Recording payload does not match its original artifact.', code)
    if (createHash('sha256').update(data).digest('hex') !== recording.sha256) invalid('Recording payload checksum changed.', code)
    video = { format: 'webm', data: v.data }
  }
  let frames: AppRecordPage['frames']
  if (p.frames !== undefined) {
    if (method !== 'app.record.read' || !Array.isArray(p.frames) || p.frames.length > APP_CAPTURE_LIMITS.maxDurationMs / 1000 * APP_CAPTURE_LIMITS.maxFps + 1) invalid('Recording frame manifest is invalid.', code)
    frames = p.frames.map(value => {
      const f = rpcRecord(value, ['startedAt', 'observedAt', 'bounds', 'layers'], code)
      const startedAt = count(f.startedAt, Number.MAX_SAFE_INTEGER, code), observedAt = count(f.observedAt, Number.MAX_SAFE_INTEGER, code)
      if (observedAt < startedAt || !Array.isArray(f.layers)) invalid('Recording frame observation is invalid.', code)
      return { startedAt, observedAt, bounds: rect(f.bounds, code), layers: parseLayers(f.layers, code) }
    })
    if (recording && frames.length !== recording.frameCount) invalid('Recording frame manifest count changed.', code)
  }
  return { recording, ...(video ? { video } : {}), ...(frames ? { frames } : {}) } as AppCaptureResultMap[M]
}

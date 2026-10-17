import { AgentMuxError } from './errors.js'

/** Captured page data, never an instruction, DOM handle or Browser control grant. */
export type BrowserInputContext = {
  kind: 'browser'
  version: 1
  capturedAt: number
  browser: { hostId: string; browserId: string; navigationId: string | null }
  page: { url: string; title?: string }
  activity?: { operationId: string; stepSequence: number | null; phase: string; observedAt: number }
  selection?: BrowserInputSelection
}
/** The Host owns image lifetime and retrieval. Core neither opens paths nor embeds image bytes. */
export type BrowserInputImageReference = { hostId: string; path: string; mimeType: 'image/png'; width: number; height: number; sha256?: string }
export type BrowserInputSelectionSource = {
  hostId: string; browserId: string; navigationId: string | null
  operationId?: string; stepSequence?: number
  association: 'exact-step' | 'observed-during' | 'unknown'
}
export type BrowserInputSelection = {
  kind: 'region' | 'element'
  capturedAt: number
  source: BrowserInputSelectionSource
  /** A capture which crossed an observation boundary retains both facts. */
  observationEnd?: BrowserInputSelectionSource & { observedAt: number }
  frameId?: string
  attachment?: BrowserInputImageReference
  viewport?: { width: number; height: number; deviceScaleFactor: number | null }
  crop?: { x: number; y: number; width: number; height: number }
  region?: { x: number; y: number; width: number; height: number; space: 'capture-pixels' }
  /** Already sanitized by the capture Host; never an actionable ref. */
  element?: { tagName: string; role: string; accessibleName: string; selector: string; text: string; nearbyText: string[]; attributes: Record<string, string>; html: string }
}
/** Attribution of the context producer, independently of the input's author. */
export type BrowserInputContextSource = 'caller-declared' | 'host-capture'

const fail = (): never => { throw new AgentMuxError('Browser input context is invalid. Keep the original input and capture; no replacement page was observed.', 'INVALID_BROWSER_INPUT_CONTEXT') }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, identity = false): string {
  if (typeof value !== 'string' || value.includes('\0') || identity && (!value.trim() || /[\r\n]/u.test(value))) fail()
  return value as string
}
function count(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0)) fail()
  return value as number
}
function finite(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || positive && value === 0) fail()
  return value as number
}
function navigation(value: unknown): string | null { return value === null ? null : text(value, true) }
function source(value: unknown, end = false): BrowserInputSelectionSource & { observedAt?: number } {
  const p = object(value, ['hostId', 'browserId', 'navigationId', 'operationId', 'stepSequence', 'association', ...(end ? ['observedAt'] : [])])
  if (!['exact-step', 'observed-during', 'unknown'].includes(String(p.association)) || p.association === 'exact-step' && (p.operationId === undefined || p.stepSequence === undefined)) fail()
  return { hostId: text(p.hostId, true), browserId: text(p.browserId, true), navigationId: navigation(p.navigationId),
    ...(p.operationId === undefined ? {} : { operationId: text(p.operationId, true) }),
    ...(p.stepSequence === undefined ? {} : { stepSequence: count(p.stepSequence, true) }),
    association: p.association as BrowserInputSelectionSource['association'], ...(end ? { observedAt: count(p.observedAt) } : {}) }
}
function rectangle(value: unknown, region = false) {
  const p = object(value, ['x', 'y', 'width', 'height', ...(region ? ['space'] : [])])
  if (region && p.space !== 'capture-pixels') fail()
  return { x: finite(p.x), y: finite(p.y), width: finite(p.width, true), height: finite(p.height, true) }
}
export function parseBrowserInputContextSource(value: unknown): BrowserInputContextSource {
  if (value !== 'caller-declared' && value !== 'host-capture') fail()
  return value as BrowserInputContextSource
}
/** Strict, renderer-safe pure-data decoding shared by SDK, journal and the readable protocol. */
export function parseBrowserInputContext(value: unknown): BrowserInputContext {
  const p = object(value, ['kind', 'version', 'capturedAt', 'browser', 'page', 'activity', 'selection'])
  if (p.kind !== 'browser' || p.version !== 1) fail()
  const browser = object(p.browser, ['hostId', 'browserId', 'navigationId']), page = object(p.page, ['url', 'title'])
  const result: BrowserInputContext = { kind: 'browser', version: 1, capturedAt: count(p.capturedAt),
    browser: { hostId: text(browser.hostId, true), browserId: text(browser.browserId, true), navigationId: navigation(browser.navigationId) },
    page: { url: text(page.url), ...(page.title === undefined ? {} : { title: text(page.title) }) } }
  if (p.activity !== undefined) {
    const a = object(p.activity, ['operationId', 'stepSequence', 'phase', 'observedAt'])
    result.activity = { operationId: text(a.operationId, true), stepSequence: a.stepSequence === null ? null : count(a.stepSequence, true), phase: text(a.phase, true), observedAt: count(a.observedAt) }
  }
  if (p.selection !== undefined) {
    const s = object(p.selection, ['kind', 'capturedAt', 'source', 'observationEnd', 'frameId', 'attachment', 'viewport', 'crop', 'region', 'element'])
    if (s.kind !== 'region' && s.kind !== 'element') fail()
    const selection: BrowserInputSelection = { kind: s.kind as BrowserInputSelection['kind'], capturedAt: count(s.capturedAt), source: source(s.source) }
    if (s.observationEnd !== undefined) selection.observationEnd = source(s.observationEnd, true) as NonNullable<BrowserInputSelection['observationEnd']>
    if (s.frameId !== undefined) selection.frameId = text(s.frameId, true)
    if (s.attachment !== undefined) {
      const a = object(s.attachment, ['hostId', 'path', 'mimeType', 'width', 'height', 'sha256'])
      if (a.mimeType !== 'image/png' || typeof a.path !== 'string' || /^(?:data|blob):/iu.test(a.path) || a.sha256 !== undefined && (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(a.sha256))) fail()
      selection.attachment = { hostId: text(a.hostId, true), path: text(a.path, true), mimeType: 'image/png', width: count(a.width, true), height: count(a.height, true), ...(a.sha256 === undefined ? {} : { sha256: a.sha256 as string }) }
    }
    if (s.viewport !== undefined) {
      const v = object(s.viewport, ['width', 'height', 'deviceScaleFactor'])
      selection.viewport = { width: finite(v.width, true), height: finite(v.height, true), deviceScaleFactor: v.deviceScaleFactor === null ? null : finite(v.deviceScaleFactor, true) }
    }
    if (s.crop !== undefined) selection.crop = rectangle(s.crop)
    if (s.region !== undefined) selection.region = { ...rectangle(s.region, true), space: 'capture-pixels' }
    if (s.element !== undefined) {
      const e = object(s.element, ['tagName', 'role', 'accessibleName', 'selector', 'text', 'nearbyText', 'attributes', 'html'])
      if (!Array.isArray(e.nearbyText)) fail()
      const attrs = e.attributes
      if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) fail()
      selection.element = { tagName: text(e.tagName), role: text(e.role), accessibleName: text(e.accessibleName), selector: text(e.selector), text: text(e.text),
        nearbyText: (e.nearbyText as unknown[]).map(value => text(value)), attributes: Object.fromEntries(Object.entries(attrs as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [text(key), text(value)])), html: text(e.html) }
    }
    result.selection = selection
  }
  return result
}
export function browserInputContextJson(context: BrowserInputContext): string {
  return JSON.stringify(parseBrowserInputContext(context)).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026')
}
/** Original producer metadata. No text parsing or implied human attribution. */
export function browserInputContextFields(value: { inputContext?: unknown; inputContextSource?: unknown }): {
  inputContext?: BrowserInputContext; inputContextSource?: BrowserInputContextSource
} {
  if (value.inputContext === undefined) {
    if (value.inputContextSource !== undefined) fail()
    return {}
  }
  return { inputContext: parseBrowserInputContext(value.inputContext),
    ...(value.inputContextSource === undefined ? {} : { inputContextSource: parseBrowserInputContextSource(value.inputContextSource) }) }
}

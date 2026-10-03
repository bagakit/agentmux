import { isLocalNetworkHost } from '@agentmux/relay/offer'
import type { PromptAttempt, ResponseAttempt } from '../conversation/local-drafts'

export const DEVICE_WORKFACE_KEY = 'agentmux-mobile-workface-v1'
export type MobilePanel = 'conversation' | 'sessions' | 'terminal'
export type Navigation = { selectedSessionId: string | null; hostUrl: string; panel: MobilePanel }
export type DraftRecord = { version: 1; drafts: Array<[string, string]>;
  attempts: Array<[string, Omit<PromptAttempt, 'message'>]>;
  responses: Array<[string, Pick<ResponseAttempt, 'phase'>]> }
export type GoalWorkSelection = { runtimeId: string; deviceHostId: string | null; sessionId: string; goalId: string }
export type MobileGoalOperation = GoalWorkSelection & { operationId: string } & (
  | { kind: 'start'; intervalMs: number; alignmentRevision: number }
  | { kind: 'action'; loopId: string; action: 'pause' | 'resume' | 'stop' | 'check'; expectedRevision: number }
)
export type GoalWorkface = { selection: GoalWorkSelection | null; pending: MobileGoalOperation[] }
function sameGoalOperation(a: MobileGoalOperation, b: MobileGoalOperation): boolean {
  const keys = Object.keys(a) as Array<keyof MobileGoalOperation>
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}
export type DeviceWorkface = Navigation & { version: 1;
  host: { origin: string; hostId: string } | null; conversation: DraftRecord; goalWork?: GoalWorkface }
type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>
type StorageGetter = () => DeviceStorage
const defaultStorage: StorageGetter = () => localStorage
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 256
export class DeviceHostMismatchError extends Error {}

export function emptyDeviceWorkface(): DeviceWorkface {
  return { version: 1, selectedSessionId: null, hostUrl: '', panel: 'conversation', host: null,
    conversation: { version: 1, drafts: [], attempts: [], responses: [] } }
}
function invalid(): Error { return new Error('设备工作面记录无法完整核实；原记录与当前阅读仍保留。') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
function phase(value: unknown): value is PromptAttempt['phase'] {
  return value === 'sending' || value === 'unknown' || value === 'rejected' || value === 'confirmed'
}
function entries(value: unknown): Array<[string, unknown]> {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid()
  const found = new Set<string>()
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !id(item[0]) || found.has(item[0])) throw invalid()
    found.add(item[0])
  }
  return value
}
function body(value: unknown): value is string { return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 65536 }
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname)) && url.origin === value
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' } catch { return false }
}
export function parseDraftRecord(value: unknown): DraftRecord {
  const v = record(value, ['version', 'drafts', 'attempts', 'responses'])
  if (v.version !== 1) throw invalid()
  const drafts = entries(v.drafts), attempts = entries(v.attempts), responses = entries(v.responses)
  for (const [, draft] of drafts) if (!body(draft)) throw invalid()
  for (const [, item] of attempts) {
    const attempt = record(item, ['operationId', 'runId', 'draft', 'phase'])
    if (!id(attempt.operationId) || !(attempt.runId === null || id(attempt.runId))
      || !body(attempt.draft) || !phase(attempt.phase)) throw invalid()
  }
  for (const [, item] of responses) if (!phase(record(item, ['phase']).phase)) throw invalid()
  return structuredClone(value) as DraftRecord
}
export function parseDeviceWorkface(value: unknown): DeviceWorkface {
  const keys = ['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation']
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalWork')) keys.push('goalWork')
  const v = record(value, keys)
  if (v.version !== 1 || !(v.selectedSessionId === null || id(v.selectedSessionId))
    || !(v.hostUrl === '' || origin(v.hostUrl))
    || !(v.panel === 'conversation' || v.panel === 'sessions' || v.panel === 'terminal')) throw invalid()
  if (v.host !== null) {
    const host = record(v.host, ['origin', 'hostId'])
    if (!origin(host.origin) || !id(host.hostId)) throw invalid()
  }
  parseDraftRecord(v.conversation)
  if (Object.hasOwn(v, 'goalWork')) parseGoalWorkface(v.goalWork)
  return structuredClone(value) as DeviceWorkface
}

function selection(value: unknown): GoalWorkSelection {
  const v = record(value, ['runtimeId', 'deviceHostId', 'sessionId', 'goalId'])
  if (!id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId)) || !id(v.sessionId) || !id(v.goalId)) throw invalid()
  return structuredClone(value) as GoalWorkSelection
}
export function parseGoalWorkface(value: unknown): GoalWorkface {
  const v = record(value, ['selection', 'pending'])
  if (v.selection !== null) selection(v.selection)
  if (!Array.isArray(v.pending) || v.pending.length > MAX_ENTRIES) throw invalid()
  const found = new Set<string>()
  for (const item of v.pending) {
    const keys = ['runtimeId', 'deviceHostId', 'sessionId', 'goalId', 'operationId', 'kind']
    const op = record(item, [...keys, ...(item?.kind === 'start' ? ['intervalMs', 'alignmentRevision'] : ['loopId', 'action', 'expectedRevision'])])
    selection({ runtimeId: op.runtimeId, deviceHostId: op.deviceHostId, sessionId: op.sessionId, goalId: op.goalId })
    if (!id(op.operationId) || found.has(op.operationId)) throw invalid()
    found.add(op.operationId)
    if (op.kind === 'start') {
      if (!Number.isSafeInteger(op.intervalMs) || Number(op.intervalMs) < 60000 || !Number.isSafeInteger(op.alignmentRevision) || Number(op.alignmentRevision) < 1) throw invalid()
    } else if (op.kind !== 'action' || !id(op.loopId) || !['pause', 'resume', 'stop', 'check'].includes(String(op.action))
      || !Number.isSafeInteger(op.expectedRevision) || Number(op.expectedRevision) < 1) throw invalid()
  }
  return structuredClone(value) as GoalWorkface
}

/** One device record owns navigation, drafts and intent guards. A single setItem is the commit. */
export class DeviceWorkfaceStore {
  private value = emptyDeviceWorkface()
  private lastRaw: string | null | undefined
  private issue: string | null = null
  private temporary = false
  constructor(private readonly storage: () => DeviceStorage) { this.refresh() }
  private refresh(): void {
    try {
      const raw = this.storage().getItem(DEVICE_WORKFACE_KEY)
      if (raw === this.lastRaw) return
      this.lastRaw = raw
      if (this.temporary) {
        this.issue = '设备存储已可读取或原记录已变化；当前临时工作面仍保留，尚未覆盖原字节。请先导出需要保留的内容，再明确采用当前工作面或导入备份。'
        return
      }
      if (raw !== null && new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw invalid()
      this.value = raw === null ? emptyDeviceWorkface() : parseDeviceWorkface(JSON.parse(raw))
      this.issue = null
    } catch { this.issue = '这台设备的工作面记录暂时无法读取。原记录尚未覆盖，当前阅读和草稿保留；请恢复原记录或导入已保全的工作面。' }
  }
  snapshot(): { record: DeviceWorkface; issue: string | null } {
    this.refresh(); return { record: structuredClone(this.value), issue: this.issue }
  }
  private save(): void {
    const bytes = JSON.stringify(this.value)
    if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw invalid()
    this.storage().setItem(DEVICE_WORKFACE_KEY, bytes)
    this.lastRaw = bytes; this.issue = null; this.temporary = false
  }
  private update(value: DeviceWorkface): void {
    // Keep the current in-memory workface even when durable saving is unavailable.
    this.value = parseDeviceWorkface(value)
    this.temporary = true
    if (this.issue) throw new Error(this.issue)
    this.save()
  }
  updateNavigation(navigation: Navigation): void {
    this.refresh(); this.update({ ...this.value, ...navigation })
  }
  updateConversation(conversation: DraftRecord): void {
    this.refresh(); this.update({ ...this.value, conversation: parseDraftRecord(conversation) })
  }
  selectGoal(next: GoalWorkSelection | null): void {
    this.refresh(); this.update({ ...this.value, goalWork: { selection: next === null ? null : selection(next), pending: this.value.goalWork?.pending ?? [] } })
  }
  retainGoalOperation(operation: MobileGoalOperation): void {
    this.refresh()
    const current = this.value.goalWork ?? { selection: null, pending: [] }
    const existing = current.pending.find(op => op.operationId === operation.operationId)
    if (existing && !sameGoalOperation(existing, operation)) throw new Error('原目标操作的内容不同；保留原操作，不能换目标重试。')
    if (!existing && current.pending.some(op => op.runtimeId === operation.runtimeId && op.sessionId === operation.sessionId && op.goalId === operation.goalId
      && (op.deviceHostId === null || operation.deviceHostId === null || op.deviceHostId === operation.deviceHostId))) throw new Error('这个原目标已有待确认操作；请先检查并重试原操作，不替换为新的操作。')
    const pending = existing ? current.pending : [...current.pending, operation]
    this.update({ ...this.value, goalWork: parseGoalWorkface({ ...current, pending }) })
  }
  confirmGoalOperation(operation: MobileGoalOperation): void {
    this.refresh()
    const current = this.value.goalWork
    if (!current) return
    const existing = current.pending.find(op => op.operationId === operation.operationId)
    if (!existing || !sameGoalOperation(existing, operation)) return
    this.update({ ...this.value, goalWork: { ...current, pending: current.pending.filter(op => op !== existing) } })
  }
  confirmHost(host: NonNullable<DeviceWorkface['host']>): void {
    this.refresh()
    if (!origin(host.origin) || !id(host.hostId)) throw invalid()
    if (this.value.host && (this.value.host.hostId !== host.hostId)) {
      throw new DeviceHostMismatchError('当前 Mac 与已保全工作面的原 Host 身份不同。原会话、草稿和未确认输入仍保留；请接回原 Mac，或明确建立另一份设备工作面。')
    }
    this.update({ ...this.value, host: { ...host } })
  }
  exportBackup(): string {
    this.refresh()
    return JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: this.value }, null, 2)
  }
  parseBackup(bytes: string): DeviceWorkface {
    if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw invalid()
    const backup = record(JSON.parse(bytes), ['schema', 'workface'])
    if (backup.schema !== 'agentmux.mobile-workface.v1') throw invalid()
    return parseDeviceWorkface(backup.workface)
  }
  replaceBackup(next: DeviceWorkface): void {
    // Validate and persist before adopting: a failed import cannot replace the current workface.
    const parsed = parseDeviceWorkface(next), bytes = JSON.stringify(parsed)
    if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw invalid()
    this.storage().setItem(DEVICE_WORKFACE_KEY, bytes)
    this.value = parsed; this.lastRaw = bytes; this.issue = null; this.temporary = false
  }
  replaceUnreadableWithCurrent(navigation?: Navigation): void {
    if (navigation) this.value = parseDeviceWorkface({ ...this.value, ...navigation })
    this.save()
  }
}

const stores = new WeakMap<object, DeviceWorkfaceStore>()
const getterStores = new WeakMap<StorageGetter, DeviceWorkfaceStore>()
export function getDeviceWorkface(storage: StorageGetter = defaultStorage): DeviceWorkfaceStore {
  const known = getterStores.get(storage)
  if (known) return known
  let target: DeviceStorage
  try { target = storage() } catch {
    const owner = new DeviceWorkfaceStore(storage)
    getterStores.set(storage, owner)
    return owner
  }
  let owner = stores.get(target)
  if (!owner) { owner = new DeviceWorkfaceStore(storage); stores.set(target, owner) }
  getterStores.set(storage, owner)
  return owner
}

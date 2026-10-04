import { validateDeliveryLogId } from '@agentmux/core/delivery-attempt'
import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
import { isLocalNetworkHost } from '@agentmux/relay/offer'
import type { PromptAttempt, ResponseAttempt } from '../conversation/local-drafts'
import { parseMobileFileUpload, type MobileFileUpload } from '../conversation/attachments'

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
export type GoalIntentScope = Pick<GoalWorkSelection, 'runtimeId' | 'deviceHostId'>
export type GoalCreationInput = { goalId: string; operationId: string; title: string; description: string; status: 'backlog'; risk: 'low'; confirmation: 'user'; projectId?: string }
export type GoalIntent = GoalIntentScope & { goalId: string; operationId: string; phase: 'sending' | 'unknown' | 'saved' } & (
  | { kind: 'create'; input: GoalCreationInput }
  | { kind: 'confirm'; expectedRevision: number }
  | { kind: 'accept'; expectedAlignmentRevision: number; expectedSubmissionId: string; acceptGaps: boolean }
)
export function sameGoalIntentScope(a: GoalIntentScope, b: GoalIntentScope): boolean {
  return a.runtimeId === b.runtimeId && a.deviceHostId === b.deviceHostId
}
function sameGoalIntent(a: GoalIntent, b: GoalIntent): boolean {
  if (!sameGoalIntentScope(a, b) || a.goalId !== b.goalId || a.operationId !== b.operationId) return false
  if (a.kind === 'create' && b.kind === 'create') {
    const keys = Object.keys(a.input) as Array<keyof GoalCreationInput>
    return keys.length === Object.keys(b.input).length && keys.every(key => a.input[key] === b.input[key])
  }
  if (a.kind === 'confirm' && b.kind === 'confirm') return a.expectedRevision === b.expectedRevision
  return a.kind === 'accept' && b.kind === 'accept' && a.expectedAlignmentRevision === b.expectedAlignmentRevision && a.expectedSubmissionId === b.expectedSubmissionId && a.acceptGaps === b.acceptGaps
}
function sameGoalOperation(a: MobileGoalOperation, b: MobileGoalOperation): boolean {
  const keys = Object.keys(a) as Array<keyof MobileGoalOperation>
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}
export type DeviceWorkface = Navigation & { version: 1;
  host: { origin: string; hostId: string } | null; conversation: DraftRecord; goalWork?: GoalWorkface; goalIntents?: GoalIntent[]; fileUploads?: MobileFileUpload[] }
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
    const keys = ['operationId', 'runId', 'draft', 'phase']
    if (item && typeof item === 'object' && Object.hasOwn(item, 'request')) keys.push('request')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'logId')) keys.push('logId')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'inputRequested')) keys.push('inputRequested')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'originalRuntimeId')) keys.push('originalRuntimeId')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'explicit')) keys.push('explicit')
    const attempt = record(item, keys)
    if (!id(attempt.operationId) || !(attempt.runId === null || id(attempt.runId))
      || !body(attempt.draft) || !phase(attempt.phase)) throw invalid()
    if (attempt.logId !== undefined) validateDeliveryLogId(attempt.logId)
    if (attempt.inputRequested !== undefined && typeof attempt.inputRequested !== 'boolean') throw invalid()
    if (attempt.explicit !== undefined && typeof attempt.explicit !== 'boolean') throw invalid()
    if (attempt.originalRuntimeId !== undefined && !(attempt.originalRuntimeId === null || id(attempt.originalRuntimeId))) throw invalid()
    if (attempt.request !== undefined) {
      const r = record(attempt.request, ['condition', 'execution', 'explicit', 'runtimeId'])
      const c = record(r.condition, ['expectedRun', 'afterSubmissionId'])
      record(c.expectedRun, ['runId'])
      const condition = validateAgentPromptCondition(c)
      if (!id(condition.expectedRun.runId) || condition.expectedRun.runId !== attempt.runId ||
          !(condition.afterSubmissionId === null || id(condition.afterSubmissionId)) ||
          !['default', 'immediate'].includes(r.execution as string) || typeof r.explicit !== 'boolean' ||
          !(r.runtimeId === null || id(r.runtimeId))) throw invalid()
    }
  }
  for (const [, item] of responses) if (!phase(record(item, ['phase']).phase)) throw invalid()
  return structuredClone(value) as DraftRecord
}
export function parseDeviceWorkface(value: unknown): DeviceWorkface {
  const keys = ['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation']
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalWork')) keys.push('goalWork')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalIntents')) keys.push('goalIntents')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'fileUploads')) keys.push('fileUploads')
  const v = record(value, keys)
  if (v.version !== 1 || !(v.selectedSessionId === null || id(v.selectedSessionId))
    || !(v.hostUrl === '' || origin(v.hostUrl))
    || !(v.panel === 'conversation' || v.panel === 'sessions' || v.panel === 'terminal')) throw invalid()
  if (v.host !== null) {
    const host = record(v.host, ['origin', 'hostId'])
    if (!origin(host.origin) || !id(host.hostId)) throw invalid()
  }
  parseDraftRecord(v.conversation)
  if (v.fileUploads !== undefined) {
    if (!Array.isArray(v.fileUploads) || v.fileUploads.length > MAX_ENTRIES) throw invalid()
    const found = new Set<string>()
    for (const upload of v.fileUploads) {
      const parsed = parseMobileFileUpload(upload)
      if (found.has(parsed.identity.operationId)) throw invalid()
      found.add(parsed.identity.operationId)
    }
  }
  if (Object.hasOwn(v, 'goalWork')) parseGoalWorkface(v.goalWork)
  if (Object.hasOwn(v, 'goalIntents')) {
    if (!Array.isArray(v.goalIntents)) throw invalid()
    const found = new Set<string>()
    for (const intent of v.goalIntents) {
      parseGoalIntent(intent)
      if (found.has(intent.operationId)) throw invalid()
      found.add(intent.operationId)
    }
  }
  return structuredClone(value) as DeviceWorkface
}

function parseGoalIntent(value: unknown): GoalIntent {
  const kind = (value as GoalIntent)?.kind
  const v = record(value, ['runtimeId', 'deviceHostId', 'goalId', 'operationId', 'phase', 'kind', ...(kind === 'create' ? ['input'] : kind === 'confirm' ? ['expectedRevision'] : ['expectedAlignmentRevision', 'expectedSubmissionId', 'acceptGaps'])])
  if (!id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId)) || !id(v.goalId) || !id(v.operationId) || !['sending', 'unknown', 'saved'].includes(String(v.phase))) throw invalid()
  if (kind === 'create') {
    const input = record(v.input, ['goalId', 'operationId', 'title', 'description', 'status', 'risk', 'confirmation', ...(Object.hasOwn(v.input ?? {}, 'projectId') ? ['projectId'] : [])])
    if (input.goalId !== v.goalId || input.operationId !== v.operationId || !body(input.title) || !input.title || !body(input.description) || input.status !== 'backlog' || input.risk !== 'low' || input.confirmation !== 'user' || input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId)) throw invalid()
  } else if (kind === 'confirm') {
    if (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1 || v.phase === 'saved') throw invalid()
  } else if (kind !== 'accept' || !Number.isSafeInteger(v.expectedAlignmentRevision) || Number(v.expectedAlignmentRevision) < 1 || !id(v.expectedSubmissionId) || typeof v.acceptGaps !== 'boolean' || v.phase === 'saved') throw invalid()
  return structuredClone(value) as GoalIntent
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
  private goalIntentFlights = new Set<string>()
  private goalIntentListeners = new Set<() => void>()
  private goalIntentVersion = 0
  subscribeGoalIntents = (listener: () => void): (() => void) => { this.goalIntentListeners.add(listener); return () => this.goalIntentListeners.delete(listener) }
  goalIntentRevision = (): number => this.goalIntentVersion
  private notifyGoalIntents(): void { this.goalIntentVersion += 1; for (const listener of this.goalIntentListeners) listener() }
  goalIntentRunning(operationId: string): boolean { return this.goalIntentFlights.has(operationId) }
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
  retainFileUpload(value: MobileFileUpload): void {
    this.refresh()
    const upload = parseMobileFileUpload(value), current = this.value.fileUploads ?? []
    const previous = current.find(item => item.identity.operationId === upload.identity.operationId)
    if (previous && (previous.runtimeId !== upload.runtimeId || JSON.stringify(previous.identity) !== JSON.stringify(upload.identity))) throw new Error('原附件的目标或内容不同；保留原记录，不覆盖或换目标。')
    this.update({ ...this.value, fileUploads: previous ? current.map(item => item === previous ? upload : item) : [...current, upload] })
  }
  removeFileUpload(operationId: string): void {
    this.refresh()
    const current = this.value.fileUploads ?? []
    const original = current.find(item => item.identity.operationId === operationId)
    if (original?.phase === 'sending' || original?.phase === 'unknown') throw new Error('原上传回执尚未确认；记录保留，可核对原操作。')
    this.update({ ...this.value, fileUploads: current.filter(item => item !== original) })
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
  private updateGoalIntents(intents: GoalIntent[]): void {
    // Schema/identity remain strict. Device I/O cannot gate an authorized healthy Goal owner.
    this.value = parseDeviceWorkface({ ...this.value, goalIntents: intents })
    this.temporary = true
    try { if (this.issue) throw new Error(this.issue); this.save() }
    catch { this.issue = '设备意图尚未持久保存；原字节和当前内存记录保留，原 Goal 操作仍可继续。刷新保障不足，请在设备工作面中导出备份，存储恢复后明确采用当前工作面。' }
    this.notifyGoalIntents()
  }
  retainGoalIntent(intent: GoalIntent): void {
    this.refresh()
    const value = parseGoalIntent(intent), current = this.value.goalIntents ?? []
    const existing = current.find(item => item.operationId === value.operationId)
    if (existing || current.some(item => sameGoalIntentScope(item, value) && (value.kind === 'create' ? item.kind === 'create' : item.kind !== 'create' && item.goalId === value.goalId))) throw new Error('原 Goal 已有待核对的操作意图；先读原目标，不替换或重复提交。')
    this.updateGoalIntents([...current, value])
    this.goalIntentFlights.add(value.operationId)
  }
  releaseGoalIntent(intent: GoalIntent): void { this.goalIntentFlights.delete(intent.operationId); this.notifyGoalIntents() }
  settleGoalIntent(intent: GoalIntent, phase: 'unknown' | 'saved' | 'confirmed'): void {
    this.refresh()
    const current = this.value.goalIntents ?? [], existing = current.find(item => item.operationId === intent.operationId)
    if (!existing || !sameGoalIntent(existing, intent)) return
    if (this.goalIntentRunning(intent.operationId)) throw new Error('原操作仍在等待回执，当前读取不能代签它。')
    const next = phase === 'confirmed' ? current.filter(item => item !== existing) : current.map(item => item === existing ? { ...item, phase } : item)
    this.updateGoalIntents(next)
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
    this.notifyGoalIntents()
  }
  replaceUnreadableWithCurrent(navigation?: Navigation): void {
    if (navigation) this.value = parseDeviceWorkface({ ...this.value, ...navigation })
    this.save()
    this.notifyGoalIntents()
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

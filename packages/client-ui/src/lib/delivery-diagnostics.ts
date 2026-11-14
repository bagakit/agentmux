import { newDeliveryLogId, deliveryFailure, parseDeliveryAttempt, parseDeliveryAttemptLookup,
  type DeliveryAttempt, type DeliveryAttemptLookup } from '@agentmux/core/delivery-attempt'
import type { AgentPromptCondition } from '@agentmux/core/prompt-condition'

export type ClientDeliveryLog = {
  record: DeliveryAttempt
  /** Original service identity. It is never inferred from a newly selected Session. */
  owner: string | null
  localSaved: boolean
  localIssue: string | null
  notificationIssue: string | null
  remote: DeliveryAttemptLookup | null
  reportIssue: string | null
}
export type DeliveryAttemptSeed = { logId: string; startedAt: number; agentSessionId: string | null;
  operationId: string | null; hostId: string | null; expectedRunId: string | null;
  afterSubmissionId: string | null; conditionAvailable: boolean; execution: 'default' | 'immediate' | null;
  /** Optional observation only; reading it never waits for hashing. */
  digest: () => string | null }

/** Freeze one click before any await. Diagnostic identity never replaces Input identity. */
export function startDeliveryAttempt(input: { agentSessionId: string | null; operationId: string | null;
  hostId: string | null; condition?: AgentPromptCondition | null | undefined; expectedRun?: AgentPromptCondition['expectedRun'] | undefined;
  execution?: 'default' | 'immediate'; prompt?: string }): DeliveryAttemptSeed {
  const bytes = input.prompt === undefined ? null : new TextEncoder().encode(input.prompt)
  let observedDigest: string | null = null
  try {
    if (bytes !== null && crypto.subtle) void crypto.subtle.digest('SHA-256', bytes)
      .then(value => { observedDigest = Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('') }).catch(() => {})
  } catch { /* Optional hashing cannot prevent a click or its failure record. */ }
  const digest = () => observedDigest
  return Object.freeze({ logId: newDeliveryLogId(), startedAt: Date.now(),
    agentSessionId: input.agentSessionId, operationId: input.operationId, hostId: input.hostId,
    expectedRunId: input.expectedRun?.runId ?? input.condition?.expectedRun.runId ?? null, afterSubmissionId: input.condition?.afterSubmissionId ?? null,
    conditionAvailable: input.condition !== undefined && input.condition !== null, execution: input.execution ?? null, digest })
}
const PREFIX = 'agentmux.delivery-attempt.'
const SLOT_PREFIX = PREFIX + 'recent.'
const RECENT_LIMIT = 32
const MAX_SLOT_CHARS = 32 * 1024
const REPORT_LIMIT = 4
const TRANSPORT_LIMIT = 8
type DiagnosticStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
type Slot = { logId: string; failedAt: number } | null | undefined

/** Failed-click journal only. Reconnection reports diagnostics, never resubmits Input. */
export class ClientDeliveryDiagnostics {
  private readonly logs = new Map<string, ClientDeliveryLog>()
  private readonly reporting = new Map<string, Promise<void>>()
  private readonly slots: Slot[] = Array.from({ length: RECENT_LIMIT }, () => null)
  private transportOutstanding = 0
  private readonly listeners = new Set<() => void>()
  constructor(private readonly storage: () => DiagnosticStorage = () => localStorage) {
    try {
      const store = storage()
      for (let index = 0; index < RECENT_LIMIT; index++) {
        const key = SLOT_PREFIX + index
        const raw = store.getItem(key)
        const entry = this.readStored(raw, key)
        this.slots[index] = entry ? { logId: entry.record.logId, failedAt: entry.record.failedAt } : raw === null ? null : undefined
        if (entry) this.logs.set(entry.record.logId, entry)
      }
      // Already-retained legacy records remain individually readable. Only
      // the recent original backlog is eligible for automatic reporting.
      for (let index = store.length - 1, examined = 0; index >= 0 && examined < RECENT_LIMIT && this.logs.size < RECENT_LIMIT; index--, examined++) {
        const key = store.key(index)
        if (!key?.startsWith(PREFIX) || key.startsWith(SLOT_PREFIX)) continue
        const entry = this.readStored(store.getItem(key), key)
        if (entry && !this.logs.has(entry.record.logId)) this.logs.set(entry.record.logId, entry)
      }
      this.logs = new Map([...this.logs].sort(([, a], [, b]) => a.record.failedAt - b.record.failedAt))
    } catch { /* Failure records below explicitly disclose memory-only retention. */ }
  }

  private readStored(raw: string | null, key: string): ClientDeliveryLog | undefined {
    try {
      if (raw === null) return
      const saved = JSON.parse(raw) as ClientDeliveryLog
      const record = parseDeliveryAttempt(saved.record)
      if ((!key.startsWith(SLOT_PREFIX) && key !== PREFIX + record.logId) || record.source !== 'client' ||
        !(saved.owner === null || typeof saved.owner === 'string') || saved.owner && saved.owner.length > 4096) return
      const remote = saved.remote === null ? null : parseDeliveryAttemptLookup(saved.remote, record.logId)
      return { record, owner: saved.owner, localSaved: true, remote,
        localIssue: null, notificationIssue: typeof saved.notificationIssue === 'string' ? saved.notificationIssue : null,
        reportIssue: typeof saved.reportIssue === 'string' ? saved.reportIssue : null }
    } catch { /* Preserve unrecognized stored bytes until rotation of an identified recent slot. */ }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(logId: string): ClientDeliveryLog | undefined {
    const entry = this.logs.get(logId)
    if (entry) return structuredClone(entry)
    try {
      const key = PREFIX + logId
      return this.readStored(this.storage().getItem(key), key)
    } catch { return }
  }
  async failed(seed: DeliveryAttemptSeed, error: unknown, stage: string, owner: string | null): Promise<ClientDeliveryLog> {
    const existing = this.get(seed.logId)
    if (existing) return existing
    const failedAt = Date.now(), failure = deliveryFailure(error)
    const { digest, ...facts } = seed
    const record: DeliveryAttempt = { ...facts, source: 'client', promptDigest: digest(),
      failedAt, stage, error: failure, ...(failure.logId ? { coreLogId: failure.logId } : {}) }
    parseDeliveryAttempt(record)
    const entry: ClientDeliveryLog = { record, owner, localSaved: false, localIssue: null, notificationIssue: null, remote: null, reportIssue: null }
    if (this.logs.size >= RECENT_LIMIT) this.logs.delete(this.logs.keys().next().value!)
    this.logs.set(record.logId, entry); this.save(entry); this.changed(entry)
    return structuredClone(entry)
  }
  /** Caller supplies the exact original receiving owner and its authenticated transport. */
  async sync(owner: string, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    const work: Promise<void>[] = []
    for (const entry of [...this.logs.values()].reverse()) {
      if (entry.owner !== owner || entry.remote?.persistence === 'confirmed' && entry.localSaved) continue
      const active = this.reporting.get(entry.record.logId)
      if (active) { work.push(active); continue }
      if (this.reporting.size >= REPORT_LIMIT) continue
      if (entry.remote?.persistence === 'confirmed') { this.save(entry); this.changed(entry) }
      else if (this.transportOutstanding < TRANSPORT_LIMIT) work.push(this.report(entry, report))
    }
    await Promise.all(work)
  }
  private async report(entry: ClientDeliveryLog, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    this.transportOutstanding++
    const transport = Promise.resolve().then(() => report(structuredClone(entry.record))).finally(() => { this.transportOutstanding-- })
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A timed-out report may still publish this same immutable record on its Host.
        // Only this observation ends; Input is never retried and late results stay outside this attempt.
        const returned = await Promise.race([transport,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(
            'Diagnostic report is still pending; retry reporting the original log ID. No Input was replayed.')), 500) })])
        const result = parseDeliveryAttemptLookup(returned, entry.record.logId)
        if (result.record && canonical({ ...result.record, reporter: undefined }) !== canonical(entry.record)) {
          throw new Error('The diagnostic service returned different original failure facts.')
        }
        entry.remote = result; entry.reportIssue = result.issue
      } catch (error) { entry.reportIssue = diagnosticIssue(error) }
      finally { clearTimeout(timer) }
      if (this.logs.get(entry.record.logId) === entry) { this.save(entry); this.changed(entry) }
    })()
    this.reporting.set(entry.record.logId, pending)
    try { await pending } finally { if (this.reporting.get(entry.record.logId) === pending) this.reporting.delete(entry.record.logId) }
  }
  private save(entry: ClientDeliveryLog): void {
    try {
      const store = this.storage()
      const bytes = JSON.stringify({ ...entry, localSaved: true, localIssue: null })
      if (bytes.length > MAX_SLOT_CHARS) throw new Error('The diagnostic exceeds the local record budget.')
      const legacyKey = PREFIX + entry.record.logId
      if (this.readStored(store.getItem(legacyKey), legacyKey)) store.setItem(legacyKey, bytes)
      else this.saveRecent(store, entry.record, bytes)
      entry.localSaved = true; entry.localIssue = null
    } catch (error) { entry.localSaved = false; entry.localIssue = diagnosticIssue(error) }
  }

  private saveRecent(store: DiagnosticStorage, record: DeliveryAttempt, bytes: string): void {
    for (let attempt = 0; attempt < RECENT_LIMIT; attempt++) {
      let index = this.slots.findIndex(value => value?.logId === record.logId)
      if (index < 0) index = this.slots.findIndex(value => value === null)
      if (index < 0) {
        for (let slot = 0; slot < this.slots.length; slot++) {
          const entry = this.slots[slot]
          if (entry && (index < 0 || entry.failedAt < this.slots[index]!.failedAt)) index = slot
        }
      }
      if (index < 0) break
      const key = SLOT_PREFIX + index, raw = store.getItem(key), previous = this.readStored(raw, key)
      const head = this.slots[index]
      const current = previous ? { logId: previous.record.logId, failedAt: previous.record.failedAt } : raw === null ? null : undefined
      if (current?.logId !== head?.logId || (!current || !head) && current !== head) {
        this.slots[index] = current
        continue
      }
      store.setItem(key, bytes)
      this.slots[index] = { logId: record.logId, failedAt: record.failedAt }
      return
    }
    throw new Error('No diagnostic slot could be confirmed.')
  }
  private changed(entry: ClientDeliveryLog): void {
    for (const listener of this.listeners) {
      try { listener() } catch (error) { entry.notificationIssue ??= diagnosticIssue(error) }
    }
  }
}
export function deliveryLogNotice(entry: ClientDeliveryLog): string {
  const issue = `${entry.localIssue ? `；本机日志保存失败：${entry.localIssue}` : ''}${entry.notificationIssue ? `；诊断通知失败：${entry.notificationIssue}` : ''}`
  if (entry.remote?.availability === 'found' && entry.remote.persistence === 'confirmed') return '日志已保存到原 Host，可用 logid 查询' + issue
  if (entry.remote?.availability === 'found') return `原 Host 当前可查询；日志持久保存未确认${entry.remote.issue ? `：${entry.remote.issue}` : ''}` + issue
  if (entry.owner === null) return `${entry.localSaved ? '日志已在本机保留' : '日志仅在当前页面内存中保留'}；原诊断 Host 未核实，暂不能远端查询` + issue
  return `${entry.localSaved ? '日志已在本机保留，等待上传到原 Host' : '日志仅在当前页面内存中保留，持久保存和上传未确认'}${entry.reportIssue ? `：${entry.reportIssue}` : ''}` + issue
}

function diagnosticIssue(error: unknown): string {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return `${error instanceof Error ? error.message : String(error)}${typeof code === 'string' ? ` [${code}]` : ''}`.slice(0, 1024)
  } catch { return 'Diagnostic failure details are unavailable.' }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}

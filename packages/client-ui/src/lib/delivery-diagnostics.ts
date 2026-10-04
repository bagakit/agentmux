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
  hostId: string | null; condition?: AgentPromptCondition | null | undefined; execution?: 'default' | 'immediate'; prompt?: string }): DeliveryAttemptSeed {
  const bytes = input.prompt === undefined ? null : new TextEncoder().encode(input.prompt)
  let observedDigest: string | null = null
  try {
    if (bytes !== null && crypto.subtle) void crypto.subtle.digest('SHA-256', bytes)
      .then(value => { observedDigest = Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('') }).catch(() => {})
  } catch { /* Optional hashing cannot prevent a click or its failure record. */ }
  const digest = () => observedDigest
  return Object.freeze({ logId: newDeliveryLogId(), startedAt: Date.now(),
    agentSessionId: input.agentSessionId, operationId: input.operationId, hostId: input.hostId,
    expectedRunId: input.condition?.expectedRun.runId ?? null, afterSubmissionId: input.condition?.afterSubmissionId ?? null,
    conditionAvailable: input.condition !== undefined && input.condition !== null, execution: input.execution ?? null, digest })
}
const PREFIX = 'agentmux.delivery-attempt.'
type DiagnosticStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>

/** Failed-click journal only. Reconnection reports diagnostics, never resubmits Input. */
export class ClientDeliveryDiagnostics {
  private readonly logs = new Map<string, ClientDeliveryLog>()
  private readonly reporting = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly storage: () => DiagnosticStorage = () => localStorage) {
    try {
      const store = storage()
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index)
        if (!key?.startsWith(PREFIX)) continue
        try {
          const saved = JSON.parse(store.getItem(key) ?? '') as ClientDeliveryLog
          const record = parseDeliveryAttempt(saved.record)
          if (key !== PREFIX + record.logId || record.source !== 'client' ||
            !(saved.owner === null || typeof saved.owner === 'string') || saved.owner && saved.owner.length > 4096) continue
          const remote = saved.remote === null ? null : parseDeliveryAttemptLookup(saved.remote, record.logId)
          this.logs.set(record.logId, { record, owner: saved.owner, localSaved: true, remote,
            localIssue: null, notificationIssue: typeof saved.notificationIssue === 'string' ? saved.notificationIssue : null,
            reportIssue: typeof saved.reportIssue === 'string' ? saved.reportIssue : null })
        } catch { /* Keep the original storage bytes; an unreadable record is never overwritten. */ }
      }
    } catch { /* Failure records below explicitly disclose memory-only retention. */ }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(logId: string): ClientDeliveryLog | undefined { const entry = this.logs.get(logId); return entry ? structuredClone(entry) : undefined }
  async failed(seed: DeliveryAttemptSeed, error: unknown, stage: string, owner: string | null): Promise<ClientDeliveryLog> {
    const existing = this.logs.get(seed.logId)
    if (existing) return structuredClone(existing)
    const failedAt = Date.now(), failure = deliveryFailure(error)
    const { digest, ...facts } = seed
    const record: DeliveryAttempt = { ...facts, source: 'client', promptDigest: digest(),
      failedAt, stage, error: failure, ...(failure.logId ? { coreLogId: failure.logId } : {}) }
    parseDeliveryAttempt(record)
    const entry: ClientDeliveryLog = { record, owner, localSaved: false, localIssue: null, notificationIssue: null, remote: null, reportIssue: null }
    this.logs.set(record.logId, entry); this.save(entry); this.changed(entry)
    return structuredClone(entry)
  }
  /** Caller supplies the exact original receiving owner and its authenticated transport. */
  async sync(owner: string, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    await Promise.all([...this.logs.values()].filter(entry => entry.owner === owner &&
      (entry.remote?.persistence !== 'confirmed' || !entry.localSaved))
      .map(entry => entry.remote?.persistence === 'confirmed'
        ? (this.save(entry), this.changed(entry)) : this.report(entry, report)))
  }
  private async report(entry: ClientDeliveryLog, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    const active = this.reporting.get(entry.record.logId)
    if (active) return await active
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A timed-out report may still publish this same immutable record on its Host.
        // Only this observation ends; Input is never retried and late results stay outside this attempt.
        const returned = await Promise.race([Promise.resolve().then(() => report(structuredClone(entry.record))),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(
            'Diagnostic report is still pending; retry reporting the original log ID. No Input was replayed.')), 500) })])
        const result = parseDeliveryAttemptLookup(returned, entry.record.logId)
        if (result.record && canonical({ ...result.record, reporter: undefined }) !== canonical(entry.record)) {
          throw new Error('The diagnostic service returned different original failure facts.')
        }
        entry.remote = result; entry.reportIssue = result.issue
      } catch (error) { entry.reportIssue = diagnosticIssue(error) }
      finally { clearTimeout(timer) }
      this.save(entry); this.changed(entry)
    })()
    this.reporting.set(entry.record.logId, pending)
    try { await pending } finally { if (this.reporting.get(entry.record.logId) === pending) this.reporting.delete(entry.record.logId) }
  }
  private save(entry: ClientDeliveryLog): void {
    try {
      this.storage().setItem(PREFIX + entry.record.logId, JSON.stringify({ ...entry, localSaved: true, localIssue: null }))
      entry.localSaved = true; entry.localIssue = null
    } catch (error) { entry.localSaved = false; entry.localIssue = diagnosticIssue(error) }
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

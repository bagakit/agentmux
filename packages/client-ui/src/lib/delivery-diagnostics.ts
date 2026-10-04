import { newDeliveryLogId, deliveryFailure, parseDeliveryAttempt, parseDeliveryAttemptLookup,
  type DeliveryAttempt, type DeliveryAttemptLookup } from '@agentmux/core/delivery-attempt'
import type { AgentPromptCondition } from '@agentmux/core/prompt-condition'

export type ClientDeliveryLog = {
  record: DeliveryAttempt
  /** Original service identity. It is never inferred from a newly selected Session. */
  owner: string | null
  localSaved: boolean
  remote: DeliveryAttemptLookup | null
  reportIssue: string | null
}
export type DeliveryAttemptSeed = { logId: string; startedAt: number; agentSessionId: string | null;
  operationId: string | null; hostId: string | null; expectedRunId: string | null;
  afterSubmissionId: string | null; conditionAvailable: boolean; execution: 'default' | 'immediate' | null;
  digest: Promise<string | null> }

/** Freeze one click before any await. Diagnostic identity never replaces Input identity. */
export function startDeliveryAttempt(input: { agentSessionId: string | null; operationId: string | null;
  hostId: string | null; condition?: AgentPromptCondition | null | undefined; execution?: 'default' | 'immediate'; prompt?: string }): DeliveryAttemptSeed {
  const bytes = input.prompt === undefined ? null : new TextEncoder().encode(input.prompt)
  const digest = bytes === null || !crypto.subtle ? Promise.resolve(null) : crypto.subtle.digest('SHA-256', bytes)
    .then(value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''), () => null)
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
            reportIssue: typeof saved.reportIssue === 'string' ? saved.reportIssue : null })
        } catch { /* Keep the original storage bytes; an unreadable record is never overwritten. */ }
      }
    } catch { /* Failure records below explicitly disclose memory-only retention. */ }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(logId: string): ClientDeliveryLog | undefined { const entry = this.logs.get(logId); return entry ? structuredClone(entry) : undefined }
  async failed(seed: DeliveryAttemptSeed, error: unknown, stage: string, owner: string | null): Promise<ClientDeliveryLog> {
    const failedAt = Date.now(), failure = deliveryFailure(error)
    const { digest, ...facts } = seed
    const record: DeliveryAttempt = { ...facts, source: 'client', promptDigest: await digest,
      failedAt, stage, error: failure, ...(failure.logId ? { coreLogId: failure.logId } : {}) }
    parseDeliveryAttempt(record)
    const entry: ClientDeliveryLog = { record, owner, localSaved: false, remote: null, reportIssue: null }
    this.logs.set(record.logId, entry); this.save(entry); this.changed()
    return structuredClone(entry)
  }
  /** Caller supplies the exact original receiving owner and its authenticated transport. */
  async sync(owner: string, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    await Promise.all([...this.logs.values()].filter(entry => entry.owner === owner && entry.remote?.persistence !== 'confirmed')
      .map(entry => this.report(entry, report)))
  }
  private async report(entry: ClientDeliveryLog, report: (record: DeliveryAttempt) => Promise<DeliveryAttemptLookup>): Promise<void> {
    const active = this.reporting.get(entry.record.logId)
    if (active) return await active
    const pending = (async () => {
      try {
        const result = parseDeliveryAttemptLookup(await report(structuredClone(entry.record)), entry.record.logId)
        if (result.record && canonical({ ...result.record, reporter: undefined }) !== canonical(entry.record)) {
          throw new Error('The diagnostic service returned different original failure facts.')
        }
        entry.remote = result; entry.reportIssue = result.issue
      } catch (error) { entry.reportIssue = error instanceof Error ? error.message : String(error) }
      this.save(entry); this.changed()
    })()
    this.reporting.set(entry.record.logId, pending)
    try { await pending } finally { this.reporting.delete(entry.record.logId) }
  }
  private save(entry: ClientDeliveryLog): void {
    try { this.storage().setItem(PREFIX + entry.record.logId, JSON.stringify({ ...entry, localSaved: true })); entry.localSaved = true }
    catch { entry.localSaved = false }
  }
  private changed(): void { for (const listener of this.listeners) listener() }
}
export function deliveryLogNotice(entry: ClientDeliveryLog): string {
  if (entry.remote?.availability === 'found' && entry.remote.persistence === 'confirmed') return '日志已保存到原 Host，可用 logid 查询'
  if (entry.remote?.availability === 'found') return `原 Host 当前可查询；日志持久保存未确认${entry.remote.issue ? `：${entry.remote.issue}` : ''}`
  if (entry.owner === null) return `${entry.localSaved ? '日志已在本机保留' : '日志仅在当前页面内存中保留'}；原诊断 Host 未核实，暂不能远端查询`
  return `${entry.localSaved ? '日志已在本机保留，等待上传到原 Host' : '日志仅在当前页面内存中保留，持久保存和上传未确认'}${entry.reportIssue ? `：${entry.reportIssue}` : ''}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}

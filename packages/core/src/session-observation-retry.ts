import type { AgentMuxStoredAgentSession } from './types.js'

export type SessionObservationKind = 'hook' | 'terminal' | 'native-status'
export type SessionObservationTarget = { session: AgentMuxStoredAgentSession; epoch: number }

/** The immutable observation source, not a projection of whether the Agent is healthy. */
export function sessionObservationSource(session: AgentMuxStoredAgentSession): string {
  return JSON.stringify([session.hostId, session.agentSessionId, session.run, session.providerId,
    session.workspacePath, session.nativeHandle, session.nativeActor, session.hookBindingId])
}

type PendingObservation = {
  target: SessionObservationTarget; source: string; kind: SessionObservationKind
  controller: AbortController; timer?: ReturnType<typeof setTimeout>; pending?: Promise<void>
}

/** Scheduling only. The original Hook, terminal and Provider readers retain their facts. */
export class AgentSessionObservationRetries {
  private readonly entries = new Map<string, Map<SessionObservationKind, PendingObservation>>()

  constructor(
    private readonly current: (target: SessionObservationTarget) => boolean,
    private readonly observe: (target: SessionObservationTarget, kind: SessionObservationKind, signal: AbortSignal) => Promise<boolean>,
    private readonly confirmed: (target: SessionObservationTarget) => void
  ) {}

  has(target?: SessionObservationTarget, kind?: SessionObservationKind): boolean {
    if (!target) return this.entries.size > 0
    const entries = this.entries.get(target.session.agentSessionId), source = sessionObservationSource(target.session)
    return [...entries?.values() ?? []].some(entry => (!kind || entry.kind === kind) &&
      entry.source === source && entry.target.epoch === target.epoch)
  }

  queue(target: SessionObservationTarget, kind: SessionObservationKind): void {
    if (!this.current(target)) return
    const id = target.session.agentSessionId, source = sessionObservationSource(target.session)
    let entries = this.entries.get(id)
    const existing = entries?.get(kind)
    if (existing && existing.source === source && existing.target.epoch === target.epoch) return
    if (existing) this.remove(existing)
    entries = this.entries.get(id)
    if (!entries) this.entries.set(id, entries = new Map())
    const entry: PendingObservation = { target, source, kind, controller: new AbortController() }
    entries.set(kind, entry)
    this.schedule(entry)
  }

  /** An explicit read may retry its own pending observations, sharing any current attempt. */
  async refresh(target: SessionObservationTarget): Promise<void> {
    const source = sessionObservationSource(target.session)
    await Promise.all([...this.entries.get(target.session.agentSessionId)?.values() ?? []]
      .filter(entry => entry.source === source && entry.target.epoch === target.epoch)
      .map(entry => this.run(entry)))
  }

  settle(target: SessionObservationTarget, kind: SessionObservationKind): void {
    const entry = this.entries.get(target.session.agentSessionId)?.get(kind)
    if (entry?.source === sessionObservationSource(target.session) && entry.target.epoch === target.epoch) {
      this.remove(entry); this.confirmed(target)
    }
  }

  prune(target: SessionObservationTarget): void {
    const source = sessionObservationSource(target.session)
    for (const entry of [...this.entries.get(target.session.agentSessionId)?.values() ?? []]) {
      if (entry.source !== source || entry.target.epoch !== target.epoch || !this.current(entry.target)) this.remove(entry)
    }
  }

  cancel(agentSessionId: string): void {
    for (const entry of [...this.entries.get(agentSessionId)?.values() ?? []]) this.remove(entry)
  }

  clear(): void {
    for (const entries of [...this.entries.values()]) for (const entry of [...entries.values()]) this.remove(entry)
  }

  private live(entry: PendingObservation): boolean {
    return !entry.controller.signal.aborted && this.entries.get(entry.target.session.agentSessionId)?.get(entry.kind) === entry &&
      this.current(entry.target)
  }

  private remove(entry: PendingObservation): void {
    entry.controller.abort()
    if (entry.timer) clearTimeout(entry.timer)
    const entries = this.entries.get(entry.target.session.agentSessionId)
    if (entries?.get(entry.kind) !== entry) return
    entries.delete(entry.kind)
    if (!entries.size) this.entries.delete(entry.target.session.agentSessionId)
  }

  private schedule(entry: PendingObservation): void {
    if (!this.live(entry)) { this.remove(entry); return }
    if (entry.timer || entry.pending) return
    // Use the existing low-frequency recovery cadence without reopening all Sessions.
    entry.timer = setTimeout(() => { delete entry.timer; void this.run(entry) }, 30_000)
    entry.timer.unref?.()
  }

  private run(entry: PendingObservation): Promise<void> {
    if (entry.pending) return entry.pending
    if (!this.live(entry)) { this.remove(entry); return Promise.resolve() }
    if (entry.timer) { clearTimeout(entry.timer); delete entry.timer }
    const pending = (async () => {
      const complete = await this.observe(entry.target, entry.kind, entry.controller.signal)
      if (this.live(entry) && complete) { this.remove(entry); this.confirmed(entry.target) }
    })().finally(() => {
      if (entry.pending === pending) delete entry.pending
      this.schedule(entry)
    })
    entry.pending = pending
    return pending
  }
}

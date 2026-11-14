import { mintObjectId } from './object-id.js'
import { observeMessageJournal } from './agent-message-observer.js'
import { agentPromptCondition, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { agentTurnCompletionIdentity, sameRun } from './agent-session-identity.js'
import type { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import type { AgentMuxAutomaticNotification, AgentMuxMessageNotification } from './agent-message-notification.js'
import type { AgentProvider } from './agent-provider.js'
import type { AutomaticInputOpportunity } from './mote/input-owner.js'
import type { AgentNativeHookSpecification } from './hook-normalizer.js'
import type { AgentMuxAgentSession } from './types.js'
import { sessionSemanticResumeSourceRuns } from './agent-session-resume-sources.js'
import { AgentMuxError } from './errors.js'

type Dependencies = {
  queue: DurableAgentMuxMessageQueue
  connected(): boolean
  read(agentSessionId: string): Promise<AutomaticInputOpportunity | null>
  submit(notification: AgentMuxMessageNotification): Promise<void>
  inputAbsent(key: AgentPromptInputKey): Promise<boolean>
  unavailable(agentSessionId: string | undefined, error: unknown, run?: AgentMuxAgentSession['run']): void
  /** Answer the exact original turn-end callback once with this Provider output. */
  answerTurnEnd?(callback: TurnEndCallback, output: Readonly<Record<string, unknown>>): Promise<'written' | 'unknown' | 'closed'>
  /** Release the exact original turn-end callback without a decision; the native turn ends unchanged. */
  abstainTurnEnd?(callback: TurnEndCallback): void
}

type TurnEndDecision = NonNullable<AgentNativeHookSpecification['turnEndDecision']>

/** Which automatic path a recipient's Provider actually contributes; the one owner of this fact. */
export function automaticNotification(provider: Pick<AgentProvider, 'prepareNativeInput' | 'hook' | 'catalog'>): AgentMuxAutomaticNotification {
  return provider.prepareNativeInput && provider.catalog.capabilities.nativeConversationInput?.idleQueue !== false
    ? 'idle-queue' : provider.hook.turnEndDecision ? 'turn-end' : 'none'
}

/** One authenticated native turn-end callback of an exact Run's main session. */
export type TurnEndCallback = { session: AgentMuxAgentSession; nativeTurnId: string; hookReceiptId: string; decision: TurnEndDecision }

/** Event-driven wakeups over the original journal, never an input or message owner. */
export class AgentMuxMessageNotifications {
  private readonly recipients = new Set<string>()
  private readonly drains = new Map<string, { pending: Promise<void>; requested: boolean }>()
  private readonly attempted = new Map<string, string>()
  /** Native turns whose first stop this owner has already decided; one notice per native turn. */
  private readonly turnEnds = new Map<string, string>()
  private readonly unconfirmedSources = new Map<string, string>()
  private readonly unavailableReads = new Map<string, string>()
  private observation: ReturnType<typeof observeMessageJournal> | undefined
  private disposed = false

  constructor(private readonly deps: Dependencies) {}

  private observe() {
    this.observation ??= observeMessageJournal(this.deps.queue, event => {
      if (this.disposed) return
      if (event.type === 'agent-message-changed') this.saved(event.recipientSessionId)
      else if (event.state === 'unavailable') this.deps.unavailable(undefined, new Error(event.message))
    })
  }

  async restore(): Promise<void> {
    if (this.disposed) return
    this.observe()
    this.attempted.clear()
    this.unconfirmedSources.clear()
    try {
      for (const id of await this.deps.queue.pendingNotificationRecipients()) this.saved(id)
    } catch (error) { this.deps.unavailable(undefined, error) }
  }

  saved(agentSessionId: string): void {
    if (this.disposed) return
    this.observe()
    this.recipients.add(agentSessionId)
    this.changed(agentSessionId)
  }

  changed(agentSessionId: string): void {
    if (this.disposed || !this.recipients.has(agentSessionId) || !this.deps.connected()) return
    const existing = this.drains.get(agentSessionId)
    if (existing) { existing.requested = true; return }
    const entry = { pending: Promise.resolve(), requested: true }
    this.drains.set(agentSessionId, entry)
    entry.pending = (async () => {
      try {
        while (entry.requested && !this.disposed && this.deps.connected()) {
          entry.requested = false
          await this.drain(agentSessionId)
        }
      } catch (error) { this.deps.unavailable(agentSessionId, error) }
      finally { if (this.drains.get(agentSessionId) === entry) this.drains.delete(agentSessionId) }
    })()
  }

  private async drain(agentSessionId: string): Promise<void> {
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId); this.unconfirmedSources.delete(agentSessionId); this.unavailableReads.delete(agentSessionId); return }
    const current = await this.deps.read(agentSessionId)
    // A turn-end path is carried by its own callback, and a recipient without a path waits for an
    // explicit notification. Both are known capabilities of a healthy Agent, not failed observations.
    if (!current || this.disposed || current.automatic !== 'idle-queue') return
    const { session, inputByte, nativeIdle } = current
    if ('unavailable' in current) {
      const error = current.unavailable
      // This identity merges only observations. It never grants input or settles a claim.
      const failure = JSON.stringify([session.run.runId, error instanceof AgentMuxError ? error.code : null,
        error instanceof Error ? error.message : String(error)])
      if (this.unavailableReads.get(agentSessionId) !== failure) {
        this.unavailableReads.set(agentSessionId, failure)
        this.deps.unavailable(agentSessionId, error, session.run)
      }
      return
    }
    this.unavailableReads.delete(agentSessionId)
    // A completion or exact initial idle selects an opportunity. The Input owner and Provider must
    // still confirm this exact source and idle-only admission before any input.
    const completionId = agentTurnCompletionIdentity(session)
    if (inputByte === null || !completionId && nativeIdle?.state !== 'idle') return
    const idle = completionId ? { completionId, inputByte }
      : { nativeEvidence: { sourceId: nativeIdle!.sourceId, id: nativeIdle!.id }, inputByte }
    const condition = agentPromptCondition(session)
    const sourceRuns = sessionSemanticResumeSourceRuns(session)
    const position = await this.deps.queue.pendingNotificationPosition(agentSessionId, sourceRuns,session.inputEpoch)
    // Failure to explain excluded historical references is a weak observation dependency:
    // publish its service window, then continue this writer's independently qualified work.
    try {
      const excluded = await this.deps.queue.excludedNotificationPosition(agentSessionId, sourceRuns,session.inputEpoch)
      if (!excluded) this.unconfirmedSources.delete(agentSessionId)
      else {
        const gap = JSON.stringify([session.run.runId, sourceRuns, excluded])
        if (this.unconfirmedSources.get(agentSessionId) !== gap) {
          this.unconfirmedSources.set(agentSessionId, gap)
          this.deps.unavailable(agentSessionId, new Error('A retained Inbox reference belongs to a historical Run or storage cut whose input qualification for this writer is unconfirmed. Read the original Inbox or explicitly notify its MID; no original input was replayed.'), session.run)
        }
      }
    } catch (error) {
      const gap = JSON.stringify([session.run.runId, sourceRuns, 'unavailable'])
      if (this.unconfirmedSources.get(agentSessionId) !== gap) {
        this.unconfirmedSources.set(agentSessionId, gap); this.deps.unavailable(agentSessionId, error, session.run)
      }
    }
    // Our own rejected claim changes the predecessor, not the idle opportunity.
    const opportunity = JSON.stringify([condition.expectedRun, idle, sourceRuns, position])
    if (this.attempted.get(agentSessionId) === opportunity) return
    this.attempted.set(agentSessionId, opportunity)
    const notificationId = `a2a-notice-${mintObjectId()}`
    const notice = await this.deps.queue.prepareNotification({ agentSessionId,
      notificationId, condition, idle, sourceRuns,
      originalInputAbsent: () => this.deps.inputAbsent({ kind: 'prompt', agentSessionId, expectedRun: condition.expectedRun, submissionId: notificationId }) })
    if (notice) await this.deps.submit(notice)
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId); this.unconfirmedSources.delete(agentSessionId); this.unavailableReads.delete(agentSessionId) }
  }

  /**
   * Adopt one authenticated turn-end callback, or return false so ingress releases it at once and
   * the native turn ends unchanged. Only the exact Run's main native session, on the first stop of
   * one native turn, carries a notice; the decision itself runs outside the Hook lane.
   */
  adoptTurnEnd(input: { session: AgentMuxAgentSession; receipt: AgentMuxAgentSession['hookReceipt']; receiptId: string
    decision: TurnEndDecision; payload: Readonly<Record<string, unknown>> }): boolean {
    const { session, receipt, receiptId, decision } = input, handle = session.nativeHandle
    if (this.disposed || receipt?.id !== receiptId || !sameRun(receipt.run, session.run) || receipt.subject?.kind !== 'main' ||
        handle?.kind !== 'provider' || receipt.subject.nativeSessionId !== handle.sessionId) return false
    const turn = decision.readTurn(input.payload)
    if (!turn?.firstStop) return false
    void this.decideTurnEnd({ session, nativeTurnId: turn.nativeTurnId, hookReceiptId: receiptId, decision })
      .catch(error => this.deps.unavailable(session.agentSessionId, error, session.run))
    return true
  }

  /**
   * Decide one genuinely completing native turn's stop. A notice is prepared only for new
   * pending references of this exact Run, then handed to the original callback; its outcome is
   * the callback's own write receipt. Every other path releases the callback at once, so the
   * native turn ends unchanged without waiting for its Hook deadline.
   */
  private async decideTurnEnd(callback: TurnEndCallback): Promise<void> {
    const { session, nativeTurnId, hookReceiptId } = callback, agentSessionId = session.agentSessionId
    let notice: AgentMuxMessageNotification | null = null
    try {
      const turn = JSON.stringify([session.run.runId, nativeTurnId])
      if (this.disposed || !this.deps.answerTurnEnd || this.turnEnds.get(agentSessionId) === turn) return
      this.turnEnds.set(agentSessionId, turn)
      notice = await this.deps.queue.prepareNotification({ agentSessionId, notificationId: `a2a-notice-${mintObjectId()}`,
        condition: agentPromptCondition(session), turnEnd: { nativeTurnId, hookReceiptId },
        sourceRuns: sessionSemanticResumeSourceRuns(session) })
    } catch (error) { this.deps.unavailable(agentSessionId, error, session.run) }
    finally { if (!notice) this.deps.abstainTurnEnd?.(callback) }
    if (!notice) return
    let written: 'written' | 'unknown' | 'closed'
    try { written = await this.deps.answerTurnEnd!(callback, callback.decision.output(notice.wire, notice.notificationId)) } catch { written = 'unknown' }
    try {
      // Written is the original connection's complete response, the same strength as an accepted
      // input byte; it never claims that the model read the notice. A native queue reports its own
      // admission later, so a written answer there stays pending until that report or stays unknown.
      if (written === 'written' && callback.decision.admission) return
      if (written === 'written') await this.deps.queue.recordNotificationResult(notice.notificationId, 'submitted')
      else if (written === 'closed') await this.deps.queue.recordNotificationResult(notice.notificationId, 'not-applied',
        'The original turn-end callback closed before this notice was written. The Inbox is retained for the next turn end or an explicit notification.')
      else await this.deps.queue.recordNotificationResult(notice.notificationId, 'unconfirmed',
        'The original turn-end response delivery is unknown. Its notice is retained and will not be resent.')
    } catch (error) { this.deps.unavailable(agentSessionId, error, session.run) }
  }

  /**
   * The native queue's own report for a notice this owner handed to it at a turn end. Only the
   * exact Run's main native session may report, and only for a pending turn-end notice of that
   * Run; a drop is a confirmed whole refusal and returns its references to awaiting notification.
   */
  async admitTurnEnd(input: { session: AgentMuxAgentSession; receipt: AgentMuxAgentSession['hookReceipt']; receiptId: string
    decision: TurnEndDecision; payload: Readonly<Record<string, unknown>> }): Promise<void> {
    const { session, receipt, receiptId, decision } = input, handle = session.nativeHandle
    if (this.disposed || !decision.admission || receipt?.id !== receiptId || !sameRun(receipt.run, session.run) || receipt.subject?.kind !== 'main' ||
        handle?.kind !== 'provider' || receipt.subject.nativeSessionId !== handle.sessionId) return
    const report = decision.admission.read(input.payload)
    if (!report) return
    const notice = await this.deps.queue.readNotification(report.notificationId)
    if (!notice?.turnEnd || notice.state !== 'pending' || notice.key.agentSessionId !== session.agentSessionId ||
        !sameRun(notice.key.expectedRun, session.run)) return
    if (report.admitted) await this.deps.queue.recordNotificationResult(notice.notificationId, 'submitted')
    else {
      await this.deps.queue.recordNotificationResult(notice.notificationId, 'not-applied',
        `The native idle queue dropped this notice (${report.reason}). The Inbox is retained for the next turn end or an explicit notification.`)
      this.changed(session.agentSessionId)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.observation?.dispose()
    await Promise.allSettled([...this.drains.values()].map(value => value.pending))
    this.drains.clear(); this.recipients.clear(); this.attempted.clear(); this.unconfirmedSources.clear(); this.unavailableReads.clear()
  }
}

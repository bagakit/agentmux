import { mintObjectId } from './object-id.js'
import { observeMessageJournal } from './agent-message-observer.js'
import { agentPromptCondition, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from './agent-session-identity.js'
import type { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import type { AgentMuxMessageNotification } from './agent-message-notification.js'
import type { AgentMuxAgentSession, AgentPromptExecutionEvidence } from './types.js'
import { messageNotificationSourceRuns } from './agent-message-notification-sources.js'

type Dependencies = {
  queue: DurableAgentMuxMessageQueue
  connected(): boolean
  read(agentSessionId: string): Promise<{ session: AgentMuxAgentSession; inputByte: number | null; nativeIdle?: AgentPromptExecutionEvidence } | null>
  submit(notification: AgentMuxMessageNotification): Promise<void>
  inputAbsent(key: AgentPromptInputKey): Promise<boolean>
  unavailable(agentSessionId: string | undefined, error: unknown): void
}

/** Event-driven wakeups over the original journal, never an input or message owner. */
export class AgentMuxMessageNotifications {
  private readonly recipients = new Set<string>()
  private readonly drains = new Map<string, { pending: Promise<void>; requested: boolean }>()
  private readonly attempted = new Map<string, string>()
  private readonly unconfirmedSources = new Map<string, string>()
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
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId); this.unconfirmedSources.delete(agentSessionId); return }
    const current = await this.deps.read(agentSessionId)
    if (!current || this.disposed) return
    const { session, inputByte, nativeIdle } = current
    // A completion or exact initial idle selects an opportunity. The Input owner and Provider must
    // still confirm this exact source and idle-only admission before any input.
    const completionId = agentTurnCompletionIdentity(session)
    if (inputByte === null || !completionId && nativeIdle?.state !== 'idle') return
    const idle = completionId ? { completionId, inputByte }
      : { nativeEvidence: { sourceId: nativeIdle!.sourceId, id: nativeIdle!.id }, inputByte }
    const condition = agentPromptCondition(session)
    const sourceRuns = messageNotificationSourceRuns(session)
    const position = await this.deps.queue.pendingNotificationPosition(agentSessionId, sourceRuns)
    // Failure to explain excluded historical references is a weak observation dependency:
    // publish its service window, then continue this writer's independently qualified work.
    try {
      const excluded = await this.deps.queue.excludedNotificationPosition(agentSessionId, sourceRuns)
      if (!excluded) this.unconfirmedSources.delete(agentSessionId)
      else {
        const gap = JSON.stringify([session.run.runId, sourceRuns, excluded])
        if (this.unconfirmedSources.get(agentSessionId) !== gap) {
          this.unconfirmedSources.set(agentSessionId, gap)
          this.deps.unavailable(agentSessionId, new Error('A retained Inbox reference belongs to a historical Run whose semantic recovery relationship to this writer is unconfirmed. Read the original Inbox or explicitly notify its MID; no original input was replayed.'))
        }
      }
    } catch (error) {
      const gap = JSON.stringify([session.run.runId, sourceRuns, 'unavailable'])
      if (this.unconfirmedSources.get(agentSessionId) !== gap) {
        this.unconfirmedSources.set(agentSessionId, gap); this.deps.unavailable(agentSessionId, error)
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
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId); this.unconfirmedSources.delete(agentSessionId) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.observation?.dispose()
    await Promise.allSettled([...this.drains.values()].map(value => value.pending))
    this.drains.clear(); this.recipients.clear(); this.attempted.clear(); this.unconfirmedSources.clear()
  }
}

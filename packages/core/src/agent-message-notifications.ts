import { mintObjectId } from './object-id.js'
import { observeMessageJournal } from './agent-message-observer.js'
import { agentPromptCondition, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from './agent-session-identity.js'
import type { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import type { AgentMuxMessageNotification } from './agent-message-notification.js'
import type { AgentMuxAgentSession } from './types.js'

type Dependencies = {
  queue: DurableAgentMuxMessageQueue
  connected(): boolean
  read(agentSessionId: string): Promise<{ session: AgentMuxAgentSession; inputByte: number | null } | null>
  submit(notification: AgentMuxMessageNotification): Promise<void>
  inputAbsent(key: AgentPromptInputKey): Promise<boolean>
  unavailable(agentSessionId: string | undefined, error: unknown): void
}

/** Event-driven wakeups over the original journal, never an input or message owner. */
export class AgentMuxMessageNotifications {
  private readonly recipients = new Set<string>()
  private readonly drains = new Map<string, { pending: Promise<void>; requested: boolean }>()
  private readonly attempted = new Map<string, string>()
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
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId); return }
    const current = await this.deps.read(agentSessionId)
    if (!current || this.disposed) return
    const { session, inputByte } = current
    // A completion selects an opportunity. The Input owner and Provider must
    // still confirm this exact source and idle-only admission before any input.
    const completionId = agentTurnCompletionIdentity(session)
    if (!completionId || inputByte === null) return
    const condition = agentPromptCondition(session)
    const position = await this.deps.queue.pendingNotificationPosition(agentSessionId, condition.expectedRun.runId)
    const opportunity = JSON.stringify([completionId, inputByte, condition.afterSubmissionId, position])
    if (this.attempted.get(agentSessionId) === opportunity) return
    this.attempted.set(agentSessionId, opportunity)
    const notificationId = `a2a-notice-${mintObjectId()}`
    const notice = await this.deps.queue.prepareNotification({ agentSessionId,
      notificationId, condition, idle: { completionId, inputByte },
      originalInputAbsent: () => this.deps.inputAbsent({ kind: 'prompt', agentSessionId, expectedRun: condition.expectedRun, submissionId: notificationId }) })
    if (notice) await this.deps.submit(notice)
    if (!await this.deps.queue.hasPendingNotification(agentSessionId)) { this.recipients.delete(agentSessionId); this.attempted.delete(agentSessionId) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.observation?.dispose()
    await Promise.allSettled([...this.drains.values()].map(value => value.pending))
    this.drains.clear(); this.recipients.clear(); this.attempted.clear()
  }
}

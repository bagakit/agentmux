import { isDeepStrictEqual } from 'node:util'
import { observePromptInput } from './prompt-submission.js'
import type {
  ConversationTimelineReadInput,
  AgentConversationReadPage,
  ConversationReadRecord
} from './conversation-changes.js'
import { AgentMuxError } from './errors.js'
import type { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import { agentPromptCondition, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { agentTurnCompletionIdentity } from './agent-session-identity.js'
import {
  consumeConversationWindowPage,
  isCompleteConversationRecord,
  type ConversationCheckpoint,
  type ConversationChangesInput,
  type ConversationChangesPage,
  type ConversationObservationHandle,
  type ConversationWindowAssembly
} from './conversation-changes.js'
import type { AgentMuxAgentSession, AgentPromptExecutionEvidence } from './types.js'
import type { AgentMuxMessageNotification } from './agent-message-notification.js'
import {
  moteInputMember,
  moteInputNeedsObservation,
  moteInputObservationId,
  parseAgentInputMoteSource,
  type AgentInputMoteResolver,
  type AgentInputMoteSource,
  type MoteInputOrigin,
  type MoteInputObservation,
  type MoteInputInspection,
  type MoteInputNoticePhase
} from './mote-input.js'

type SourceRead = {
  input: MoteInputObservation['input']
  key?: AgentPromptInputKey
  text: string | null
  confirmedQuestion?: MoteInputObservation['confirmedQuestion']
  result?: MoteInputObservation['result']
}
export type AutomaticInputOpportunity = {
  session: AgentMuxAgentSession
  inputByte: number | null
  nativeIdle?: AgentPromptExecutionEvidence
  unavailable?: unknown
}
type Dependencies = {
  queue: DurableAgentMuxMessageQueue
  capture?: AgentInputMoteResolver
  readSource(origin: MoteInputOrigin): Promise<SourceRead>
  sourceExists(origin: MoteInputOrigin): Promise<boolean>
  checkpoint(member: string, signal?: AbortSignal): Promise<ConversationCheckpoint>
  changes(input: ConversationChangesInput, signal: AbortSignal): Promise<ConversationChangesPage>
  release(input: { hostId: string; agentSessionId: string; view: string }): Promise<unknown>
  original(input: ConversationTimelineReadInput, signal: AbortSignal): Promise<AgentConversationReadPage>
  watch(member: string, changed: () => void): Promise<ConversationObservationHandle>
  opportunity(primary: string): Promise<AutomaticInputOpportunity | null>
  submit(notice: AgentMuxMessageNotification): Promise<void>
  inspectNotice(id: string): Promise<{ notification: AgentMuxMessageNotification | null }>
  issue(member: string, message: string): void
}

/** Event-driven coordination over original input, conversation and message owners. No polling or input replay. */
export class MoteInputOwner {
  private readonly jobs = new Map<string, { promise: Promise<void>; dirty: boolean }>()
  private readonly participants = new Set<string>()
  private readonly preparations = new Map<string, Promise<string | undefined>>()
  private readonly records = new Map<string, Promise<void>>()
  private readonly watches = new Map<string, Promise<ConversationObservationHandle>>()
  private readonly issues = new Map<string, string>()
  private readonly reads = new Set<AbortController>()
  private disposed = false
  constructor(private readonly deps: Dependencies) {}

  private issue(member: string, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    if (this.issues.get(member) === text) return
    this.issues.set(member, text)
    this.deps.issue(member, text)
  }

  /** Source capture joins only this original operation, never a historical input queue. */
  async prepare(
    origin: MoteInputOrigin,
    sourceValue: AgentInputMoteSource | undefined,
    human: boolean
  ): Promise<string | undefined> {
    if (!sourceValue || this.disposed) return
    let id: string
    try {
      id = moteInputObservationId(origin)
    } catch (error) {
      this.issue(moteInputMember(origin), error)
      return
    }
    const active = this.preparations.get(id)
    if (active) return await active
    const work = this.prepareOriginal(origin, sourceValue, human)
    this.preparations.set(id, work)
    try {
      return await work
    } finally {
      if (this.preparations.get(id) === work) this.preparations.delete(id)
    }
  }
  /** Freeze the source decision before submitting input; slow source/result reads cannot hold input
   * beyond 250ms. A late result is cancelled, and the durable unknown receipt remains readable. */
  private async prepareOriginal(
    origin: MoteInputOrigin,
    sourceValue: AgentInputMoteSource,
    human: boolean
  ): Promise<string | undefined> {
    const member = moteInputMember(origin),
      controller = new AbortController(),
      signal = controller.signal
    let frozenId: string | undefined,
      sourceConfirmed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<string | undefined>((resolve) => {
      timer = setTimeout(() => {
        const message = sourceConfirmed
          ? 'The result boundary could not be confirmed within its read budget. The frozen primary can still receive this input.'
          : 'The original Mote source is unconfirmed within its input budget. The member input continues; no observer is inferred from a late read.'
        controller.abort(new AgentMuxError(message, 'MOTE_INPUT_OBSERVATION_UNCONFIRMED'))
        this.issue(member, message)
        resolve(frozenId)
      }, 250)
      timer.unref?.()
    })
    const prepare = async () => {
      const source = parseAgentInputMoteSource(sourceValue),
        id = moteInputObservationId(origin)
      const previous = await this.deps.queue.readMoteInputObservation(id)
      signal.throwIfAborted()
      if (previous) {
        if (previous.sourceStatus === 'pending')
          await this.update(previous, {
            sourceStatus: 'unavailable',
            issue:
              'The original source capture ended without a confirmed binding. The input and source are retained; it was not retrospectively shared.'
          })
        else if (moteInputNeedsObservation(previous)) this.track(previous)
        if (!isDeepStrictEqual(previous.source, source))
          this.issue(
            member,
            'The original input already has another Mote source. Its original observer is retained; it was not redirected.'
          )
        return id
      }
      let record: MoteInputObservation = {
        id,
        revision: 1,
        origin,
        source,
        binding: null,
        sourceStatus: 'pending',
        issue: 'Confirming the original Mote input source.',
        input: 'unconfirmed',
        notices: {}
      }
      await this.deps.queue.saveMoteInputObservation(record, 0, signal)
      frozenId = id
      this.track(record)
      let binding: MoteInputObservation['binding'] = null,
        sourceStatus: MoteInputObservation['sourceStatus'] = 'unavailable',
        issue: string | null = null
      try {
        signal.throwIfAborted()
        if (await this.deps.sourceExists(origin))
          issue =
            'The original input predates this source capture. Its delivery is retained; it was not retrospectively shared.'
        else if (!human)
          issue =
            'Human authorship is unconfirmed. The original input remains available; it was not shared as a human decision.'
        else {
          signal.throwIfAborted()
          if (!this.deps.capture)
            throw new AgentMuxError(
              'The original Host Mote source owner is unavailable.',
              'MOTE_INPUT_SOURCE_UNCONFIRMED'
            )
          binding = await observePromptInput(signal, () =>
            this.deps.capture!({ source, agentSessionId: member, signal })
          )
          signal.throwIfAborted()
          sourceStatus = binding ? 'confirmed' : 'self'
          if (binding && binding.primary.hostId !== 'local')
            issue =
              'The original primary belongs to another Host. Its observation is retained; no local substitute was notified.'
        }
      } catch (error) {
        binding = null
        sourceStatus = 'unavailable'
        issue = error instanceof Error ? error.message : String(error)
      }
      // After timeout, only the unknown diagnostic may settle; no late observer can be assigned.
      if (signal.aborted) {
        binding = null
        sourceStatus = 'unavailable'
        issue = String(signal.reason instanceof Error ? signal.reason.message : signal.reason)
      }
      try {
        record = await this.deps.queue.saveMoteInputObservation(
          { ...record, revision: record.revision + 1, binding, sourceStatus, issue },
          record.revision,
          sourceStatus === 'confirmed' || sourceStatus === 'self' ? signal : undefined
        )
      } catch (error) {
        if (!signal.aborted) throw error
        record = await this.update(record, {
          binding: null,
          sourceStatus: 'unavailable',
          issue: 'The original source was not frozen before input continued. No late observer was assigned.'
        })
      }
      sourceConfirmed = sourceStatus === 'confirmed'
      if (moteInputNeedsObservation(record)) this.track(record)
      if (issue) this.issue(member, issue)
      if (binding?.primary.hostId === 'local' && origin.kind === 'prompt' && !signal.aborted) {
        try {
          const checkpoint = await observePromptInput(signal, () => this.deps.checkpoint(member, signal))
          signal.throwIfAborted()
          await this.deps.queue.saveMoteInputObservation(
            { ...record, revision: record.revision + 1, checkpoint },
            record.revision,
            signal
          )
        } catch (error) {
          const issue =
            'The original result boundary is unconfirmed: ' + (error instanceof Error ? error.message : String(error))
          this.issue(member, issue)
          const current = await this.deps.queue.readMoteInputObservation(id)
          if (current) await this.update(current, { issue })
        }
      }
      return id
    }
    try {
      return await Promise.race([prepare(), timeout])
    } catch (error) {
      this.issue(member, error)
      return frozenId
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private track(record: MoteInputObservation): void {
    this.participants.add(moteInputMember(record.origin))
    if (record.binding) this.participants.add(record.binding.primary.agentSessionId)
  }
  private async releaseFinished(participant: string): Promise<void> {
    const remaining = await this.deps.queue.listMoteInputObservations(participant)
    if (!remaining.length) {
      this.participants.delete(participant)
      this.issues.delete(participant)
    }
    if (
      !remaining.some((record) => moteInputMember(record.origin) === participant && record.checkpoint && !record.result)
    ) {
      const watch = this.watches.get(participant)
      this.watches.delete(participant)
      if (watch) void watch.then((handle) => handle.dispose()).catch(() => {})
    }
  }

  changed(participant: string): void {
    if (this.disposed || !this.participants.has(participant)) return
    const job = this.jobs.get(participant)
    if (job) {
      job.dirty = true
      return
    }
    const next = { promise: Promise.resolve(), dirty: true }
    this.jobs.set(participant, next)
    next.promise = (async () => {
      try {
        while (next.dirty && !this.disposed) {
          next.dirty = false
          for (const record of await this.deps.queue.listMoteInputObservations(participant)) {
            if (this.disposed) return
            const prior = this.records.get(record.id) ?? Promise.resolve()
            const work = prior.catch(() => {}).then(() => this.reconcile(record.id))
            this.records.set(record.id, work)
            try {
              await work
            } catch (error) {
              this.issue(moteInputMember(record.origin), error)
              const current = await this.deps.queue.readMoteInputObservation(record.id)
              if (current) await this.update(current, { issue: error instanceof Error ? error.message : String(error) })
            } finally {
              if (this.records.get(record.id) === work) this.records.delete(record.id)
            }
            await this.releaseFinished(moteInputMember(record.origin))
          }
          await this.releaseFinished(participant)
        }
      } catch (error) {
        this.issue(participant, error)
      } finally {
        if (this.jobs.get(participant) === next) this.jobs.delete(participant)
      }
    })()
  }

  async restore(): Promise<void> {
    if (this.disposed) return
    try {
      for (const record of await this.deps.queue.listMoteInputObservations()) {
        this.track(record)
        this.changed(moteInputMember(record.origin))
      }
    } catch (error) {
      this.issue('', error)
    }
  }
  private async update(
    record: MoteInputObservation,
    patch: Partial<MoteInputObservation>
  ): Promise<MoteInputObservation> {
    const next = { ...record, ...patch }
    if (isDeepStrictEqual(next, record)) return record
    return await this.deps.queue.saveMoteInputObservation({ ...next, revision: record.revision + 1 }, record.revision)
  }
  private watch(member: string): void {
    if (this.watches.has(member) || this.disposed) return
    const watch = this.deps.watch(member, () => this.changed(member))
    this.watches.set(member, watch)
    void watch
      .then((handle) => {
        if (this.disposed || this.watches.get(member) !== watch) handle.dispose()
        else
          handle.closed.addEventListener(
            'abort',
            () => {
              if (this.watches.get(member) === watch) this.watches.delete(member)
            },
            { once: true }
          )
      })
      .catch((error) => {
        if (this.watches.get(member) === watch) this.watches.delete(member)
        this.issue(member, error)
      })
  }
  private async reconcile(id: string): Promise<void> {
    let record = await this.deps.queue.readMoteInputObservation(id)
    if (!record) return
    const member = moteInputMember(record.origin),
      source = await this.deps.readSource(record.origin)
    record = await this.update(record, {
      input: source.input,
      ...(source.confirmedQuestion ? { confirmedQuestion: source.confirmedQuestion } : {}),
      ...(source.result ? { result: source.result } : {})
    })
    if (!record.binding || !['admitted', 'terminal-confirmed', 'interaction-confirmed'].includes(record.input)) return
    if (record.origin.kind === 'prompt') record = await this.notify(record, 'input')
    if (record.origin.kind === 'prompt' && !record.result && record.checkpoint) {
      this.watch(member)
      record = await this.results(record, source.key ?? record.origin.key)
    }
    if (record.result) await this.notify(record, 'result')
  }

  private async results(original: MoteInputObservation, inputKey: AgentPromptInputKey): Promise<MoteInputObservation> {
    let record = original,
      cursor: string | undefined,
      assembly: ConversationWindowAssembly | undefined
    const member = moteInputMember(record.origin),
      controller = new AbortController(),
      signal = controller.signal
    const timer = setTimeout(
      () =>
        controller.abort(
          new AgentMuxError(
            'The original result read exceeded its observation budget; the confirmed input remains shared.',
            'MOTE_INPUT_RESULT_UNCONFIRMED'
          )
        ),
      5000
    )
    timer.unref?.()
    this.reads.add(controller)
    const views = new Set<string>()
    try {
      do {
        if (this.disposed) return record
        const page = await observePromptInput(signal, () =>
          this.deps.changes(
            {
              hostId: 'local',
              agentSessionId: member,
              checkpoint: original.checkpoint!,
              ...(cursor ? { cursor } : {}),
              limit: 100,
              maxBytes: 64 * 1024,
              processDetails: 'deferred'
            },
            signal
          )
        )
        const consumed = consumeConversationWindowPage(page, assembly)
        if (consumed.kind === 'pending') assembly = consumed.pending
        else {
          assembly = undefined
          if (page.window.view) views.add(page.window.view)
          const records = consumed.snapshot.units.flatMap((unit) => unit.records)
          const inputs = records
            .filter(isCompleteConversationRecord)
            .filter(
              (value) =>
                value.original.kind === 'native' &&
                value.reference?.source.kind === 'native' &&
                value.original.item.kind === 'user-message' &&
                isDeepStrictEqual(value.original.item.conversation?.adoptedInput?.key, inputKey)
            )
          if (inputs.length > 1)
            throw new AgentMuxError(
              'More than one native record claims the original input; its result remains unconfirmed.',
              'MOTE_INPUT_RESULT_UNCONFIRMED'
            )
          const input = inputs[0]
          if (
            input?.original.kind === 'native' &&
            input.original.item.turnId &&
            input.reference?.source.kind === 'native'
          ) {
            const nativeInput = {
              source: {
                providerId: input.reference.source.providerId,
                nativeSessionId: input.reference.source.nativeSessionId
              },
              turnId: input.original.item.turnId,
              record: { record: input.reference, revision: input.revision }
            }
            if (record.nativeInput && !isDeepStrictEqual(record.nativeInput, nativeInput))
              throw new AgentMuxError(
                'The original native input identity changed; no result was attributed.',
                'MOTE_INPUT_RESULT_UNCONFIRMED'
              )
            record = await this.update(record, { nativeInput })
          }
          const native = record.nativeInput
          if (native) {
            const nativeItem = (value: ConversationReadRecord) =>
              value.original.kind === 'native'
                ? value.original.item
                : value.original.kind === 'deferred' && value.original.item.kind === 'native'
                  ? value.original.item.item
                  : null
            const exact = records.filter(
              (value) =>
                value.reference?.source.kind === 'native' &&
                value.reference.source.providerId === native.source.providerId &&
                value.reference.source.nativeSessionId === native.source.nativeSessionId &&
                nativeItem(value)?.turnId === native.turnId
            )
            const candidate = exact.find((value) => nativeItem(value)?.turnOutcome)
            // A deferred header selects one exact record; only its full original confirms the outcome.
            let outcome = candidate
            if (candidate?.original.kind === 'deferred' && candidate.reference) {
              let originalCursor: string | undefined, originalAssembly: ConversationWindowAssembly | undefined
              do {
                const originalPage = await observePromptInput(signal, () =>
                  this.deps.original(
                    {
                      hostId: 'local',
                      agentSessionId: member,
                      record: candidate.reference!,
                      maxBytes: 64 * 1024,
                      ...(originalCursor ? { cursor: originalCursor } : {})
                    },
                    signal
                  )
                )
                const complete = consumeConversationWindowPage(originalPage, originalAssembly)
                if (complete.kind === 'complete') {
                  if (originalPage.window.view) views.add(originalPage.window.view)
                  outcome = complete.snapshot.units
                    .flatMap((unit) => unit.records)
                    .find(
                      (value) =>
                        isDeepStrictEqual(value.reference, candidate.reference) && value.revision === candidate.revision
                    )
                  break
                }
                originalAssembly = complete.pending
                originalCursor = originalPage.nextCursor ?? undefined
                if (!originalCursor)
                  throw new AgentMuxError(
                    'The original outcome record is incomplete. Its checkpoint is retained.',
                    'MOTE_INPUT_RESULT_UNCONFIRMED'
                  )
              } while (originalCursor)
              if (outcome?.original.kind !== 'native')
                throw new AgentMuxError(
                  'The exact original outcome record is unconfirmed. Its checkpoint is retained.',
                  'MOTE_INPUT_RESULT_UNCONFIRMED'
                )
            }
            if (
              outcome?.original.kind === 'native' &&
              outcome.original.item.turnOutcome &&
              outcome.original.item.turnId === native.turnId
            ) {
              record = await this.update(record, {
                result: {
                  kind: 'native-turn',
                  status: outcome.original.item.turnOutcome.status,
                  records: exact
                    .filter(
                      (value) =>
                        value.reference && (nativeItem(value)?.kind === 'assistant-message' || value === candidate)
                    )
                    .map((value) => ({ record: value.reference!, revision: value.revision }))
                }
              })
            }
          }
          if (!page.more) record = await this.update(record, { checkpoint: page.checkpoint })
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return record
    } finally {
      clearTimeout(timer)
      this.reads.delete(controller)
      for (const view of views)
        await this.deps
          .release({ hostId: 'local', agentSessionId: member, view })
          .catch((error) => this.issue(member, error))
    }
  }

  private async notify(record: MoteInputObservation, phase: MoteInputNoticePhase): Promise<MoteInputObservation> {
    if (record.notices[phase]) {
      // The existing delivery owner may continue a never-submitted original after a crash.
      // Its claim check observes unknown writes without repeating or replacing them.
      const notice = await this.deps.queue.readNotification(record.notices[phase]!)
      if (notice) await this.deps.submit(notice)
      return record
    }
    if (record.binding!.primary.hostId !== 'local') {
      this.issue(
        moteInputMember(record.origin),
        'The original primary belongs to another Host. Its observation is retained; no local substitute was notified.'
      )
      return record
    }
    const current = await this.deps.opportunity(record.binding!.primary.agentSessionId)
    if (!current || current.unavailable) {
      const issue =
        current?.unavailable instanceof Error
          ? current.unavailable.message
          : 'The original primary is unavailable or unconfirmed. Its original observation is retained; restore that Session to continue.'
      this.issue(moteInputMember(record.origin), issue)
      return await this.update(record, { issue })
    }
    const completionId = agentTurnCompletionIdentity(current.session)
    if (current.inputByte === null || (!completionId && current.nativeIdle?.state !== 'idle')) return record
    const idle = completionId
      ? { completionId, inputByte: current.inputByte }
      : {
          nativeEvidence: { sourceId: current.nativeIdle!.sourceId, id: current.nativeIdle!.id },
          inputByte: current.inputByte
        }
    const notice = await this.deps.queue.prepareMoteInputNotification(
      record.id,
      phase,
      agentPromptCondition(current.session),
      idle
    )
    record = await this.update(record, { notices: { ...record.notices, [phase]: notice.notificationId } })
    await this.deps.submit(notice)
    return record
  }

  async inspect(id: string): Promise<MoteInputInspection | null> {
    const observation = await this.deps.queue.readMoteInputObservation(id)
    if (!observation) return null
    const source = await this.deps.readSource(observation.origin)
    const notices: MoteInputInspection['notices'] = {}
    for (const phase of ['input', 'result'] as const)
      if (observation.notices[phase]) {
        const value = (await this.deps.inspectNotice(observation.notices[phase]!)).notification
        if (value)
          notices[phase] = {
            state: value.state,
            notificationId: value.notificationId,
            key: value.key,
            mode: value.mode,
            ...(value.reason ? { reason: value.reason } : {}),
            preparedAt: value.preparedAt ?? null,
            resultRecordedAt: value.resultRecordedAt ?? null
          }
      }
    // A retained reader may run before the observer's event-driven reconciliation after a crash.
    // Project the original input owner now; inspection never persists or replays that input.
    return {
      observation: {
        ...observation,
        input: source.input === 'unconfirmed' ? observation.input : source.input,
        ...(source.confirmedQuestion ? { confirmedQuestion: source.confirmedQuestion } : {}),
        ...(source.result ? { result: source.result } : {})
      },
      inputText: source.text,
      notices
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.reads)
      controller.abort(new Error('Original result observation closed; its input and checkpoint are retained.'))
    this.reads.clear()
    for (const pending of this.watches.values()) void pending.then((handle) => handle.dispose()).catch(() => {})
    this.watches.clear()
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise))
  }
}

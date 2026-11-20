import { createHash } from 'node:crypto'
import { AgentMuxError, moteDirectScheduleSourceMatches, privateImageMetadata, type AgentMuxClient, type AgentMuxMessageReadView, type ContinuousProgressLoop, type MoteDirectCallContext, type MoteDirectMainNotification, type MoteDirectMethod, type MoteDirectMessage, type MoteDirectParamsMap, type MoteDirectPort, type MoteGroupCallContext,
  type MoteDirectResultMap, type MoteDirectThread, type MoteGroupMessage, type MoteGroupPort, type MoteGroupSummary } from '@agentmux/core'
import { renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteMainReader } from '@agentmux/core/mote-dialogue'
import { authorizeMoteConversationMain } from './mote-group.js'
import type { MoteGroupStore, MotePrivateReportOrigin } from './mote-group-store.js'
import type { AgentMuxRpcFileUploadsOwner, FileUploadIdentity } from '@agentmux/core/files'

function privateMessage({ groupId, author, event, privateImages, privatePriority, ...message }: MoteGroupMessage): MoteDirectMessage {
  if (author.kind !== 'mote' || event) throw new AgentMuxError('The original private message has no authenticated Mote author.', 'CONTROL_PROTOCOL_ERROR')
  return { ...message, author, threadId: groupId, ...(privateImages ? { images: privateImages.map(privateImageMetadata) } : {}),
    ...(privatePriority ? { priority: true } : {}) }
}

function privateThread(original: MoteGroupSummary): MoteDirectThread {
  return {
    id: original.id,
    participants: original.members.map(({ moteId, target, name, thread }) => ({ moteId, target, name, thread })),
    lastMessage: original.lastMessage ? privateMessage(original.lastMessage) : null
  }
}

const belongsTo = (thread: MoteGroupSummary, mote: MotePreferencesTarget) =>
  thread.members.some(member => sameMotePreferencesTarget(member.target, mote))

/** Only this port can address the two-participant conversation ledger. */
export function createHostMoteDirect(ledger: MoteGroupPort, owner: {
  main: MoteMainReader
  store: MoteGroupStore
  readPeer(target: MotePreferencesTarget): Promise<unknown>
  files?: Pick<AgentMuxRpcFileUploadsOwner, 'inspect' | 'read'>
  client: Pick<AgentMuxClient, 'readAgentSession' | 'enqueuePublishedMoteReport'> & {
    readMessage(input: { messageId: string }): Promise<AgentMuxMessageReadView | null>
  }
}): MoteDirectPort & { start(): void; dispose(): Promise<void>; dispatchWork(work: Extract<NonNullable<ContinuousProgressLoop['moteWork']>, { kind: 'direct' }>, body: string, operationId: string,
  assertCurrent: () => Promise<void>): Promise<{ conversationId: string; messageId: string }> } {
  const activeReports = new Map<string, Promise<MoteDirectMainNotification>>()
  const retryMs = 5000
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sweep: Promise<void> | undefined

  const notificationId = (threadId: string, replyId: string) =>
    'mote-private-report-' + createHash('sha256').update(JSON.stringify([threadId, replyId])).digest('hex')
  const unconfirmed = (messageId: string, error: unknown): MoteDirectMainNotification =>
    ({ messageId, status: 'unconfirmed', issue: error instanceof Error ? error.message : String(error) })

  async function notifyOriginalSender(origin: MotePrivateReportOrigin): Promise<MoteDirectMainNotification> {
    const { threadId, replyMessageId, senderSessionId, senderRunId } = origin
    const messageId = notificationId(threadId, replyMessageId)
    const reply = privateMessage(await owner.store.messageById(threadId, replyMessageId))
    const original = await owner.store.messageById(threadId, reply.replyToMessageId!)
    if (original.author.kind !== 'mote' || !original.deliveries.some(delivery => delivery.moteId === reply.author.moteId))
      throw new AgentMuxError('The original assignment and reporter are unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
    const { member } = await owner.store.member(threadId, original.author.moteId)
    const deliver = async () => {
      const existing = await owner.client.readMessage({ messageId })
      if (existing) {
        if (existing.deliveryMode !== 'reference' || existing.envelope.threadId !== threadId ||
            existing.envelope.senderSessionId !== senderSessionId || existing.envelope.senderRunId !== senderRunId ||
            existing.envelope.correlationId !== original.id)
          throw new AgentMuxError('The original Main notification belongs to another report.', 'CONTROL_PROTOCOL_ERROR')
        return existing
      }
      const main = await owner.main.readCurrentMoteMain(member.target)
      if (main.status !== 'ready' || main.identity?.moteId !== member.moteId || main.current?.hostId !== 'local')
        throw new AgentMuxError('The coordinating Mote has no confirmed local Main yet. Its report is saved.', 'CONTROL_UNAVAILABLE')
      const text = renderAmuxProtocol('mote-task', 'private-report', {
        original: JSON.stringify({ threadId, assignmentMessageId: original.id, replyMessageId, reporter: reply.author })
      })
      return await owner.client.enqueuePublishedMoteReport({ messageId, threadId, assignmentMessageId: original.id, replyMessageId,
        senderSessionId, senderRunId, recipientSessionId: main.current.sessionId, text, createdAt: reply.createdAt }, () => owner.main.assertCurrent(main))
    }
    const { delivery } = await (owner.main.withRole ? owner.main.withRole(member.target, deliver) : deliver())
    return { messageId,
      status: delivery.state === 'accepted' || delivery.state === 'replied' ? 'accepted'
        : delivery.state === 'failed' || delivery.state === 'cancelled' || delivery.state === 'timed-out' ? 'failed' : 'queued',
      ...(delivery.reason ? { issue: delivery.reason } : {}) }
  }

  function deliverReport(origin: MotePrivateReportOrigin): Promise<MoteDirectMainNotification> {
    const held = activeReports.get(origin.replyMessageId)
    if (held) return held
    const work = notifyOriginalSender(origin)
      .catch(error => unconfirmed(notificationId(origin.threadId, origin.replyMessageId), error))
      .then(async receipt => {
        // An uncertain mark only leaves the saved original eligible for another read.
        await owner.store.settlePrivateReport(origin.replyMessageId, receipt.status === 'unconfirmed' ? Date.now() + retryMs : null).catch(() => {})
        return receipt
      })
      .finally(() => { activeReports.delete(origin.replyMessageId) })
    activeReports.set(origin.replyMessageId, work)
    return work
  }

  function wakeReports(delay = 0): void {
    if (!running) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (sweep) { wakeReports(retryMs); return }
      sweep = (async () => {
        const { due } = await owner.store.nextPrivateReports(Date.now())
        if (running) await Promise.all(due.map(deliverReport))
        const { nextAt } = await owner.store.nextPrivateReports(Date.now())
        if (nextAt !== null) wakeReports(Math.max(0, nextAt - Date.now()))
      })().catch(() => wakeReports(retryMs)).finally(() => { sweep = undefined })
    }, delay)
    timer.unref?.()
  }

  async function retainImageSelection(groupId: string, operationId: string, images: FileUploadIdentity[] | undefined,
    context: MoteGroupCallContext): Promise<MoteGroupCallContext> {
    if (!images) return context
    const prior = await owner.store.messageOperation(groupId, operationId)
    if (prior) return { ...context, privateImages: images } // The original publication verifies the exact operation digest.
    const { actor } = context
    if (actor.kind !== 'agent' || images.some(image => image.hostId !== actor.hostId || image.agentSessionId !== actor.agentSessionId || image.expectedRun.runId !== actor.runId))
      throw new AgentMuxError('Only uploads from this original Agent Run can be selected for the private message.', 'CONTROL_PERMISSION_DENIED')
    await Promise.all(images.map(async image => {
      const receipt = await owner.files?.inspect(image)
      if (receipt?.status !== 'uploaded') throw new AgentMuxError('An original private image has not been confirmed. Keep the selection and message.', 'CONTROL_UNAVAILABLE')
    }))
    return { ...context, privateImages: images }
  }

  async function inspectPrivate(threadId: string, mote: MotePreferencesTarget | undefined, query: { messageId?: string; beforeSequence?: number; limit?: number },
    context: MoteGroupCallContext) {
    const result = await ledger.call('space.mote.group.inspect', { ...query, groupId: threadId,
      ...(context.actor.kind === 'agent' && mote ? { sourceMote: mote } : {}) }, context)
    if (mote && !belongsTo(result.group, mote))
      throw new AgentMuxError('The selected Mote does not participate in this private thread.', 'CONTROL_PERMISSION_DENIED')
    return result
  }

  async function sendPrivate(input: MoteDirectParamsMap['space.mote.direct.send'], context: MoteGroupCallContext) {
    const { mote, peer, images, priority, ...send } = input
    const members = [mote, peer].sort((left, right) => left.spaceId < right.spaceId ? -1 : 1)
    const pair = members.map(target => [target.expectedResource.hostId, target.spaceId])
    const threadId = 'mote-direct-' + createHash('sha256').update(JSON.stringify(pair)).digest('hex')
    await ledger.call('space.mote.group.create', { name: 'Private conversation', operationId: threadId, sourceMote: mote, members }, context)
    const selected = await retainImageSelection(threadId, send.operationId, images, context)
    const result = await ledger.call('space.mote.group.send', { ...send, groupId: threadId, sourceMote: mote, recipientIds: [peer.spaceId] },
      priority ? { ...selected, privatePriority: true } : selected)
    return { threadId, message: privateMessage(result.message) }
  }

  return {
    start() { running = true; wakeReports() },
    async dispose() {
      running = false
      clearTimeout(timer)
      await sweep
      await Promise.all(activeReports.values())
    },
    async dispatchWork(work, body, operationId, assertCurrent) {
      const selected = await owner.main.readCurrentMoteMain(work.mote)
      if (selected.status !== 'ready' || !selected.current || selected.identity?.moteId !== work.mote.spaceId)
        throw new AgentMuxError('The scheduled assignment is saved and awaiting its coordinating Main.', 'CONTROL_UNAVAILABLE')
      const session = await owner.client.readAgentSession(selected.current.sessionId)
      if (!session || session.hostId !== selected.current.hostId) throw new AgentMuxError('The coordinating Main Session is unconfirmed.', 'CONTROL_UNAVAILABLE')
      const { threadId, message } = await sendPrivate({ mote: work.mote, peer: work.peer, body, operationId }, { recoverPublication: true, actor: { kind: 'agent', hostId: session.hostId,
        agentSessionId: session.agentSessionId, runId: session.run.runId, sourceRuns: [] }, assertCurrent: async () => {
        await assertCurrent()
        await owner.main.assertCurrent(selected)
      } })
      return { conversationId: threadId, messageId: message.id }
    },
    async call<M extends MoteDirectMethod>(method: M, raw: MoteDirectParamsMap[M], context: MoteDirectCallContext): Promise<MoteDirectResultMap[M]> {
      const { actor } = context
      if (method === 'space.mote.direct.list') {
        const { mote, ...page } = raw as MoteDirectParamsMap['space.mote.direct.list']
        const result = await ledger.call('space.mote.group.list', { ...page, moteId: mote.spaceId,
          ...(actor.kind === 'agent' ? { sourceMote: mote } : {}) }, context)
        return { threads: result.groups.filter(thread => belongsTo(thread, mote)).map(privateThread),
          nextBeforeSequence: result.nextBeforeSequence } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.inspect') {
        const { threadId, mote, ...page } = raw as MoteDirectParamsMap['space.mote.direct.inspect']
        const result = await inspectPrivate(threadId, mote, page, context)
        return { thread: privateThread(result.group), messages: result.messages.map(privateMessage),
          nextBeforeSequence: result.nextBeforeSequence } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.image.read') {
        const { mote, ...image } = raw as MoteDirectParamsMap['space.mote.direct.image.read']
        const { messages } = await inspectPrivate(image.threadId, mote, { messageId: image.messageId }, context)
        const original = messages[0]?.privateImages?.find(entry => entry.operationId === image.imageOperationId)
        if (!original) throw new AgentMuxError('This private image does not belong to the original message.', 'CONTROL_PERMISSION_DENIED')
        const bytes = await owner.files?.read?.(original, original.byteLength)
        if (!bytes) throw new AgentMuxError('The original private image is temporarily unavailable. The message is retained.', 'CONTROL_UNAVAILABLE')
        await context.assertCurrent()
        return { ...image, image: privateImageMetadata(original), dataBase64: bytes.dataBase64 } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.reply') {
        const { threadId, images, ...reply } = raw as MoteDirectParamsMap['space.mote.direct.reply']
        const selected = await retainImageSelection(threadId, reply.operationId, images, context)
        const { message } = await ledger.call('space.mote.group.reply', { ...reply, groupId: threadId }, selected)
        const published = privateMessage(message)
        const origin = await owner.store.privateReport(message.id)
        wakeReports()
        const mainNotification = origin ? await deliverReport(origin) : unconfirmed(notificationId(threadId, message.id),
          'The original report predates Main notification. Its private reply is saved.')
        return { message: published, mainNotification } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.schedule') {
        const request = raw as MoteDirectParamsMap['space.mote.direct.schedule']
        const { mote, peer, operationId, body, ...timing } = request
        const main = await authorizeMoteConversationMain(owner.main, mote, context)
        await owner.readPeer(peer)
        const session = await owner.client.readAgentSession(main.reference.sessionId)
        if (!session || session.agentSessionId !== main.reference.sessionId || session.hostId !== main.reference.hostId)
          throw new AgentMuxError('The original Main schedule target is unconfirmed.', 'CONTROL_UNAVAILABLE')
        const { schedule: observed } = await context.readSchedule({ operationId })
        const original = observed?.creationOperationId === operationId ? observed : null
        if (original && !original.moteWork && !moteDirectScheduleSourceMatches(original.prompt, request))
          throw new AgentMuxError('The original private assignment differs from this retry.', 'SCHEDULE_OPERATION_CONFLICT')
        const source = original?.moteWork ? original : session
        const target = { hostId: source.hostId, agentSessionId: source.agentSessionId, providerId: source.providerId, workspacePath: source.workspacePath }
        const prompt = original?.moteWork ? body : original?.prompt ?? body
        const result = await main.commit(() => context.schedule({ ...timing, target, prompt, operationId,
          ...(source.inputEpoch ? { inputEpoch: source.inputEpoch } : {}) }, !original || original.moteWork ? { kind: 'direct', mote, peer } : undefined))
        return result as MoteDirectResultMap[M]
      }
      return await sendPrivate(raw as MoteDirectParamsMap['space.mote.direct.send'], context) as MoteDirectResultMap[M]
    }
  }
}

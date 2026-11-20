import { renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import { createHash } from 'node:crypto'
import { AgentMuxError, mintObjectId, type AgentInputSubmissionReceipt, type AgentMuxClient, type ContinuousProgressLoop,
  type MoteGroupCallContext, type MoteGroupDelivery, type MoteGroupMember, type MoteGroupMessage,
  type MoteGroupMethod, type MoteGroupParamsMap, type MoteGroupPort, type MoteGroupResultMap,
  type MoteGroupSummary } from '@agentmux/core'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { FileListParams, FileListResult, FileReadParams, FileReadResult } from '@agentmux/core/files'
import { parseFileListResult, parseFileReadResult } from '@agentmux/core/files'
import type { MoteMainReader } from '@agentmux/core/mote-dialogue'
import type { HostMoteChatAgents } from './mote-chat-agents.js'
import { groupFailure, groupMemberGeneration, groupStableId as stable, type GroupDeliveryRecord, type GroupInputKey, type GroupMemberRecord, type MoteGroupStore } from './mote-group-store.js'

type Core = Pick<AgentMuxClient, 'readAgentSession' | 'submitAgentPrompt' | 'inspectAgentInput' | 'rejoinAgentInputWaiting'>
type GroupAgent = Extract<MoteGroupCallContext['actor'], { kind: 'agent' }>
type EditMethod = 'space.mote.group.update' | 'space.mote.group.members.add' | 'space.mote.group.members.remove' | 'space.mote.group.members.leave'
type FileMethod = 'space.mote.group.file.list' | 'space.mote.group.file.read'
const digest = (value: unknown): string => {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => [key, canonical(member)]))
      : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
const accepted = (receipt: AgentInputSubmissionReceipt | null): boolean =>
  Boolean(receipt?.persistence === 'confirmed' && ['admitted', 'terminal-confirmed', 'launch-carried'].includes(receipt.status))
const currentIssue = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replaceAll('\0', '').slice(0, 4096) || 'The original member delivery is unconfirmed.'

function inputNote(thread: { kind: 'group' | 'direct'; id: string }, operationId: string,
  quoted: Pick<MoteGroupMessage, 'id' | 'body'> | undefined, author: MoteGroupMessage['author']): string {
  const direct = thread.kind === 'direct'
  return renderAmuxProtocol('mote-task', direct ? 'private-input' : 'group-input', {
    original: JSON.stringify({ [direct ? 'threadId' : 'groupId']: thread.id, inputOperationId: operationId,
      operationId: stable(direct ? 'direct-reply' : 'reply', thread.id, operationId), sender: author }),
    quote: quoted ? '\n\n' + renderAmuxProtocol('mote-task', 'thread-quote', {
      original: JSON.stringify({ messageId: quoted.id, body: quoted.body })
    }) : ''
  })
}

/** Built-in Group publications are explicit and never mirror a member's private output. */
export type HostMoteGroupFiles = {
  confirm(topic: MotePreferencesTarget): Promise<void>
  list(input: FileListParams & { spaceId: string }): Promise<FileListResult>
  read(input: FileReadParams & { spaceId: string }): Promise<FileReadResult>
}

const memberAuthority = (record: GroupMemberRecord) => ({
  moteId: record.member.moteId,
  generation: groupMemberGeneration(record)
})
function requireActive(record: GroupMemberRecord, generation = groupMemberGeneration(record)): void {
  if (record.member.state !== 'active' || groupMemberGeneration(record) !== generation)
    groupFailure('This Group membership no longer authorizes new Group actions.', 'CONTROL_PERMISSION_DENIED')
}

export async function authorizeMoteConversationMain(main: MoteMainReader | undefined, target: MotePreferencesTarget, context: MoteGroupCallContext) {
  const { actor } = context
  if (actor.kind !== 'agent')
    return groupFailure('Only the authenticated Mote Main can supply sourceMote.', 'CONTROL_PERMISSION_DENIED')
  if (!main) return groupFailure('The original Mote Main owner is unavailable.', 'CONTROL_UNAVAILABLE')
  const original = await main.readCurrentMoteMain(target)
  if (original.status !== 'ready')
    return groupFailure(original.issue ?? 'The original Mote Main is unconfirmed.', 'CONTROL_UNAVAILABLE')
  if (original.current?.hostId !== actor.hostId || original.current.sessionId !== actor.agentSessionId)
    return groupFailure('Use the Mote bound to your authenticated current Main.', 'CONTROL_PERMISSION_DENIED')
  const assertCurrent = async () => {
    await context.assertCurrent()
    await main.assertCurrent(original)
  }
  return { target, reference: original.current, assertCurrent, commit: <T>(work: () => Promise<T>) => {
    const apply = async () => { await assertCurrent(); return work() }
    return main.withRole ? main.withRole(target, apply) : apply()
  } }
}

export async function ownsMoteWork(main: MoteMainReader, client: Pick<AgentMuxClient, 'authorizeRetainedAgentCaller'>,
  work: NonNullable<ContinuousProgressLoop['moteWork']>, caller: { agentSessionId: string; capability: string }): Promise<boolean> {
  try {
    const selected = await main.readCurrentMoteMain(work.mote)
    if (selected.status !== 'ready' || selected.current?.sessionId !== caller.agentSessionId) return false
    const session = await client.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
    return selected.current.hostId === session.hostId && selected.identity?.moteId === work.mote.spaceId
  } catch { return false }
}

export function createHostMoteGroups(options: {
  store: MoteGroupStore
  agents: HostMoteChatAgents
  client(hostId: string): Core
  files?: HostMoteGroupFiles
  main?: MoteMainReader
}): MoteGroupPort & { dispatchWork(work: Extract<NonNullable<ContinuousProgressLoop['moteWork']>, { kind: 'group' }>, body: string, operationId: string,
  assertCurrent: () => Promise<void>): Promise<{ conversationId: string; messageId: string }> } {
  const { store, agents } = options
  const lanes = new Map<string, Promise<unknown>>()
  async function memberLane<T>(groupId: string, moteId: string, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([groupId, moteId])
    const previous = lanes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    lanes.set(key, current)
    try { return await current } finally { if (lanes.get(key) === current) lanes.delete(key) }
  }

  async function prepareMember(groupId: string, moteId: string, membership: string) {
    let record = await store.member(groupId, moteId)
    requireActive(record, membership)
    const { target } = record.member
    const hostId = target.expectedResource.hostId
    const generation = { target, executionHostId: hostId, agentSessionId: stable('agent', groupId, moteId),
      createOperationId: stable('create', groupId, moteId) }
    if (!record.prepared) {
      const variant = store.kind === 'direct' ? 'private-thread' : 'group-thread'
      const prepared = await agents.prepare({ generation, systemContext: renderAmuxProtocol('mote-task', variant, { groupId }) })
      record = { ...record, prepared }
      await store.saveMember(groupId, record)
    }
    const prepared = record.prepared!
    if (prepared.executionHostId !== hostId || prepared.input.agentSessionId !== generation.agentSessionId ||
        prepared.input.createOperationId !== generation.createOperationId) return groupFailure('The original Group member preparation belongs to another Session.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    if (!record.member.thread) {
      const existing = await agents.inspect(prepared)
      const created = existing ?? await agents.create(prepared)
      if (created.executionHostId !== hostId || created.agentSessionId !== generation.agentSessionId)
        return groupFailure('The original Group member Agent did not confirm its exact binding.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
      record = { ...record, member: { ...record.member, thread: { hostId, agentSessionId: created.agentSessionId } } }
      await store.saveMember(groupId, record)
    }
    const thread = record.member.thread!
    if (thread.hostId !== hostId || thread.agentSessionId !== generation.agentSessionId)
      return groupFailure('The retained Group member Agent binding is unconfirmed.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    requireActive(await store.member(groupId, moteId), membership)
    await agents.prepareInput(prepared)
    return thread
  }

  function receiptMatches(receipt: AgentInputSubmissionReceipt, key: GroupInputKey): boolean {
    return receipt.key.kind === 'prompt' && receipt.key.agentSessionId === key.agentSessionId &&
      receipt.key.expectedRun.runId === key.expectedRun.runId && receipt.key.submissionId === key.submissionId
  }

  function project(delivery: MoteGroupDelivery, receipt: AgentInputSubmissionReceipt | null): MoteGroupDelivery {
    const { issue: _, ...identity } = delivery
    if (accepted(receipt)) return { ...identity, status: 'accepted' }
    if (receipt?.persistence === 'confirmed' && (receipt.status === 'not-applied' || receipt.status === 'stopped'))
      return { ...identity, status: 'failed', issue: 'This original input was not applied. Retry only this member.' }
    if (receipt?.persistence === 'confirmed' && receipt.status === 'waiting') {
      if (receipt.observation === 'rejoin-needed') return { ...identity, status: 'failed', issue: 'The original input is saved and needs its waiting operation rejoined.' }
      return { ...identity, status: 'pending' }
    }
    return { ...identity, status: 'unknown', issue: 'The original input receipt is unconfirmed. Continue checking this member only.' }
  }

  async function readReceipt(groupId: string, record: GroupDeliveryRecord): Promise<AgentInputSubmissionReceipt | null> {
    const { key } = record
    if (!key) return null
    const { member } = await store.member(groupId, record.delivery.moteId)
    if (!member.thread || member.thread.agentSessionId !== key.agentSessionId || key.submissionId !== record.delivery.operationId)
      return groupFailure('The original Group delivery no longer matches its member.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    const receipt = await options.client(member.thread.hostId).inspectAgentInput({ key })
    if (receipt && !receiptMatches(receipt, key)) return groupFailure('The Group received a foreign Core receipt.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    return receipt
  }

  function inputAuthority(groupId: string, moteId: string, generation: string) {
    const assertCurrent = async () => requireActive(await store.member(groupId, moteId), generation)
    return { assertCurrent, retainAcceptedInputAuthority: async () => ({ assertCurrent, release() {} }) }
  }

  async function groupSession(thread: NonNullable<MoteGroupMember['thread']>) {
    const session = await options.client(thread.hostId).readAgentSession(thread.agentSessionId)
    if (!session || session.agentSessionId !== thread.agentSessionId || session.hostId !== 'local' && session.hostId !== thread.hostId)
      return groupFailure('The original Group member Run is unconfirmed.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    return session
  }

  // The invitation belongs to one membership generation. Keep it saved when
  // there is no Group Thread. The next addressed input can use that exact Thread.
  async function deliverInvitation(groupId: string, moteId: string, generation: string, thread: NonNullable<MoteGroupMember['thread']>) {
    const membership = await store.member(groupId, moteId)
    requireActive(membership, generation)
    const invitation = membership.invitation
    if (!invitation || invitation.input?.delivery.status === 'accepted') return
    let record = invitation.input
    if (!record?.key) {
      const session = await groupSession(thread)
      const key: GroupInputKey = { kind: 'prompt', agentSessionId: thread.agentSessionId, expectedRun: session.run, submissionId: invitation.operationId }
      const note = renderAmuxProtocol('mote-task', 'group-invitation', {
        announcement: JSON.stringify({ groupId, moteId, invitationOperationId: invitation.operationId, announcement: invitation.announcement })
      })
      record = { key, note, memberGeneration: generation,
        delivery: { moteId, operationId: invitation.operationId, status: 'pending' },
        ...(session.inputEpoch ? { inputEpoch: session.inputEpoch } : {}) }
      await store.saveInvitation(groupId, record)
    }
    const key = record.key!
    const prior = await readReceipt(groupId, record)
    const client = options.client(thread.hostId)
    const authority = inputAuthority(groupId, moteId, generation)
    const result = prior?.persistence === 'confirmed' && prior.continuation !== undefined
      ? await client.rejoinAgentInputWaiting({ ref: prior.ref }, authority)
      : prior ?? await client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun,
          operationId: key.submissionId, prompt: '', agentMuxNote: record.note!, admissionIntent: { kind: 'session-conversation' },
          execution: 'immediate', ...(record.inputEpoch ? { inputEpoch: record.inputEpoch } : {}) }, authority)
    const receipt = result && 'control' in result ? result : await readReceipt(groupId, record)
    if (receipt && !receiptMatches(receipt, key)) return groupFailure('The original invitation got another Core input receipt.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
    await store.saveInvitation(groupId, { ...record, delivery: project(record.delivery, receipt) })
  }

  async function advanceInvitation(groupId: string, moteId: string, generation: string, thread: NonNullable<MoteGroupMember['thread']>) {
    try { await deliverInvitation(groupId, moteId, generation, thread) }
    catch (error) {
      // Recording an invitation failure is independent of the addressed input.
      await store.noteInvitationIssue(groupId, moteId, generation, currentIssue(error)).catch(() => {})
    }
  }

  async function freshDelivery(message: MoteGroupMessage, moteId: string, retry: boolean): Promise<MoteGroupDelivery> {
    return memberLane(message.groupId, moteId, async () => {
      let record = await store.delivery(message.groupId, message.id, moteId)
      if (!record) return groupFailure('This message did not invite that original Group member.', 'UNKNOWN_MOTE_GROUP_DELIVERY')
      if (record.delivery.status === 'accepted') return record.delivery
      try {
        const generation = record.memberGeneration ?? 'original'
        const membership = await store.member(message.groupId, moteId)
        requireActive(membership, generation)
        if (record.key) {
          if (retry && membership.member.thread) await advanceInvitation(message.groupId, moteId, generation, membership.member.thread)
          const receipt = await readReceipt(message.groupId, record)
          if (receipt) {
            const { member } = await store.member(message.groupId, moteId)
            if (retry && receipt.persistence === 'confirmed' && (
                receipt.status === 'not-applied' || receipt.status === 'stopped' || receipt.continuation !== undefined)) {
              requireActive(await store.member(message.groupId, moteId), generation)
              const joined = await options.client(member.thread!.hostId).rejoinAgentInputWaiting({ ref: receipt.ref }, inputAuthority(message.groupId, moteId, generation))
              if (!receiptMatches(joined, record.key)) return groupFailure('The original Group input continuation returned another receipt.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
              record = { ...record, delivery: project(record.delivery, joined) }
            } else record = { ...record, delivery: project(record.delivery, receipt) }
            await store.saveDelivery(message.id, record)
            return record.delivery
          }
          // The original identity remains frozen. An explicit retry may rejoin that
          // same key through Core, whose journal independently prevents reapplication.
          if (!retry) return project(record.delivery, null)
        }
        const thread = record.key ? (await store.member(message.groupId, moteId)).member.thread! : await prepareMember(message.groupId, moteId, generation)
        const client = options.client(thread.hostId)
        if (!record.key) {
          // The invitation remains independently queued or recoverable. An
          // unconfirmed notice does not take away ordinary addressed input.
          await advanceInvitation(message.groupId, moteId, generation, thread)
          const session = await groupSession(thread)
          const key: GroupInputKey = { kind: 'prompt', agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: record.delivery.operationId }
          const quoted = message.replyToMessageId ? await store.messageById(message.groupId, message.replyToMessageId) : undefined
          const note = inputNote({ kind: store.kind, id: message.groupId }, key.submissionId, quoted, message.author)
          record = { ...record, key, note,
            ...(session.inputEpoch ? { inputEpoch: session.inputEpoch } : {}) }
          await store.saveDelivery(message.id, record)
        }
        const key = record.key!, note = record.note
        if (!note) return groupFailure('The original Group input context is unconfirmed.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
        requireActive(await store.member(message.groupId, moteId), generation)
        const result = await client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun,
          operationId: key.submissionId, prompt: message.body, agentMuxNote: note,
          admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: message.author.kind === 'human',
          ...(record.inputEpoch ? { inputEpoch: record.inputEpoch } : {}) }, inputAuthority(message.groupId, moteId, generation))
        const receipt = result && 'control' in result ? result : await readReceipt(message.groupId, record)
        if (receipt && !receiptMatches(receipt, key)) return groupFailure('The Group received a foreign Core receipt.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
        record = { ...record, delivery: project(record.delivery, receipt) }
        await store.saveDelivery(message.id, record)
        return record.delivery
      } catch (error) {
        const status = !record.key || error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied' ? 'failed' : 'unknown'
        const delivery = { ...record.delivery, status, issue: currentIssue(error) } satisfies MoteGroupDelivery
        await store.saveDelivery(message.id, { ...record, delivery })
        return delivery
      }
    })
  }

  async function readMessage(message: MoteGroupMessage): Promise<MoteGroupMessage> {
    if (!message.deliveries.some(delivery => delivery.status === 'pending' || delivery.status === 'unknown')) return message
    const deliveries = await Promise.all(message.deliveries.map(async delivery => {
      if (delivery.status === 'accepted' || delivery.status === 'failed') return delivery
      try {
        const record = await store.delivery(message.groupId, message.id, delivery.moteId)
        if (!record?.key) return delivery
        const receipt = await readReceipt(message.groupId, record)
        return receipt ? project(delivery, receipt) : delivery
      } catch { return project(delivery, null) }
    }))
    return { ...message, deliveries }
  }

  async function observeInvitation(groupId: string, member: MoteGroupMember): Promise<MoteGroupMember> {
    const invitation = member.invitation
    if (!invitation || invitation.status === 'accepted' || !member.thread) return member
    try {
      const record = (await store.member(groupId, member.moteId)).invitation?.input
      if (record?.delivery.operationId !== invitation.operationId || !record.key) return member
      const receipt = await readReceipt(groupId, record)
      return receipt ? { ...member, invitation: project(invitation, receipt) } : member
    } catch { return { ...member, invitation: project(invitation, null) } }
  }

  async function readSummary(group: MoteGroupSummary, observedLast?: MoteGroupMessage): Promise<MoteGroupSummary> {
    const [lastMessage, members] = await Promise.all([
      observedLast ?? (group.lastMessage ? readMessage(group.lastMessage) : null),
      Promise.all(group.members.map(member => observeInvitation(group.id, member)))
    ])
    return { ...group, lastMessage, members }
  }

  async function addressedSource(actor: GroupAgent, groupId: string, inputOperationId: string) {
    const source = await store.byInput(groupId, inputOperationId)
    if (!source?.record.key || source.record.key.agentSessionId !== actor.agentSessionId)
      return groupFailure('Use an addressed input sent to your own Group Thread.', 'CONTROL_PERMISSION_DENIED')
    const membership = await store.memberForThread(groupId, actor.hostId, actor.agentSessionId)
    if (membership.member.moteId !== source.record.delivery.moteId)
      return groupFailure('Use an addressed input sent to your own Group Thread.', 'CONTROL_PERMISSION_DENIED')
    return { ...source, key: source.record.key, membership }
  }

  async function confirmedAddressedInput(actor: GroupAgent, groupId: string, source: Awaited<ReturnType<typeof addressedSource>>) {
    requireActive(source.membership, source.record.memberGeneration ?? 'original')
    if (!actor.sourceRuns.includes(source.key.expectedRun.runId))
      return groupFailure('This input does not belong to the original Group Thread continuity.', 'CONTROL_PERMISSION_DENIED')
    const original = await store.messageById(groupId, source.messageId)
    const receipt = await readReceipt(groupId, source.record)
    const fact = receipt?.admission?.admission?.intent?.message ?? receipt?.admission?.launch?.message
    if (!accepted(receipt) || fact?.userContent !== original.body || !source.record.note || fact.systemContext !== source.record.note)
      return groupFailure('Core has not confirmed this original Group input. Inspect the original delivery.', 'MOTE_GROUP_SOURCE_UNCONFIRMED')
    return original
  }

  async function publish(input: MoteGroupParamsMap['space.mote.group.reply'], actor: GroupAgent, assertCurrent: () => Promise<void>) {
    const source = await addressedSource(actor, input.groupId, input.inputOperationId)
    const { member } = source.membership
    const prior = await store.messageOperation(input.groupId, input.operationId)
    if (prior) {
      const { author } = prior.message
      if (author.kind !== 'mote' || author.moteId !== member.moteId || prior.digest !== digest({ input, author }))
        return groupFailure('This Group operation already has another original message.', 'MOTE_GROUP_OPERATION_CONFLICT')
      await assertCurrent()
      return prior.message
    }
    const original = await confirmedAddressedInput(actor, input.groupId, source)
    await assertCurrent()
    const author = { kind: 'mote' as const, moteId: member.moteId, name: member.name }
    return (await store.append(input.operationId, digest({ input, author }), { id: mintObjectId(), groupId: input.groupId,
      createdAt: Date.now(), body: input.body, author, replyToMessageId: original.id }, [], memberAuthority(source.membership),
      store.kind === 'direct' ? { senderSessionId: actor.agentSessionId, senderRunId: actor.runId } : undefined)).message
  }

  async function memberFromTarget(target: MotePreferencesTarget): Promise<MoteGroupMember> {
    return { moteId: target.spaceId, name: (await agents.readTarget(target)).name, target, thread: null, role: 'member', state: 'active' }
  }

  async function mainMembership(groupId: string, target: MotePreferencesTarget) {
    const record = await store.member(groupId, target.spaceId)
    if (!sameMotePreferencesTarget(record.member.target, target))
      return groupFailure('This Group membership belongs to a different Mote target.', 'CONTROL_PERMISSION_DENIED')
    requireActive(record)
    return record
  }

  function filesOwner() {
    return options.files ?? groupFailure('The original Topic Files owner is unavailable. The Group and its saved binding are retained.', 'CONTROL_UNAVAILABLE')
  }

  async function edit(method: EditMethod, raw: MoteGroupParamsMap[EditMethod], context: MoteGroupCallContext) {
    const { actor } = context
    const { groupId, operationId, expectedRevision } = raw
    const digestActor = actor.kind === 'agent' ? { kind: actor.kind, hostId: actor.hostId, agentSessionId: actor.agentSessionId } : actor
    const hash = digest({ method, input: raw, actor: digestActor })
    const prior = await store.modified(groupId, operationId, hash)
    if (prior) return { group: prior }
    const membership = actor.kind === 'agent' ? await store.memberForThread(groupId, actor.hostId, actor.agentSessionId) : undefined
    if (membership) {
      requireActive(membership)
      if (method !== 'space.mote.group.members.leave' && membership.member.role !== 'admin' ||
          method === 'space.mote.group.update' && (raw as MoteGroupParamsMap[typeof method]).adminMoteIds !== undefined)
        return groupFailure('This Group action requires its current administrator or workspace owner.', 'CONTROL_PERMISSION_DENIED')
    }
    let change: Parameters<MoteGroupStore['modify']>[4]
    if (method === 'space.mote.group.update') {
      const { avatarMoteIds, announcement, topic, adminMoteIds } = raw as MoteGroupParamsMap[typeof method]
      if (topic) await filesOwner().confirm(topic)
      change = { kind: 'settings', settings: { ...(avatarMoteIds !== undefined ? { avatarMoteIds } : {}),
        ...(announcement !== undefined ? { announcement } : {}), ...(topic !== undefined ? { topic } : {}),
        ...(adminMoteIds !== undefined ? { adminMoteIds } : {}) } }
    } else if (method === 'space.mote.group.members.add') {
      const members = await Promise.all((raw as MoteGroupParamsMap[typeof method]).members.map(memberFromTarget))
      change = { kind: 'invite', members }
    } else if (method === 'space.mote.group.members.remove') {
      change = { kind: 'remove', moteIds: (raw as MoteGroupParamsMap[typeof method]).memberIds }
    } else change = { kind: 'leave' }
    await context.assertCurrent()
    return { group: await store.modify(groupId, operationId, expectedRevision, hash, change, membership && memberAuthority(membership)) }
  }

  async function groupFile(method: FileMethod, input: MoteGroupParamsMap[FileMethod], context: MoteGroupCallContext) {
    const { actor } = context
    let authority: ReturnType<typeof memberAuthority> | undefined
    if (actor.kind === 'agent') {
      if (!input.inputOperationId)
        return groupFailure('Use the inputOperationId from the message addressed to your Group Thread.', 'CONTROL_PERMISSION_DENIED')
      const source = await addressedSource(actor, input.groupId, input.inputOperationId)
      await confirmedAddressedInput(actor, input.groupId, source)
      authority = memberAuthority(source.membership)
    }
    const owner = filesOwner()
    const observeBinding = async () => {
      await context.assertCurrent()
      if (authority) requireActive(await store.member(input.groupId, authority.moteId), authority.generation)
      return store.boundTopic(input.groupId)
    }
    const topic = await observeBinding()
    if (!topic) return groupFailure('This Group has no confirmed Topic binding.', 'MOTE_GROUP_TOPIC_UNBOUND')
    const params = { ...topic, path: input.path ?? '.' }
    let result: FileListResult | FileReadResult
    if (method === 'space.mote.group.file.list') {
      const { limit } = input as MoteGroupParamsMap[typeof method]
      const list = { ...params, mode: 'directory' as const, ...(limit !== undefined ? { limit } : {}) }
      result = parseFileListResult(await owner.list(list), list)
    } else {
      const { maxBytes } = input as MoteGroupParamsMap[typeof method]
      const read = { ...params, maxBytes: maxBytes ?? 256 * 1024 }
      result = parseFileReadResult(await owner.read(read), read)
    }
    const current = await observeBinding()
    if (!current || !sameMotePreferencesTarget(current, topic))
      return groupFailure('The Topic binding changed during the read. Inspect the Group before requesting another file.', 'MOTE_GROUP_TOPIC_CHANGED')
    return result
  }

  return {
    async dispatchWork(work, body, operationId, assertCurrent) {
      const main = options.main
      const selected = await main?.readCurrentMoteMain(work.mote)
      if (!main || selected?.status !== 'ready' || !selected.current || selected.identity?.moteId !== work.mote.spaceId)
        return groupFailure('The scheduled assignment is saved and awaiting its coordinating Main.', 'CONTROL_UNAVAILABLE')
      const session = await groupSession({ agentSessionId: selected.current.sessionId, hostId: selected.current.hostId })
      const { message } = await this.call('space.mote.group.send', { groupId: work.groupId, body, operationId, sourceMote: work.mote,
        recipientIds: work.recipients.map(member => member.moteId) }, { actor: { kind: 'agent', hostId: selected.current.hostId,
        agentSessionId: session.agentSessionId, runId: session.run.runId, sourceRuns: [] }, scheduledRecipients: work.recipients,
        assertCurrent: async () => { await assertCurrent(); await main.assertCurrent(selected) } })
      return { conversationId: work.groupId, messageId: message.id }
    },
    async call<M extends MoteGroupMethod>(method: M, raw: MoteGroupParamsMap[M], context: MoteGroupCallContext): Promise<MoteGroupResultMap[M]> {
      await context.assertCurrent()
      const { actor } = context
      if (method === 'space.mote.group.reply') {
        if (actor.kind !== 'agent') return groupFailure('A Group reply requires its original member Agent.', 'CONTROL_PERMISSION_DENIED')
        return { message: await publish(raw as MoteGroupParamsMap['space.mote.group.reply'], actor, context.assertCurrent) } as MoteGroupResultMap[M]
      }
      if (method === 'space.mote.group.update' || method === 'space.mote.group.members.add' ||
          method === 'space.mote.group.members.remove' || method === 'space.mote.group.members.leave')
        return await edit(method, raw as MoteGroupParamsMap[EditMethod], context) as MoteGroupResultMap[M]
      if (method === 'space.mote.group.file.list' || method === 'space.mote.group.file.read')
        return await groupFile(method, raw as MoteGroupParamsMap[FileMethod], context) as MoteGroupResultMap[M]
      const sourceMote = 'sourceMote' in raw ? raw.sourceMote : undefined
      const main = sourceMote ? await authorizeMoteConversationMain(options.main, sourceMote, context) : undefined
      if (actor.kind === 'agent' && !main && method !== 'space.mote.group.inspect' && method !== 'space.mote.group.send')
        return groupFailure('Use sourceMote from your current Main, or the commands available from your Group Thread.', 'CONTROL_PERMISSION_DENIED')
      if (method === 'space.mote.group.list') {
        const input = raw as MoteGroupParamsMap['space.mote.group.list']
        if (main && input.moteId !== undefined && input.moteId !== main.target.spaceId)
          return groupFailure('A Mote Main can only list its own Groups.', 'CONTROL_PERMISSION_DENIED')
        const page = await store.list(main?.target.spaceId ?? input.moteId, input.beforeSequence ?? Number.MAX_SAFE_INTEGER, input.limit ?? 20)
        const groups = await Promise.all(page.groups.map(group => readSummary(group)))
        await main?.assertCurrent()
        return { ...page, groups } as MoteGroupResultMap[M]
      }
      if (method === 'space.mote.group.inspect') {
        const input = raw as MoteGroupParamsMap['space.mote.group.inspect']
        const membership = main ? await mainMembership(input.groupId, main.target)
          : actor.kind === 'agent' ? await store.memberForThread(input.groupId, actor.hostId, actor.agentSessionId) : undefined
        if (membership) requireActive(membership)
        const page = await store.inspect(input.groupId, input.beforeSequence ?? Number.MAX_SAFE_INTEGER, input.limit ?? 30, input.messageId)
        const messages = await Promise.all(page.messages.map(readMessage))
        const group = await readSummary(page.group, messages.find(message => message.id === page.group.lastMessage?.id))
        await context.assertCurrent()
        await main?.assertCurrent()
        if (membership) requireActive(await store.member(input.groupId, membership.member.moteId), groupMemberGeneration(membership))
        const viewerId = actor.kind === 'human' ? actor.id : membership!.member.moteId
        return { group, messages, nextBeforeSequence: page.nextBeforeSequence, viewerId } as MoteGroupResultMap[M]
      }
      if (method === 'space.mote.group.create') {
        const input = raw as MoteGroupParamsMap['space.mote.group.create']
        const direct = store.kind === 'direct'
        const hash = direct ? digest(input.members) : digest({ input, actor: main ? { kind: 'mote', moteId: main.target.spaceId } : actor })
        const existing = await store.created(input.operationId, hash)
        if (existing) {
          if (main) { await mainMembership(existing.id, main.target); await main.assertCurrent() }
          return { group: existing } as MoteGroupResultMap[M]
        }
        const targets = [...input.members]
        if (main) {
          const listed = targets.find(target => target.spaceId === main.target.spaceId)
          if (listed && !sameMotePreferencesTarget(listed, main.target))
            return groupFailure('The creator and member entries must refer to the same Mote target.', 'INVALID_CONTROL_REQUEST')
          if (!listed) targets.unshift(main.target)
        }
        const members = await Promise.all(targets.map(memberFromTarget))
        if (input.topic) await filesOwner().confirm(input.topic)
        const settings = main && !direct ? { ...input, adminMoteIds: [...new Set([main.target.spaceId, ...(input.adminMoteIds ?? [])])] } : input
        const create = () => store.create(direct ? input.operationId : mintObjectId(), input.operationId, hash, input.name, members, settings)
        await context.assertCurrent()
        return { group: await (main ? main.commit(create) : create()) } as MoteGroupResultMap[M]
      }
      if (method === 'space.mote.group.retry') {
        const input = raw as MoteGroupParamsMap['space.mote.group.retry']
        const message = await store.messageById(input.groupId, input.messageId)
        await context.assertCurrent()
        return { delivery: await freshDelivery(message, input.memberId, true) } as MoteGroupResultMap[M]
      }
      if (method === 'space.mote.group.schedule') {
        const { sourceMote: mote, groupId, recipientIds, body, operationId, ...timing } = raw as MoteGroupParamsMap['space.mote.group.schedule']
        const { schedule, readSchedule } = context
        if (!main || !schedule || !readSchedule || store.kind !== 'group')
          return groupFailure('The original Group arrangement owner is unavailable.', 'CONTROL_UNAVAILABLE')
        const coordinatingMember = await mainMembership(groupId, mote)
        requireActive(coordinatingMember)
        const { schedule: original } = await readSchedule({ operationId })
        const retained = original?.creationOperationId === operationId ? original : undefined
        const stored = retained?.moteWork
        if (retained && (stored?.kind !== 'group' || stored.groupId !== groupId || !sameMotePreferencesTarget(stored.mote, mote) ||
            stored.recipients.length !== recipientIds.length || !stored.recipients.every((entry, index) => entry.moteId === recipientIds[index])))
          return groupFailure('The original Group assignment differs from this retry.', 'SCHEDULE_OPERATION_CONFLICT')
        const recipients = stored?.kind === 'group' ? stored.recipients : await Promise.all(recipientIds.map(async moteId => {
          const record = await store.member(groupId, moteId)
          requireActive(record)
          return { moteId, generation: groupMemberGeneration(record) }
        }))
        const target = retained ?? await groupSession({ hostId: main.reference.hostId, agentSessionId: main.reference.sessionId })
        return await main.commit(() => schedule({ ...timing, prompt: body, operationId,
          target: { hostId: target.hostId, agentSessionId: target.agentSessionId, providerId: target.providerId, workspacePath: target.workspacePath },
          ...(target.inputEpoch ? { inputEpoch: target.inputEpoch } : {}) }, { kind: 'group', mote, groupId, recipients })) as MoteGroupResultMap[M]
      }
      const input = raw as MoteGroupParamsMap['space.mote.group.send']
      let membership = main ? await mainMembership(input.groupId, main.target) : undefined
      if (input.memberMoteId !== undefined) {
        if (actor.kind !== 'agent')
          return groupFailure('Publishing as a Group member requires its authenticated Thread.', 'CONTROL_PERMISSION_DENIED')
        membership = await store.memberForThread(input.groupId, actor.hostId, actor.agentSessionId)
        if (membership.member.moteId !== input.memberMoteId)
          return groupFailure('The authenticated Thread belongs to another Group member.', 'CONTROL_PERMISSION_DENIED')
        if (input.recipientIds.includes(input.memberMoteId))
          return groupFailure('Select other Group members for this handoff.', 'INVALID_CONTROL_REQUEST')
      }
      const author = membership ? { kind: 'mote' as const, moteId: membership.member.moteId, name: membership.member.name }
        : actor.kind === 'human' ? actor : groupFailure('Supply sourceMote from your current Main or memberMoteId from your Group Thread.', 'CONTROL_PERMISSION_DENIED')
      const id = stable('message', input.groupId, input.operationId)
      const recipients = input.recipientIds.map(moteId => ({ moteId, operationId: stable('input', input.groupId, id, moteId), status: 'pending' as const }))
      const generations = context.scheduledRecipients ? new Map(context.scheduledRecipients.map(({ moteId, generation }) => [moteId, generation])) : undefined
      const hash = digest({ input, actor: membership ? { kind: 'mote', moteId: membership.member.moteId } : actor,
        ...(context.scheduledRecipients ? { recipients: context.scheduledRecipients } : {}) })
      const append = () => store.append(input.operationId, hash, { id, groupId: input.groupId,
        createdAt: Date.now(), body: input.body, author, ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) },
      recipients, membership && memberAuthority(membership), undefined, generations)
      if (!main) await context.assertCurrent()
      const { message, fresh } = await (main ? main.commit(append) : append())
      if (!fresh) return { message: await readMessage(message) } as MoteGroupResultMap[M]
      // The public message has been committed once. One failing member cannot stop other recipients.
      const deliveries = await Promise.allSettled(message.deliveries.map(delivery => freshDelivery(message, delivery.moteId, false)))
      return { message: { ...message, deliveries: deliveries.map((result, index) => result.status === 'fulfilled' ? result.value
        : { ...message.deliveries[index]!, status: 'unknown', issue: currentIssue(result.reason) }) } } as MoteGroupResultMap[M]
    }
  }
}

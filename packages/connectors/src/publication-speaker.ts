import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { conversationInputKey, conversationRecordAuthor, type ConversationRef, type ConversationUnit } from '@agentmux/core/conversation'
import type { MoteChatTarget } from '@agentmux/core/mote-chat'
import type { MoteAvatarTarget } from '@agentmux/core/mote-avatar-write'
import type { PublicationImage } from './publication-resource.js'

/** Display snapshot only. Original authors/references continue to own attribution and authority. */
export type PublicationSpeaker = {
  kind: 'agent' | 'human' | 'external' | 'mixed' | 'unknown'
  name?: string
  nameRevision?: number
  reference?: ConversationRef
  mote?: MoteChatTarget
  avatar?: {
    /** Exact original resource: human Input, Mote target, or Agent artwork reference. */
    input?: import('@agentmux/core').AgentPromptInputKey
    target?: MoteAvatarTarget
    revision?: string
    observation: 'available' | 'unavailable' | 'changed'
    code?: string
    image?: PublicationImage
  }
}
export type PublicationSpeakerDetails = Pick<PublicationSpeaker, 'name' | 'nameRevision' | 'mote' | 'avatar'>
export type PublicationSpeakerReader = (reference: ConversationRef, signal: AbortSignal, mote?: MoteChatTarget) => Promise<PublicationSpeakerDetails>

/** The accepted Core author selects a role. Text, recipient, profile and current focus never do. */
export function publicationSpeaker(unit: ConversationUnit, reference: ConversationRef): PublicationSpeaker {
  const author = unit.event.author
  if (author.kind === 'agent') return { kind: 'agent', reference: { ...reference, agentSessionId: author.agentSessionId } }
  if (author.kind === 'human') {
    const profiles = unit.records.flatMap(record => isCompleteConversationRecord(record) && record.original.kind === 'captured' &&
      conversationRecordAuthor(record, reference.agentSessionId).kind === 'human' && conversationInputKey(record) &&
      record.original.item.authorProfile && record.original.item.inputRef
      ? [{ profile: record.original.item.authorProfile, input: record.original.item.inputRef }] : [])
    const distinct = new Set(profiles.map(value => JSON.stringify(value.profile)))
    const original = distinct.size === 1 ? profiles[0] : undefined
    return { kind: 'human', ...(original?.profile.name ? { name: original.profile.name } : {}),
      ...(original?.profile.avatar ? { avatar: { input: original.input, revision: original.profile.avatar.revision, observation: 'unavailable' as const } } : {}) }
  }
  if (author.kind === 'external') return { kind: 'external' }

  const originals = new Set(unit.records.filter(isCompleteConversationRecord).map(record => conversationRecordAuthor(record, reference.agentSessionId))
    .filter(value => value.kind !== 'unknown' && value.kind !== 'system').map(value => JSON.stringify(value)))
  return { kind: originals.size > 1 ? 'mixed' : 'unknown' }
}

import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { conversationRecordAuthor, type ConversationRef, type ConversationUnit } from '@agentmux/core/conversation'
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
    target: MoteAvatarTarget
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
  if (author.kind === 'human' || author.kind === 'external') return { kind: author.kind }
  const originals = new Set(unit.records.filter(isCompleteConversationRecord).map(record => conversationRecordAuthor(record, reference.agentSessionId))
    .filter(value => value.kind !== 'unknown' && value.kind !== 'system').map(value => JSON.stringify(value)))
  return { kind: originals.size > 1 ? 'mixed' : 'unknown' }
}

import type { MoteChatReplyReference } from './mote-chat-contract.js'
import { sameConnectionApplication } from './connections-contract.js'
import type { AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { renderAgentMuxMessageEnvelope, channelQuoteWireMatchesEnvelope, parseAgentMuxMessagePrefix } from './agent-message-render.js'
import { composeOutboundMessage } from './agent-outbound-message.js'
import { DOMParser, onWarningStopParsing } from '@xmldom/xmldom'
import { channelTranscriptQuoteJson } from './channel-quote.js'
import { AGENTMUX_CHANNEL_INSTANT_REPLY } from './agent-messaging-guidance.js'
import type { ConnectionIngressMessage } from './ingress-contract.js'

/** A presentation choice for one original input, not another delivery or message. */
export type AgentMessageInputRepresentation = {
  body: 'inline' | 'reference'
  quote: 'absent' | 'inline' | 'reference'
  /** Frozen platform guidance; a future guide must not change an old input. */
  reminder: string
}

// This bounds unsolicited model context, never the retained message or its readability.
const INLINE_MESSAGE_BYTES = 16 * 1024
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength
// The adapter's typed conversation kind selects the reply note; an absent or unknown kind adds none.
const CONVERSATION_NOTE: Readonly<Record<string, string>> = {
  direct: 'This message came from a direct chat with one person.',
  group: 'This message came from a group chat; everyone there can read your replies, so keep unrelated private material out.'
}

function reminder(envelope: AgentMuxMessageEnvelope, body: AgentMessageInputRepresentation['body'], quote: AgentMessageInputRepresentation['quote'],
  conversationKind?: ConnectionIngressMessage['conversationKind'], moteReply?: MoteChatReplyReference): string {
  const note = conversationKind === undefined ? undefined : CONVERSATION_NOTE[conversationKind]
  const quotedId = "'" + envelope.messageId.replaceAll("'", "'\"'\"'") + "'"
  const read = (field: string) => `"$AGENTMUX_CLI" message read --message-id ${quotedId} --field ${field}`
  return [
    `Original message MID: ${envelope.messageId}.`,
    body === 'reference' ? `The original request body is retained, not included here. Read it before acting: ${read('body')}.` : undefined,
    quote === 'reference' ? `Earlier channel context is retained separately. Read it only when needed: ${read('channelQuote')}.` : undefined,
    body === 'reference' || quote === 'reference' ? 'Use message --skill and message read --help for bounded continuation. References and reads are not Inbox acknowledgements or task acceptance.' : undefined,
    note, moteReply?.route === 'unconfirmed' ? `Original connector ingress: ${moteReply.ingressId}. The reply route from this execution endpoint to the original Connector owner is unconfirmed. Keep this original reference; do not guess another owner or recipient. Main input remains available. This reply operation publishes only the supplied body and creates no ordinary Main publication.` : moteReply ? `Reply to this exact private message with \"$AGENTMUX_CLI\" space mote chat reply --input - and JSON ${JSON.stringify({ operationId: 'CHOOSE_ONE_STABLE_OPERATION_ID', ingressId: moteReply.ingressId, body: 'YOUR_REPLY' })}. Keep the same operationId after an unknown result; read it with space mote chat inspect --input - and JSON {\"operationId\":\"YOUR_OPERATION_ID\"}. This explicit operation sends only the supplied reply to the original person. This reply operation publishes only the supplied body and creates no ordinary Main publication.` : note === undefined ? undefined : AGENTMUX_CHANNEL_INSTANT_REPLY,
    moteReply ? undefined : 'For reactions, read connection --skill and use this Session’s original bound identity and the original platform message ID. The connector manages waiting and input-delivered markers; choose any processing or result reaction yourself within the task’s authorization.'
  ].filter(Boolean).join('\n')
}

/** Reconstruct only the explicitly frozen selection and guidance, never current budgets. */
export function renderMessageInputRepresentation(envelope: AgentMuxMessageEnvelope, representation: AgentMessageInputRepresentation): string {
  const { channelQuote, ...current } = envelope
  const content = representation.body === 'inline' ? renderAgentMuxMessageEnvelope({ ...current,
    ...(representation.quote === 'inline' && channelQuote ? { channelQuote } : {}) }) : undefined
  return composeOutboundMessage({ amux: representation.reminder, ...(content === undefined ? {} : { user: content }) })
}

/** Only called for a newly accepted external message. Existing input recipes stay original. */
export function prepareMessageInputRepresentation(envelope: AgentMuxMessageEnvelope, conversationKind?: ConnectionIngressMessage['conversationKind'], moteReply?: MoteChatReplyReference): { promptWire: string; representation: AgentMessageInputRepresentation } {
  let body: AgentMessageInputRepresentation['body'] = 'inline'
  let quote: AgentMessageInputRepresentation['quote'] = envelope.channelQuote ? 'inline' : 'absent'
  const selected = () => {
    const representation = { body, quote, reminder: reminder(envelope, body, quote, conversationKind, moteReply) }
    return { representation, promptWire: renderMessageInputRepresentation(envelope, representation) }
  }
  let value = selected()
  if (bytes(value.promptWire) > INLINE_MESSAGE_BYTES && quote === 'inline') { quote = 'reference'; value = selected() }
  if (bytes(value.promptWire) > INLINE_MESSAGE_BYTES) { body = 'reference'; value = selected() }
  return value
}

/** Journal/DTO validation checks original content, not whether today's threshold would choose it. */
export function messageInputWireMatches(envelope: AgentMuxMessageEnvelope, source: { promptWire?: unknown; representation?: unknown }): boolean {
  if (source.representation === undefined) return envelope.channelQuote
    ? typeof source.promptWire === 'string' && channelQuoteWireMatchesEnvelope(source.promptWire, envelope)
    : source.promptWire === undefined
  const r = source.representation as AgentMessageInputRepresentation
  if (!(envelope.sender.kind === 'external' && !!r && typeof r === 'object' && !Array.isArray(r) &&
    Object.keys(r).every(key => ['body', 'quote', 'reminder'].includes(key)) &&
    ['inline', 'reference'].includes(r.body) && ['absent', 'inline', 'reference'].includes(r.quote) &&
    (envelope.channelQuote ? r.quote !== 'absent' : r.quote === 'absent') &&
    !(r.body === 'reference' && r.quote === 'inline') && typeof r.reminder === 'string' && !!r.reminder.trim() &&
    typeof source.promptWire === 'string')) return false
  const reading = parseAgentMuxMessagePrefix(source.promptWire)
  if (reading?.kind !== 'content' || reading.declaredContexts?.length !== 1 || reading.declaredContexts[0]?.inputContext) return false
  try {
    const context = new DOMParser({ onError: onWarningStopParsing }).parseFromString(reading.declaredContexts[0]!.raw, 'text/xml')
    if (context.documentElement?.textContent !== `\n${r.reminder}\n`) return false
  } catch { return false }
  if (r.body === 'reference') return reading.body === '' && !reading.declaredChannel && !reading.declaredChannelQuote
  const channel = reading.declaredChannel, sender = envelope.sender
  return !!channel && reading.body === envelope.body &&
    sameConnectionApplication(channel.actor.application, sender.actor.application) &&
    channel.actor.idType === sender.actor.idType && channel.actor.userId === sender.actor.userId &&
    channel.externalConversationId === sender.externalConversationId && channel.externalMessageId === sender.externalMessageId &&
    JSON.stringify(channel.profile) === JSON.stringify(envelope.channelProfile?.profile ?? undefined) &&
    (r.quote === 'inline' ? !!reading.declaredChannelQuote && channelTranscriptQuoteJson(reading.declaredChannelQuote.quote) === channelTranscriptQuoteJson(envelope.channelQuote!) : !reading.declaredChannelQuote)
}

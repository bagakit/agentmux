import type { PublicationOperation } from './publication-store.js'
import { publicationSpeechText } from './publication-wire.js'
import { publicationReplyText } from './publication-reply-text.js'

/** Shared text presentation only; it never selects sources, grants actions or settles effects. */
export function publicationPlainText(operation: Readonly<PublicationOperation>): string {
  const payload = operation.payload
  if (payload.kind === 'speech') {
    const role = operation.speaker?.kind ?? (payload.relay ? 'unknown' : 'agent')
    const heading = [operation.speaker?.name ? Array.from(operation.speaker.name.replace(/\r\n|\r|\n/gu, ' ')).slice(0, 160).join('') : undefined,
      { agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[role],
      payload.phase === 'progress' ? 'Progress' : payload.phase === 'final' ? 'Reply' : undefined].filter(Boolean).join(' · ')
    const metadata = payload.replyMetadata ? publicationReplyText(payload.replyMetadata) : ''
    return [heading, publicationSpeechText(payload), metadata].filter(Boolean).join('\n\n')
  }
  if (payload.kind === 'failure') return ['Request failed', payload.message, payload.recovery, payload.code].filter(Boolean).join('\n\n')
  if (payload.kind === 'binding-lifecycle') return [
    'Conversation sharing ' + payload.event, 'Agent ' + payload.agentSessionId,
    payload.scope.publication === 'future-shared-conversation' ? 'New normal conversation messages' : 'Agent replies',
    payload.synchronization === null ? 'Synchronization unconfirmed' : payload.synchronization ? 'Synchronization enabled' : 'Synchronization disabled',
    ...(payload.event === 'disconnected' ? ['The Agent remains available.'] : [])
  ].join('\n')
  // Structured actions and media need an explicit adapter implementation, never a text-shaped success.
  throw new Error('The original publication requires a native content adapter')
}

import type { PublicationOperation } from '../../publication-store.js'
import { publicationSpeechText, type PreparedPublication } from '../../publication-wire.js'
import { discordId, discordFailure } from './protocol.js'
import { createHash } from 'node:crypto'
export const DISCORD_PUBLICATION = { adapterId: 'discord', renderVersion: 'discord-components-v1', fragmentBytes: 1900 } as const
export const discordNonce = (operationId: string): string => createHash('sha256').update(operationId).digest('base64url').slice(0, 25)
export function prepareDiscordPublication(operation: Readonly<PublicationOperation>): PreparedPublication {
    const channel = discordId(operation.target.externalConversationId), mapping = operation.mapping
    const path = `/channels/${channel}/messages${mapping ? '/' + discordId(mapping.messageId) : ''}`
    if (operation.effect === 'withdraw') {
      if (!mapping) return discordFailure('DISCORD_ORIGINAL_MESSAGE_UNCONFIRMED')
      return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: 'DELETE', path } }
    }
    const p = operation.payload
    const text = p.kind === 'speech' ? publicationSpeechText(p) : p.kind === 'binding-lifecycle'
      ? `${p.event === 'disconnected' ? 'Conversation sharing ended' : 'Conversation sharing ' + p.event}\nAgent ${p.agentSessionId}\n${p.scope.publication === 'future-shared-conversation' ? 'New conversation messages' : 'Agent replies'} · ${p.scope.input}\n${p.synchronization === true ? 'Synchronization enabled' : p.synchronization === false ? 'Synchronization disabled' : 'Synchronization state unconfirmed'}${p.event === 'disconnected' ? '\nThe Agent remains available.' : ''}`
      : discordFailure('DISCORD_REPRESENTATION_UNSUPPORTED')
    const components = [{ type: 17, components: [{ type: 10, content: (p.kind === 'speech' && p.phase === 'progress' ? '**Progress**\n' : '') + text }] }]
    const body = JSON.stringify({ flags: 32768, components, allowed_mentions: { parse: [] }, ...(!mapping ? { nonce: discordNonce(operation.operationId), enforce_nonce: true } : {}) })
    return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: mapping ? 'PATCH' : 'POST', path, body, contentType: 'application/json' } }
  }

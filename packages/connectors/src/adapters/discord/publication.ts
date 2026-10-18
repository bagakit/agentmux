import { DiscordAPIError, HTTPError, RequestMethod } from '@discordjs/rest'
import type { APIMessage } from 'discord-api-types/v10'
import type { PublicationAdapter } from '../../publication-adapter.js'
import type { PublicationMapping, PublicationOperation, PublicationReceipt, PublicationTarget } from '../../publication-store.js'
import { parsePreparedPublication, type PreparedPublication, type PublicationEffectContext } from '../../publication-wire.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import { discordId, discordFailure } from './protocol.js'
import type { DiscordClients } from './client.js'

import { prepareDiscordPublication, discordNonce } from './render.js'
function nativeFieldsMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => nativeFieldsMatch(value, actual[index]))
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => nativeFieldsMatch(value, (actual as Record<string, unknown>)[key]))
  return expected === actual
}
const unknown = (): PublicationReceipt => ({ state: 'unknown', reason: 'effect-unconfirmed' })
function failed(error: unknown): PublicationReceipt {
  const status = error instanceof DiscordAPIError || error instanceof HTTPError ? error.status : undefined
  if (status === 429) return { state: 'not-applied', reason: 'rate-limited' }
  if (status === 401 || status === 403) return { state: 'not-applied', reason: 'platform-rejected' }
  if (status === 404) return { state: 'not-applied', reason: 'thread-unavailable' }
  if (status === 400 || status === 413) return { state: 'not-applied', reason: 'unsupported-format' }
  return unknown()
}
/** Discord payloads stay inside this adapter; original Outbox owns intentions, ordering and recovery. */
export class DiscordPublicationAdapter implements PublicationAdapter {
  readonly adapterId = 'discord'
  readonly renderVersion = 'discord-components-v1'
  readonly supportedRenderVersions = [this.renderVersion]
  readonly fragmentBytes = 1900
  readonly permissionActions = true as const
  readonly questionActions = true as const
  readonly directResources = true as const
  readonly images = { maxBytes: 16 * 1024 * 1024, accepts: () => true }
  readonly files = { maxBytes: 16 * 1024 * 1024, accepts: () => true }
  constructor(private readonly clients: DiscordClients, private readonly storage: (target: PublicationTarget) => ChannelStoragePort | undefined) {}
  prepare = prepareDiscordPublication

  async dispatch(value: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>, context?: PublicationEffectContext): Promise<PublicationReceipt> {
    const prepared = parsePreparedPublication(value, this)
    let files: Array<{ name: string; contentType: string; data: Buffer }> | undefined
    try { files = prepared.request.multipart?.files.map(file => {
      if (!context) return discordFailure('DISCORD_RESOURCE_UNCONFIRMED')
      return { name: file.name, contentType: file.contentType, data: Buffer.from(context.readResource(file)) }
    }) } catch { return { state: 'not-applied', reason: 'unsupported-format' } }
    let identity: { botId: string }
    try { identity = await this.clients.identity({ ...target, adapterId: this.adapterId, label: '', enabled: true, credentialRef: '' }, credential, signal) }
    catch { return { state: 'not-applied', reason: 'adapter-unavailable' } }
    try {
      const rest = this.clients.rest({ ...target, adapterId: this.adapterId, label: '', enabled: true, credentialRef: '' }, credential)
      const message = await rest.request({ method: prepared.request.method as RequestMethod, fullRoute: prepared.request.path as `/${string}`, signal,
        ...(prepared.request.multipart ? { body: JSON.parse(prepared.request.multipart.payloadJson), files: files! } : prepared.request.body === undefined ? {} : { body: JSON.parse(prepared.request.body) }) }) as APIMessage | undefined
      if (prepared.request.method === 'DELETE') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      if (!message || message.channel_id !== target.externalConversationId || message.author?.id !== identity.botId || mapping && message.id !== mapping.messageId || prepared.request.method === 'POST' && String(message.nonce) !== discordNonce(prepared.requestKey)) return unknown()
      discordId(message.id)
      return { state: 'confirmed', mapping: { messageId: message.id } }
    } catch (error) { return failed(error) }
  }
  async inspect(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null> {
    if (!mapping && prepared.request.method === 'POST') {
      try {
        const row = this.storage(target)?.get('effect:nonce:' + discordNonce(prepared.requestKey))
        if (row?.value.kind !== 'json') return null
        const message = row.value.value as { channelId?: string; messageId?: string; applicationId?: string }
        if (message.channelId === target.externalConversationId && message.applicationId === target.application.appId) return { state: 'confirmed', mapping: { messageId: discordId(message.messageId) } }
      } catch { /* Cache observation failure retains the original unknown effect. */ }
      return null
    }
    // A GET confirms the exact retained message; content equality never establishes a new identity.
    if (!mapping || prepared.request.method === 'DELETE' || prepared.request.multipart) return null
    try {
      const rest = this.clients.rest({ ...target, adapterId: this.adapterId, label: '', enabled: true, credentialRef: '' }, credential)
      const identity = await this.clients.identity({ ...target, adapterId: this.adapterId, label: '', enabled: true, credentialRef: '' }, credential, signal)
      const message = await rest.get(`/channels/${discordId(target.externalConversationId)}/messages/${discordId(mapping.messageId)}`, { signal }) as APIMessage
      const expected = prepared.request.body ? JSON.parse(prepared.request.body) : undefined
      return message.id === mapping.messageId && message.channel_id === target.externalConversationId && message.author?.id === identity.botId && nativeFieldsMatch(expected?.components, message.components) ? { state: 'confirmed', mapping: { ...mapping } } : null
    } catch { return null }
  }
}

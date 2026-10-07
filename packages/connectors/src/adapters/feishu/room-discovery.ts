import type { Client } from '@larksuiteoapi/node-sdk'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '@agentmux/core/control'
import type { ConnectionConfig, RoomDiscoveryObservation, RoomDiscoveryReason, RoomSummary, RoomDetails } from '@agentmux/core/connections'
import type { RoomDiscoveryAdapter, RoomAdapterPage, RoomAdapterMembers } from '../../room-discovery-adapter.js'
import { feishuIdentity } from './message.js'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unconfirmed native room response'); return value as Record<string, unknown> }
function text(value: unknown, optional = false): string | null {
  if (optional && (value === undefined || value === '')) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Unconfirmed native room field')
  return value
}
function data(value: unknown): Record<string, unknown> {
  // A native same-join batch may exceed page_size. Bound its wire, never slice away members or invent a cursor.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new Error('Native page exceeds the original RPC frame budget')
  const p = object(value)
  if (p.code !== 0) throw new Error('Native room read was not confirmed')
  return object(p.data)
}
function failure(value: unknown): RoomDiscoveryObservation {
  const code = object(value).code
  if (!Number.isSafeInteger(code)) return unknown
  const reason: RoomDiscoveryReason = [99991672, 99991663, 232024, 232033, 232034, 232064].includes(Number(code)) ? 'permission-denied'
    : [232006, 232009, 232010, 232011, 232061, 232062, 232063].includes(Number(code)) ? 'room-unavailable' : 'platform-unavailable'
  return { state: 'unavailable', reason }
}
const unknown: RoomDiscoveryObservation = { state: 'unknown', reason: 'response-unconfirmed' }
const ready: RoomDiscoveryObservation = { state: 'ready' }
function next(p: Record<string, unknown>): string | null {
  if (typeof p.has_more !== 'boolean') throw new Error('Unconfirmed native pagination')
  if (!p.has_more) return null
  const token = p.page_token
  if (typeof token !== 'string' || !token.trim() || token.length > 16384 || /[\u0000-\u001f\u007f]/u.test(token)) throw new Error('Unconfirmed native cursor')
  return token
}
function summary(value: unknown): RoomSummary {
  const p = object(value)
  if (p.chat_status !== undefined && !['normal', 'dissolved', 'dissolved_save'].includes(p.chat_status as string)) throw new Error('Unconfirmed native room status')
  return { externalConversationId: feishuIdentity(p.chat_id), name: text(p.name, true), state: p.chat_status === 'normal' ? 'active' : p.chat_status === undefined ? 'unknown' : 'dissolved' }
}
function page(value: unknown): RoomAdapterPage {
  const response = object(value)
  if (response.code !== 0) return { observation: failure(response), rooms: [], next: null }
  const p = data(value)
  if (!Array.isArray(p.items)) throw new Error('Unconfirmed native room page')
  return { observation: ready, rooms: p.items.map(summary), next: next(p) }
}
/** Official SDK methods, sharing the original authenticated Client and caller cancellation. */
export function createFeishuRoomDiscovery(withClient: WithClient): RoomDiscoveryAdapter {
  return {
    list: async (input, credential, signal) => {
      try { return await withClient(input.config, credential, async client => page(await client.im.chat.list({ params: { page_size: input.limit ?? 20, ...(input.cursor ? { page_token: input.cursor } : {}), user_id_type: 'open_id' } })), signal) }
      catch { return { observation: unknown, rooms: [], next: null } }
    },
    search: async (input, credential, signal) => {
      try { return await withClient(input.config, credential, async client => page(await client.im.chat.search({ params: { query: input.query, page_size: input.limit ?? 20, ...(input.cursor ? { page_token: input.cursor } : {}), user_id_type: 'open_id' } })), signal) }
      catch { return { observation: unknown, rooms: [], next: null } }
    },
    get: async (input, credential, signal) => {
      try { return await withClient(input.config, credential, async client => {
        const response = await client.im.chat.get({ path: { chat_id: encodeURIComponent(input.externalConversationId) }, params: { user_id_type: 'open_id' } })
        if (object(response).code !== 0) return { observation: failure(response), room: null }
        const p = data(response)
        if (p.chat_mode !== undefined && !['group', 'topic', 'p2p'].includes(p.chat_mode as string) || p.membership_approval !== undefined && !['approval_required', 'no_approval_required'].includes(p.membership_approval as string)) throw new Error('Unconfirmed native room detail')
        const room: RoomDetails = { ...summary({ ...p, chat_id: input.externalConversationId }), mode: p.chat_mode === 'group' ? 'group' : p.chat_mode === 'topic' ? 'topic' : p.chat_mode === 'p2p' ? 'direct' : 'unknown', membershipApproval: p.membership_approval === 'approval_required' ? 'required' : p.membership_approval === 'no_approval_required' ? 'not-required' : 'unknown' }
        return { observation: ready, room }
      }, signal) } catch { return { observation: unknown, room: null } }
    },
    members: async (input, credential, signal) => {
      try { return await withClient(input.config, credential, async client => {
        const response = await client.im.chatMembers.get({ path: { chat_id: encodeURIComponent(input.externalConversationId) }, params: { member_id_type: 'open_id', page_size: input.limit ?? 20, ...(input.cursor ? { page_token: input.cursor } : {}) } })
        if (object(response).code !== 0) return { observation: failure(response), members: [], next: null }
        const p = data(response)
        if (!Array.isArray(p.items)) throw new Error('Unconfirmed native members')
        const members = p.items.map(value => { const m = object(value); if (m.member_id_type !== 'open_id') throw new Error('Unconfirmed member identity type'); return { idType: 'open_id', userId: feishuIdentity(m.member_id), name: text(m.name, true) } })
        return { observation: ready, members, next: next(p) } satisfies RoomAdapterMembers
      }, signal) } catch { return { observation: unknown, members: [], next: null } }
    },
    createLink: async (input, credential, signal) => {
      if (signal?.aborted) return { kind: 'refused', reason: 'authority-unavailable' }
      try { return await withClient(input.config, credential, async client => {
        if (signal?.aborted) return { kind: 'refused', reason: 'authority-unavailable' }
        const response = await client.im.chat.link({ path: { chat_id: encodeURIComponent(input.externalConversationId) }, data: { validity_period: 'week' } })
        if (object(response).code !== 0) {
          const status = object(response).code
          // Only documented pre-effect refusals certify that a link was not issued.
          if (!Number.isSafeInteger(status) || ![232001, 232006, 232009, 232010, 232011, 232019, 232024, 232025, 232033, 232034, 232061, 232062, 232063, 232064].includes(Number(status))) return { kind: 'unknown' }
          return { kind: 'refused', reason: (failure(response) as { reason: RoomDiscoveryReason }).reason }
        }
        const p = data(response), url = text(p.share_link)!, expires = p.expire_time
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || p.is_permanent !== false || typeof expires !== 'string' || !/^[0-9]+$/u.test(expires) || !Number.isSafeInteger(Number(expires)) || Number(expires) < 1) throw new Error('Unconfirmed native joining link')
        return { kind: 'confirmed', link: { url, expiresAtUnixSeconds: Number(expires) } }
      }, signal) } catch { return { kind: 'unknown' } }
    }
  }
}

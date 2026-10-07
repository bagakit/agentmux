import type { Client } from '@larksuiteoapi/node-sdk'
import type { ConnectionConfig, RoomMemberResult } from '@agentmux/core/connections'
import type { RoomProvisioningAdapter } from '../../room-provisioning-adapter.js'
import { feishuIdentity } from './message.js'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
type MemberIdType = 'open_id' | 'union_id' | 'user_id' | 'app_id'
const memberIdType = (value: string): value is MemberIdType => value === 'open_id' || value === 'union_id' || value === 'user_id' || value === 'app_id'
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unconfirmed room response')
  return value as Record<string, unknown>
}
function code(value: unknown): number {
  const result = object(value).code
  if (!Number.isSafeInteger(result)) throw new Error('Unconfirmed room response')
  return result as number
}
function memberStates(value: unknown, requested: string[]): RoomMemberResult['state'][] {
  if (code(value) !== 0) return requested.map(() => 'not-applied')
  const data = object(object(value).data), original = new Set(requested)
  const ids = (key: string): Set<string> => {
    const list = data[key] === undefined ? [] : data[key]
    if (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !original.has(id))) throw new Error('Unconfirmed member response')
    return new Set(list as string[])
  }
  const invalid = new Set([...ids('invalid_id_list'), ...ids('not_existed_id_list')]), pending = ids('pending_approval_id_list')
  if ([...pending].some(id => invalid.has(id))) throw new Error('Conflicting member response')
  return requested.map(id => invalid.has(id) ? 'not-applied' : pending.has(id) ? 'unknown' : 'joined')
}

/** Native room effects only. Original Host attempts and per-member receipts own recovery. */
export function createFeishuRooms(withClient: WithClient): RoomProvisioningAdapter {
  return {
    create: async (input, credential, signal) => {
      if (signal?.aborted || !input.attemptId || input.attemptId.length > 50) return { kind: 'not-applied' }
      try {
        return await withClient(input.config, credential, async client => {
          if (signal?.aborted) return { kind: 'not-applied' }
          const response = await client.im.chat.create({ params: { uuid: input.attemptId },
            data: { name: input.name, chat_mode: 'group', chat_type: 'private', group_message_type: 'chat' } })
          const status = code(response)
          // The documented in-progress response can already represent an accepted original creation.
          if (status === 232068) return { kind: 'unknown' }
          if (status !== 0) return { kind: 'not-applied' }
          return { kind: 'created', externalConversationId: feishuIdentity(object(response.data).chat_id) }
        }, signal)
      } catch { return { kind: 'unknown' } }
    },
    addMembers: async (input, credential, signal) => {
      const results: RoomMemberResult[] = input.members.map(member => ({ member: { ...member }, state: 'unknown' }))
      const groups = new Map<MemberIdType, number[]>()
      for (let index = 0; index < results.length; index++) {
        const type = results[index]!.member.idType
        if (!memberIdType(type)) { results[index]!.state = 'not-applied'; continue }
        const group = groups.get(type) ?? []; group.push(index); groups.set(type, group)
      }
      if (signal?.aborted || !groups.size) return { results }
      try {
        await withClient(input.config, credential, async client => {
          for (const [type, indexes] of groups) {
            const limit = type === 'app_id' ? 5 : 50
            for (let offset = 0; offset < indexes.length; offset += limit) {
              if (signal?.aborted) return
              const batch = indexes.slice(offset, offset + limit), ids = batch.map(index => results[index]!.member.userId)
              try {
                const response = await client.im.chatMembers.create({ path: { chat_id: input.externalConversationId }, params: { member_id_type: type, succeed_type: 1 }, data: { id_list: ids } })
                const states = memberStates(response, ids)
                batch.forEach((index, at) => { results[index]!.state = states[at]! })
              } catch { return } // Keep earlier exact confirmations, but do not infer the remaining members joined.
            }
          }
        }, signal)
      } catch { /* Authentication, cancellation or network uncertainty preserves every unconfirmed member. */ }
      return { results }
    }
  }
}

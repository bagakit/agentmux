import { vi } from 'vitest'
import type { HttpInstance } from '@larksuiteoapi/node-sdk'
import type { RoomMember } from '@agentmux/core/connections'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { feishuConfig } from './feishu.js'

export type RoomRequest = { url?: string; method?: string; params?: Record<string, unknown>; data?: Record<string, unknown>; signal?: AbortSignal }
export function feishuRoomsHttp(effect: (request: RoomRequest) => Promise<unknown> = async request => request.url?.endsWith('/members') ? { code: 0, data: {} } : { code: 0, data: { chat_id: 'original-created-room' } }) {
  const calls: RoomRequest[] = []
  const request = vi.fn(async (input: RoomRequest) => {
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'fixture-tenant-access', app_access_token: 'fixture-app-access', expire: 3600 }
    calls.push(input)
    return await effect(input)
  })
  const http = { request, post: (url: string, data: Record<string, unknown>) => request({ url, data }) } as unknown as HttpInstance
  return { http, calls, request, adapter: new FeishuAdapter({ http }) }
}
export const creation = { operationId: 'caller-reusable-operation', attemptId: 'original-random-attempt', config: feishuConfig, name: 'Original Agent room' }
export const membership = (members: RoomMember[]) => ({ ...creation, externalConversationId: 'original-created-room', members })

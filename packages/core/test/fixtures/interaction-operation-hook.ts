import { expect } from 'vitest'
import { request as httpRequest, type ClientRequest } from 'node:http'
import type { AgentHookServer } from '../../src/hook-server.js'
import type { AgentMuxAgentInteractionInput } from '../../src/types.js'
import { rpcOwnerFixture } from '../helpers/public-rpc-owner.js'

export const OPERATION_SESSION_ID = 'recipient'
export const OPERATION_RUN_ID = 'run-recipient'

/** Real authenticated Hook HTTP and Core response owner; Runtime/native discovery are controlled ports. */
export async function interactionOperationHook(requestId = 'original-request') {
  const h = await rpcOwnerFixture([OPERATION_SESSION_ID])
  const provider = h.client.providers.get('codex')
  provider.discoverNativeSession = async () => ({
    handle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' },
    assertCurrent: async () => {}
  })
  provider.observeSessionStatus = async () => ({ dispose() {} })
  h.inner.kernel.status = async (id: string) => ({ ...h.run(id), pid: 123 })
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  let ingress: ClientRequest | undefined
  let callback: Promise<unknown> | undefined
  const close = async () => {
    try {
      ingress?.destroy()
      if (callback) await Promise.allSettled([callback])
      const pending = h.client.agentSession(OPERATION_SESSION_ID).pendingInteraction?.request
      if (pending?.kind === 'permission' && pending.permissionHook) {
        await expect.poll(() => {
          const request = h.client.agentSession(OPERATION_SESSION_ID).pendingInteraction?.request
          return request?.kind === 'permission' && Boolean(request.permissionHook?.closed)
        }).toBe(true)
      }
    } finally {
      await h.close()
    }
  }
  try {
    await server.start()
    const binding = server.createBinding(OPERATION_SESSION_ID, 'codex')
    await binding.bindRun(OPERATION_RUN_ID)
    callback = new Promise((resolve, reject) => {
      ingress = httpRequest(binding.endpoint.url, {
        method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` }
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.once('error', reject)
        response.once('end', () => {
          try { expect(response.statusCode).toBe(200); resolve(JSON.parse(body)) } catch (error) { reject(error) }
        })
      })
      ingress.once('error', reject)
      ingress.end(JSON.stringify({ receiptId: requestId, eventName: 'PermissionRequest', decision: true,
        payload: { hook_event_name: 'PermissionRequest', session_id: 'original-native',
          turn_id: 'original-turn', tool_name: 'Bash', tool_input: { command: 'original command' } } }))
    })
    void callback.catch(() => {}) // Cleanup may close an intentionally unanswered original callback.
    await expect.poll(() => h.client.agentSession(OPERATION_SESSION_ID).pendingInteraction?.request.id).toBe(requestId)
    expect(server.hasPermissionCallback(OPERATION_SESSION_ID, OPERATION_RUN_ID, requestId)).toBe(true)
    const request = h.client.agentSession(OPERATION_SESSION_ID).pendingInteraction!.request
    if (request.kind !== 'permission') throw new Error('The original Hook did not publish a permission request.')
    expect(request).not.toHaveProperty('nativeToolCallId')
    const input = {
      agentSessionId: OPERATION_SESSION_ID, expectedRun: { runId: OPERATION_RUN_ID },
      operationId: 'original-response', expectedRequest: request,
      response: { kind: 'permission', requestId,
        decision: { outcome: 'selected', optionId: 'reject-once' } }
    } satisfies AgentMuxAgentInteractionInput
    return { ...h, close, server, callback, request, input }
  } catch (error) {
    await close()
    throw error
  }
}

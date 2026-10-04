import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { connectHostedAgentMux, type AgentMuxHostedRpcPort } from '../src/hosted.js'
import { decodeBase64, encodeBase64, decodeHostedValue, encodeHostedValue, hostedTransfer } from '../src/hosted-value.js'
import { SESSION_HISTORY_IMAGE_MAX_BYTES } from '../src/session-history-resource.js'
import type { AgentSessionHistoryResourceReadResult } from '../src/types.js'

const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
const source = { providerId: 'recorded-provider', nativeSessionId: 'recorded-native-session' }
const request = { source, recordId: 'retained-image-record', partIndex: 0, expectedReference: 'opaque-recorded-image' }
const receipt: AgentSessionHistoryResourceReadResult = {
  agentSessionId: 'retained-agent-session', source, recordId: request.recordId, partIndex: 0,
  reference: request.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64, byteLength: 68 }
}
const identity = { hostId: 'recorded-host', instanceId: 'native-owner', processId: null,
  buildIdentity: 'controlled-browser-port', protocolVersion: 1, ownership: 'unverified' as const }
const owner = { runtimeId: 'semantic-host', ownerInstanceId: 'semantic-owner', processId: 1,
  protocolVersion: 1 as const, ctxmux: identity, availability: 'unverified' as const }

/** Browser built-ins remain available; a Node Buffer global must not be required by the SDK. */
async function withoutNodeBuffer<T>(read: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
  Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true, writable: true })
  try { return await read() }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor)
    else Reflect.deleteProperty(globalThis, 'Buffer')
  }
}

function browserPort() {
  let response = receipt
  const invocations: unknown[] = []
  const port = {
    async call(method: string, params: { invocation?: unknown }) {
      if (method === 'runtime.owner.identity') return { owner }
      if (method !== 'runtime.invoke') throw new Error('Unexpected browser RPC operation')
      const invocation = decodeHostedValue(params.invocation) as { method: string }
      if (invocation.method === 'runtimeProjection') return { value: encodeHostedValue({ subjects: [] }) }
      invocations.push(params)
      return { value: encodeHostedValue(response) }
    },
    async subscribe(method: string, _params: unknown, options: {
      onInitial(value: unknown): void; onEvent(value: unknown): void
    }) {
      if (method !== 'runtime.events') throw new Error('Unexpected browser subscription')
      options.onInitial({ owner, transferId: 'browser-initial' })
      for (const chunk of hostedTransfer({ kind: 'initial', value: { owner, identity, storePath: null,
        hostProcessId: 1, catalog: [], sessions: [], messageQueuePath: fixturePath("controlled/queue") } }, 'browser-initial'))
        options.onEvent({ type: 'snapshot', data: chunk })
      return { dispose: async () => {} }
    }
  } as unknown as AgentMuxHostedRpcPort
  return { port, invocations, respond(value: AgentSessionHistoryResourceReadResult) { response = value } }
}

describe('browser Hosted recorded-image contract', () => {
  it('reads an exact resource through the public Hosted entry with no Node Buffer', async () => {
    const h = browserPort()
    const result = await withoutNodeBuffer(async () => {
      const client = await connectHostedAgentMux({ rpc: h.port, consumerId: 'browser-image-reader' })
      try {
        return await client.sessionHistoryResource(receipt.agentSessionId, request)
          .then(value => ({ value }), error => ({ error }))
      } finally { await client.dispose() }
    })
    expect(result).toHaveProperty('value', receipt)
    expect(h.invocations).toHaveLength(1)
    expect(h.invocations[0]).toMatchObject({ fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  })

  it('rejects foreign, noncanonical or misbudgeted image receipts in that same browser SDK', async () => {
    const h = browserPort()
    const failures = await withoutNodeBuffer(async () => {
      const client = await connectHostedAgentMux({ rpc: h.port, consumerId: 'browser-image-reader' })
      try {
        const errors: unknown[] = []
        for (const response of [
          { ...receipt, recordId: 'foreign-record' },
          { ...receipt, result: { ...receipt.result, byteLength: 67 } },
          { ...receipt, result: { ...receipt.result, mimeType: 'image/jpeg' } },
          { ...receipt, result: { ...receipt.result, dataBase64: dataBase64.slice(0, -2) + 'J=' } }
        ] as AgentSessionHistoryResourceReadResult[]) {
          h.respond(response)
          errors.push(await client.sessionHistoryResource(receipt.agentSessionId, request)
            .then(() => undefined, error => error))
        }
        return errors
      } finally { await client.dispose() }
    })
    expect(failures).toHaveLength(4)
    for (const error of failures) expect(error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })

  it('accepts a canonical image at the fixed byte budget without a RegExp stack failure', async () => {
    const h = browserPort()
    const result = await withoutNodeBuffer(async () => {
      const bytes = new Uint8Array(SESSION_HISTORY_IMAGE_MAX_BYTES)
      bytes.set(decodeBase64(dataBase64))
      h.respond({ ...receipt, result: { status: 'read', mimeType: 'image/png',
        dataBase64: encodeBase64(bytes), byteLength: bytes.length } })
      const client = await connectHostedAgentMux({ rpc: h.port, consumerId: 'browser-image-reader' })
      try {
        return await client.sessionHistoryResource(receipt.agentSessionId, request)
          .then(value => ({ status: value.result.status, byteLength: value.result.status === 'read' ? value.result.byteLength : 0 }), error => ({ error }))
      } finally { await client.dispose() }
    })
    expect(result).toEqual({ status: 'read', byteLength: SESSION_HISTORY_IMAGE_MAX_BYTES })
  })
})

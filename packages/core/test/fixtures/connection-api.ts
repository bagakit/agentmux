import { connectionApiRequestDigest } from '../../src/connection-api-codec.js'
import type { ConnectionApiIdentity, ConnectionApiRequestInput, ConnectionApiOperation } from '../../src/connection-api-contract.js'
export const apiIdentity: ConnectionApiIdentity = { bindingId: 'human-created-binding', bindingRevision: 3, connectionId: 'original-bot', connectionRevision: 2,
  adapterId: 'native-protocol', application: { domain: 'native.example', appId: 'original-app' }, label: 'Original bot', executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'original-room',
  api: { documentationUrl: 'https://native.example/documentation', requestFormats: ['json', 'multipart'], responseFormats: ['json', 'empty'] } }
export const apiInput: ConnectionApiRequestInput = { operationId: 'native-original', identity: { bindingId: apiIdentity.bindingId, bindingRevision: 3, connectionId: apiIdentity.connectionId, connectionRevision: 2 },
  request: { method: 'POST', path: '/v1/business', query: { page: 1, enabled: true }, body: { z: 'Original text', a: [null, true, 1] }, files: [{ field: 'image', name: 'original.png', contentType: 'image/png', base64: Buffer.from('original synthetic bytes').toString('base64') }] } }
export const apiOperation = (input = apiInput): ConnectionApiOperation => ({ operationId: input.operationId, identity: apiIdentity,
  request: { method: input.request.method, path: input.request.path, digest: connectionApiRequestDigest(input) }, state: 'responded', response: { status: 200, body: { format: 'json', value: { code: 17, message: 'Native business refusal' } }, redacted: false } })


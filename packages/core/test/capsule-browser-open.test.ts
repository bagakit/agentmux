import { expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { parseAgentMuxControlRequest } from '../src/control-codec.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'

const capsuleId = '123456789ABC'
const destination = { kind: 'launcher' as const, regionId: 'original-region' }
const input = { url: 'http://127.0.0.1:43187/route?q=kept', capsuleId, destination, operationId: 'original-capsule-open' }

it('retains the exact Capsule identity and original operation through public Browser CLI and RPC adaptation', async () => {
  const command = AGENTMUX_CLI_COMMANDS.find(row => row.method === 'browser.open')!
  const params = await command.parse(['--url', input.url, '--capsule', capsuleId, '--in-region', destination.regionId,
    '--operation-id', input.operationId])
  expect(params).toEqual(input)
  const request = rpcControlRequest('browser.open', params)
  expect(request).toMatchObject({ operation: 'open.browser', capsuleId, url: input.url, requestId: input.operationId, destination })
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
})

it('rejects malformed Capsule IDs and incompatible private creation before the Browser owner is called', () => {
  for (const value of ['', 'capsule title', 'amux://capsule/123456789ABC', '../capsule', '123456789AB0', null, 12]) {
    expect(() => rpcControlRequest('browser.open', { ...input, capsuleId: value })).toThrow('exact object ID')
  }
  expect(() => rpcControlRequest('browser.open', { ...input, mode: 'private' })).toThrow('normal Browser')
  expect(parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'normal-open',
    operation: 'open.browser', url: input.url, destination })).not.toHaveProperty('capsuleId')
  expect(() => rpcControlRequest('browser.open', { ...input, capsuleMode: 'injected' })).toThrow('unsupported business field')
})

import { expect, it } from 'vitest'
import { parseConnectionServiceParams, parseConnectionServiceResult } from '../src/connection-service-codec.js'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'

it('strict scoped service replies preserve global inputs and reject another adapter or an omitted scope', async () => {
  const global = { operationId: 'original-global', expectedRevision: 0, service: { enabled: false } }
  expect(parseConnectionServiceParams('connection.service.get', {})).toEqual({})
  expect(JSON.stringify(parseConnectionServiceParams('connection.service.configure', global))).toBe(JSON.stringify(global))
  const input = { ...global, operationId: 'original-adapter', adapterId: 'sample-adapter' }
  expect(parseConnectionServiceParams('connection.service.configure', input)).toEqual(input)
  const receipt = { operationId: input.operationId, expectedRevision: 0, status: 'configured', service: { adapterId: input.adapterId, enabled: false, revision: 1 } }
  expect(parseConnectionServiceResult('connection.service.configure', receipt, input)).toEqual(receipt)
  expect(parseConnectionServiceResult('connection.service.inspect', { operation: receipt }, { operationId: input.operationId })).toEqual({ operation: receipt })
  for (const adapterId of [undefined, 'another-adapter']) {
    const service = { enabled: false, revision: 1, ...(adapterId === undefined ? {} : { adapterId }) }
    expect(() => parseConnectionServiceResult('connection.service.get', service, { adapterId: input.adapterId })).toThrow()
    expect(() => parseConnectionServiceResult('connection.service.configure', { ...receipt, service }, input)).toThrow()
  }
  expect(() => parseConnectionServiceResult('connection.service.get', receipt.service, {})).toThrow()
  for (const adapterId of ['', null, 1, false, [], {}, 'adapter/label']) expect(() => parseConnectionServiceParams('connection.service.get', { adapterId })).toThrow()
  expect(() => parseConnectionServiceParams('connection.service.inspect', { operationId: input.operationId, adapterId: input.adapterId })).toThrow()
  expect(() => parseConnectionServiceResult('connection.service.get', { ...receipt.service, effective: true }, { adapterId: input.adapterId })).toThrow()
  const command = AGENTMUX_CLI_COMMANDS.find(command => command.method === 'connection.service.get')!
  expect(await command.parse(['--adapter', input.adapterId])).toEqual({ adapterId: input.adapterId })
  expect(await command.parse([])).toEqual({})
})

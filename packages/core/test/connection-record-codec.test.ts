import { expect, it } from 'vitest'
import { parseConnectionResult } from '@agentmux/core/connections'

const record = { config: { connectionId: 'original', adapterId: 'native', application: { domain: 'native.example', appId: 'original-app' }, label: 'Saved identity', enabled: true, credentialRef: 'saved-reference' }, revision: 1,
  observation: { authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } } }

it.each(['incomplete', 'complete', 'unconfirmed'])('strict public record consumes finite initial setup %s independently of current authentication', state => {
  const result = parseConnectionResult('connection.ls', { connections: [{ ...record, initialSetup: { state } }] })
  expect(result.connections[0]!.initialSetup).toEqual({ state })
  expect(result.connections[0]!.observation).toEqual(record.observation)
})

it('keeps absent manual setup provenance legal without manufacturing a managed requirement', () => {
  expect(parseConnectionResult('connection.ls', { connections: [record] }).connections[0]).not.toHaveProperty('initialSetup')
})

it.each([null, {}, { state: 'ready' }, { state: 'complete', operationId: 'private-original' }, { state: 'complete', actor: 'private-actor' }])('rejects malformed or private initial setup record material %#', initialSetup => {
  expect(() => parseConnectionResult('connection.ls', { connections: [{ ...record, initialSetup }] })).toThrow()
})

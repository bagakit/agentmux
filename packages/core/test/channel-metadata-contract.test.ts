import { expect, it } from 'vitest'
import { parseConnectionParams, parseConnectionResult } from '../src/connections-codec.js'
import { parseChannelConversationProfileObservation, parseChannelMetadataChange } from '../src/channel-metadata-codec.js'

const application = { domain: 'chat.example', appId: 'original-app' }
const actor = { application, idType: 'native-user', userId: 'original-user' }
const subject = { kind: 'actor' as const, actor }
const profile = { actor, state: 'observed', profile: { name: 'Native person', avatarUrl: 'https://cdn.example/avatar', observedAt: 1 }, checkedAt: 1, freshness: 'current' }
const entry = { subject, observation: profile, cacheRevision: 'original-cache-revision' }
const result = { connectionId: 'original-connection', connectionRevision: 2, application, entry }

it('local metadata reads keep exact subjects without depending on unrelated configuration revisions', () => {
  const input = { connectionId: result.connectionId, subject }
  expect(parseConnectionParams('connection.metadata.get', input)).toEqual(input)
  expect(parseConnectionResult('connection.metadata.get', result, input)).toEqual(result)
  expect(parseConnectionResult('connection.metadata.get', { ...result, connectionRevision: 3 }, input).connectionRevision).toBe(3)
  expect(() => parseConnectionParams('connection.metadata.get', { ...input, expectedConnectionRevision: 1 })).toThrow()
  expect(() => parseConnectionParams('connection.metadata.refresh', input)).toThrow()
  expect(() => parseConnectionParams('connection.metadata.clear', { ...input, expectedConnectionRevision: 2 })).toThrow()
})

it('strict metadata results reject a different application, actor namespace or secret/raw storage fields', () => {
  const input = { connectionId: result.connectionId, subject }
  for (const alter of [
    (value: any) => { value.entry.observation.actor.application.appId = 'other-app' },
    (value: any) => { value.entry.observation.actor.idType = 'another-namespace' },
    (value: any) => { value.entry.observation.profile.secret = 'forbidden' },
    (value: any) => { value.entry.storageKey = 'private-key' }
  ]) {
    const forged = structuredClone(result); alter(forged)
    expect(() => parseConnectionResult('connection.metadata.get', forged, input)).toThrow()
  }
  expect(() => parseConnectionResult('connection.metadata.refresh', result, { ...input, expectedConnectionRevision: 1 })).toThrow()
})

it('bounded local metadata pages cannot become an unfiltered storage namespace or duplicate subjects', () => {
  const input = { connectionId: result.connectionId, kind: 'actor' as const, limit: 1 }
  const { entry: _entry, ...scope } = result
  expect(parseConnectionResult('connection.metadata.ls', { ...scope, entries: [entry], next: 'original-cursor' }, input).entries).toEqual([entry])
  expect(() => parseConnectionResult('connection.metadata.ls', { ...scope, entries: [entry, entry], next: null }, { ...input, limit: 2 })).toThrow()
  expect(() => parseConnectionParams('connection.metadata.ls', { ...input, prefix: 'retained-resource:' })).toThrow()
  expect(() => parseConnectionParams('connection.metadata.ls', { ...input, limit: 0 })).toThrow()
})

it('conversation rename observations retain one original conversation and a prior profile on failure', () => {
  const original = { application, externalConversationId: 'original-room', state: 'observed', profile: { name: 'Native group', observedAt: 1 }, checkedAt: 1, freshness: 'current' }
  const stale = { ...original, state: 'unavailable', freshness: 'stale', checkedAt: 2, reason: 'source-unconfirmed' }
  expect(parseChannelConversationProfileObservation(stale)).toEqual(stale)
  const target = { connectionId: result.connectionId, subject: { kind: 'conversation' as const, externalConversationId: original.externalConversationId } }
  expect(() => parseConnectionResult('connection.metadata.get', { ...result, entry: { subject: target.subject, observation: { ...original, externalConversationId: 'other-room' }, cacheRevision: null } }, target)).toThrow()
})


it('watch hints accept only the original safe metadata shape and never an arbitrary scope or private field', () => {
  expect(parseConnectionParams('connection.metadata.watch', {})).toEqual({})
  expect(parseConnectionResult('connection.metadata.watch', {}, {})).toEqual({})
  expect(() => parseConnectionParams('connection.metadata.watch', { connectionId: 'selected-connection' })).toThrow()
  const change = { connectionId: result.connectionId, application, subject }
  expect(parseChannelMetadataChange(change)).toEqual(change)
  expect(() => parseChannelMetadataChange({ ...change, secret: 'private-value' })).toThrow()
  expect(() => parseChannelMetadataChange({ ...change, application: { ...application, appId: 'foreign-app' } })).toThrow()
})

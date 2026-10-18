import { expect, it } from 'vitest'
import { channelActorKey, parseChannelActorProfileObservation } from '../src/channel-profile.js'

const actor = { application: { domain: 'chat.example', appId: 'original-app' }, idType: 'user-id', userId: 'original-user' }
const observation = { actor, state: 'observed' as const, profile: { name: 'Original name', avatarUrl: 'https://images.example/avatar.png', observedAt: 1 }, checkedAt: 2, freshness: 'current' as const }

it('retains observed fields independently of current refresh and platform authority', () => {
  expect(parseChannelActorProfileObservation(observation)).toEqual(observation)
  const failed = { ...observation, state: 'unavailable', checkedAt: 3, freshness: 'stale', reason: 'source-unconfirmed' }
  expect(parseChannelActorProfileObservation(failed)).toEqual(failed)
  expect(parseChannelActorProfileObservation({ actor, state: 'unknown', profile: null, checkedAt: 1, freshness: 'unknown', reason: 'not-observed' }).profile).toBeNull()
})

it('isolates every component of the original actor issuer namespace', () => {
  const keys = [actor, { ...actor, application: { ...actor.application, domain: 'messages.example' } },
    { ...actor, application: { ...actor.application, appId: 'other-app' } }, { ...actor, idType: 'other-type' }, { ...actor, userId: 'other-user' }].map(channelActorKey)
  expect(new Set(keys).size).toBe(keys.length)
})

it('rejects malformed display data without minting profile or authorization facts', () => {
  for (const value of [{ ...observation, authenticated: true }, { ...observation, state: 'observed', profile: null },
    { ...observation, checkedAt: -1 }, { ...observation, reason: 'source-unconfirmed' },
    { ...observation, profile: { ...observation.profile, avatarUrl: 'javascript:alert(1)' } },
    { ...observation, profile: { ...observation.profile, avatarUrl: 'https://credential@images.example/avatar.png' } }]) expect(() => parseChannelActorProfileObservation(value)).toThrow()
})

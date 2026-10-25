import { afterEach, expect, it, vi } from 'vitest'
import { channelActorKey } from '@agentmux/core/connections'
import { ChannelStorage } from '../src/channel-storage.js'
import { channelMetadataFixture, actor, actorSubject } from './fixtures/channel-metadata.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const fixture = () => channelMetadataFixture(cleanup)
function nativeFields(f: Awaited<ReturnType<typeof fixture>>, fields: { name?: string; avatar?: { avatar_240?: string } }) {
  const original = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(async input => input.url?.includes('/contact/v3/users/')
    ? { code: 0, msg: 'success', data: { user: { open_id: actor.userId, ...fields } } } : original(input))
}
const request = (f: Awaited<ReturnType<typeof fixture>>) => ({ connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })

it('public SDK and compiled metadata CLI treat exact-ID success without profile fields as unobserved, then recover real fields', async () => {
  const f = await fixture(); nativeFields(f, {})
  const originalBinding = await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })
  const empty = await f.cli(['refresh', '--input', '-'], request(f))
  expect(empty.entry.observation).toMatchObject({ actor, state: 'unavailable', profile: null, freshness: 'unknown', reason: 'not-visible' })
  const persisted = new ChannelStorage(f.services.database!).namespace(f.config).get('actor-profile:' + channelActorKey(actor))
  expect(persisted?.value).toMatchObject({ kind: 'json', value: { state: 'unavailable', profile: null, freshness: 'unknown' } })
  expect(f.requests()).toHaveLength(1)
  const read = await f.get(); expect(read).toEqual(empty); expect(f.requests()).toHaveLength(1)
  nativeFields(f, { name: 'Now observed', avatar: { avatar_240: 'https://cdn.example/observed.png' } })
  const recovered = await f.sdk.call('connection.metadata.refresh', request(f))
  expect(recovered.entry.observation).toMatchObject({ state: 'observed', freshness: 'current', profile: { name: 'Now observed', avatarUrl: 'https://cdn.example/observed.png' } })
  expect(await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })).toEqual(recovered)
  expect(f.requests()).toHaveLength(2)
  expect(await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toEqual(originalBinding)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('native missing and partial fields preserve real saved values and their original observation time through the metadata owner', async () => {
  const f = await fixture(), original = await f.sdk.call('connection.metadata.refresh', request(f))
  const profile = original.entry.observation.profile
  expect(profile).toMatchObject({ name: 'Original native person', avatarUrl: 'https://cdn.example/person.png' })
  nativeFields(f, {})
  const absent = await f.sdk.call('connection.metadata.refresh', request(f))
  expect(absent.entry.observation).toMatchObject({ state: 'unavailable', freshness: 'stale', reason: 'not-visible', profile })
  expect(absent.entry.observation.profile).toEqual(profile)
  expect(await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })).toEqual(absent)
  nativeFields(f, { name: 'Changed visible name' })
  const partial = await f.sdk.call('connection.metadata.refresh', request(f))
  expect(partial.entry.observation).toMatchObject({ state: 'observed', profile: { ...profile, name: 'Changed visible name' } })
  expect(partial.entry.observation.profile?.observedAt).toBe(profile!.observedAt)
  nativeFields(f, { avatar: { avatar_240: 'https://cdn.example/new-avatar.png' } })
  const avatarOnly = await f.sdk.call('connection.metadata.refresh', request(f))
  expect(avatarOnly.entry.observation.profile).toEqual({ ...profile, name: 'Changed visible name', avatarUrl: 'https://cdn.example/new-avatar.png' })
  expect(f.requests()).toHaveLength(4)
}, 20_000)

it('reading a timestamp-only original cache cannot claim Current or modify its original stored observation', async () => {
  const f = await fixture(), storage = new ChannelStorage(f.services.database!).namespace(f.config)
  const observation = { actor, state: 'observed', profile: { observedAt: Date.now() }, checkedAt: Date.now(), freshness: 'current' }
  const stored = storage.put({ key: 'actor-profile:' + channelActorKey(actor), expectedRevision: null, value: { kind: 'json', value: observation } })
  const read = await f.get()
  expect(read.entry).toMatchObject({ cacheRevision: stored.revision, observation: { state: 'unavailable', profile: null, freshness: 'unknown', reason: 'not-visible' } })
  expect(await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })).toEqual(read)
  expect(await f.sdk.call('connection.metadata.ls', { connectionId: f.config.connectionId, kind: 'actor' })).toMatchObject({ entries: [read.entry] })
  expect(storage.get(stored.key)).toEqual(stored)
  expect(f.requests()).toHaveLength(0)
}, 20_000)

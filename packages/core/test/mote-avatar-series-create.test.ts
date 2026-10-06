import { fixtureDisplayPath as reshapeFixtureDisplayPath, fixturePath as reshapeFixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { isMoteAvatarSeriesMethod, parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult } from '../src/mote-avatar-series.js'
import { AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'

it('discovers both strict starter methods and rejects traversal or caller-selected paths', () => {
  expect(isMoteAvatarSeriesMethod('space.mote.avatar.series.create')).toBe(true)
  expect(AGENTMUX_RPC_NATIVE_METHODS['space.mote.avatar.series.reveal']).toBe('short')
  for (const seriesId of ['../kept', '.', '..', 'root/child', 'root\\child', reshapeFixtureDisplayPath("absolute")]) expect(() => parseMoteAvatarSeriesParams('space.mote.avatar.series.create', { seriesId, title: 'Pets' })).toThrow()
  expect(() => parseMoteAvatarSeriesParams('space.mote.avatar.series.create', { seriesId: 'pets', title: 'Pets', path: reshapeFixturePath("elsewhere") })).toThrow()
  expect(() => parseMoteAvatarSeriesParams('space.mote.avatar.series.create', { seriesId: 'pets', title: '  ' })).toThrow()
  expect(parseMoteAvatarSeriesParams('space.mote.avatar.series.create', { seriesId: 'pets', title: 'My pets' })).toEqual({ seriesId: 'pets', title: 'My pets' })
})

it('keeps exact create/reveal subjects and cannot turn an OS request into a focus receipt', () => {
  const request = { seriesId: 'pets', title: 'My pets' }
  const created = { ...request, path: reshapeFixturePath("original/avatars/pets"), files: ['starter.png', 'series.json', 'README.md'], state: 'created' }
  expect(parseMoteAvatarSeriesResult('space.mote.avatar.series.create', created, request)).toEqual(created)
  expect(() => parseMoteAvatarSeriesResult('space.mote.avatar.series.create', { ...created, seriesId: 'other' }, request)).toThrow()
  expect(() => parseMoteAvatarSeriesResult('space.mote.avatar.series.create', { ...created, files: ['../original'] }, request)).toThrow()
  expect(() => parseMoteAvatarSeriesResult('space.mote.avatar.series.create', { ...created, state: 'unknown' }, request)).toThrow()
  const reveal = { seriesId: 'pets', path: reshapeFixturePath("original/avatars/pets"), outcome: 'requested' }
  expect(parseMoteAvatarSeriesResult('space.mote.avatar.series.reveal', reveal, request)).toEqual(reveal)
  expect(() => parseMoteAvatarSeriesResult('space.mote.avatar.series.reveal', { ...reveal, focused: true }, request)).toThrow()
  expect(() => parseMoteAvatarSeriesResult('space.mote.avatar.series.reveal', { ...reveal, path: reshapeFixturePath("original/avatars/other") }, request)).toThrow()
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MoteQuickPreferencesReadInput, MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteQuickOwner, type MoteQuickOwnerFixture } from './helpers/mote-quick-owner'

let app: MoteAppFixture, f: MoteQuickOwnerFixture
beforeEach(async () => { app = createMoteApp(); f = await moteQuickOwner() })
afterEach(async () => { await f?.close(); await app?.dispose() })

it.each([false, 'executors', 'locations', true, undefined] as const)('public Desktop Control preserves the original Quick read projection %s through its Host', async includeChoices => {
  if (includeChoices === false || includeChoices === 'executors') f.discovery.catalog.mockImplementation(() => new Promise(() => {}))
  if (includeChoices === false || includeChoices === 'locations') f.discovery.executors.mockImplementation(() => new Promise(() => {}))
  const input: MoteQuickPreferencesReadInput = { kind: 'quick', target: f.target, ...(includeChoices === undefined ? {} : { includeChoices }) }
  let failure: unknown
  const pending = f.client.call('space.mote.preferences.read', input).catch(error => { failure = error; return null })
  // A dropped envelope field must fail an accepted-intent assertion, not a test timeout.
  await vi.waitFor(() => expect(f.reads.mock.calls.length > 0 || failure !== undefined).toBe(true))
  expect(failure, 'the existing public read intent is accepted by the original Control parser').toBeUndefined()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ operation: 'space.mote.preferences.read', ...input })
  expect(f.reads.mock.calls.map(([value]) => value), 'the original bridge carries the complete read intent').toEqual([input])
  const result = await pending as MoteQuickPreferencesReadResult | null
  expect(result).toMatchObject({ kind: 'quick', target: f.target, status: 'ready', defaults: { executorId: 'fixture' }, issue: null })
  expect(result?.source?.result.status).toBe('read')
  if (includeChoices === false) {
    expect(result?.choices).toBeNull()
    expect(f.discovery.catalog).not.toHaveBeenCalled(); expect(f.discovery.executors).not.toHaveBeenCalled()
  } else if (includeChoices === 'executors') {
    expect(result?.choices).toEqual({ executors: [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }], conversations: null, destinations: null })
    expect(f.discovery.catalog).not.toHaveBeenCalled(); expect(f.discovery.executors).toHaveBeenCalledTimes(1)
  } else {
    expect(result?.choices?.conversations).toEqual([])
    expect(result?.choices?.destinations?.length).toBeGreaterThan(0)
    expect(result?.choices?.executors).toEqual(includeChoices === 'locations' ? null : [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }])
    expect(f.discovery.catalog).toHaveBeenCalledTimes(1)
    expect(f.discovery.executors).toHaveBeenCalledTimes(includeChoices === 'locations' ? 0 : 1)
  }
  expect(f.saves).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(f.original)
})

it('public Desktop Control keeps canonical selector and connection-kind refusals before its bridge', async () => {
  for (const input of [
    { kind: 'quick', target: f.target, includeChoices: 'everything' },
    { kind: 'connection', target: f.target, includeChoices: false }
  ]) await expect(f.client.call('space.mote.preferences.read', input as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.requests).toEqual([]); expect(f.reads).not.toHaveBeenCalled()
  expect(f.discovery.catalog).not.toHaveBeenCalled(); expect(f.discovery.executors).not.toHaveBeenCalled()
  expect(await f.bytes()).toBe(f.original)
})

it('public Desktop Control retains an exact resource failure without discovery, write or guessed defaults', async () => {
  const target = { ...f.target, expectedResource: { ...f.target.expectedResource, workspacePath: f.root } }
  const result = await f.client.call('space.mote.preferences.read', { kind: 'quick', target, includeChoices: false })
  expect(result).toMatchObject({ kind: 'quick', target, status: 'unconfirmed', source: null, defaults: null, choices: null, issue: expect.any(String) })
  expect(f.requests).toHaveLength(1); expect(f.reads).toHaveBeenCalledTimes(1)
  expect(f.discovery.catalog).not.toHaveBeenCalled(); expect(f.discovery.executors).not.toHaveBeenCalled()
  expect(f.saves).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(f.original)
})

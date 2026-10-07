import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compactNotificationIdentity, normalizeNotificationReadReceipts, ownedNotificationIdentity } from '../src/renderer/src/lib/notification-read-identity'

const hash = (canonical: string) => `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
const reason = 'The original operation is unconfirmed. Keep its diagnostic and recovery details.'
const fingerprint = (cause: unknown, occurrence: string | null = null, kind = 'indeterminate') => JSON.stringify([occurrence, kind, cause])
const owner = (host = 'host-a', session = 'session-a', run = 'run-a') => JSON.stringify(['resume', host, session, run])
const identity = (ownerKey: string, cause = reason, kind = 'indeterminate') => hash(JSON.stringify([kind, ownerKey, cause]))
const subject = (hostId = 'host-a', agentSessionId = 'session-a', runId = 'run-a') => ({ kind: 'agent', hostId, agentSessionId, run: { runId } })
const ordinary = (message = reason, host: string | null = 'host-a', session = 'session-a', run = 'run-a') =>
  JSON.stringify(['indeterminate', null, host, host === null ? null : 'agent', host === null ? null : session,
    host === null ? null : run, null, null, null, message])
const native = (host = 'host-a', session = 'session-a', run = 'run-a', message = reason, kind = 'indeterminate') =>
  JSON.stringify([kind, 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', host, 'agent', session, run, null, null, null, message])

describe('complete notification read identities', () => {
  it('uses the standard SHA-256 result and retains an already compact identity', () => {
    expect(compactNotificationIdentity('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const expected = hash('保留完整原文 🧭\n' + reason)
    expect(compactNotificationIdentity('保留完整原文 🧭\n' + reason)).toBe(expected)
    expect(compactNotificationIdentity(expected)).toBe(expected)
    expect(compactNotificationIdentity('sha256:abc')).toBe(hash('sha256:abc'))
  })

  it('keeps the entire reason and exact source, Host, Session, Run and kind', () => {
    const prefix = 'Original diagnostic 🧭 '.repeat(2048)
    const canonical = JSON.stringify(['indeterminate', owner(), prefix + 'tail-a'])
    expect(ownedNotificationIdentity(owner(), 'indeterminate', prefix + 'tail-a')).toBe(hash(canonical))
    const values = [
      ownedNotificationIdentity(owner(), 'indeterminate', prefix + 'tail-a'),
      ownedNotificationIdentity(owner(), 'indeterminate', prefix + 'tail-b'),
      ownedNotificationIdentity(owner('host-b'), 'indeterminate', prefix + 'tail-a'),
      ownedNotificationIdentity(owner('host-a', 'session-b'), 'indeterminate', prefix + 'tail-a'),
      ownedNotificationIdentity(owner('host-a', 'session-a', 'run-b'), 'indeterminate', prefix + 'tail-a'),
      ownedNotificationIdentity(owner(), 'process-degraded', prefix + 'tail-a'),
      ownedNotificationIdentity(JSON.stringify(['AGENT_NATIVE_IDENTITY_UNCONFIRMED', 'host-a', 'session-a', 'run-a']), 'indeterminate', prefix + 'tail-a')
    ]
    expect(new Set(values).size).toBe(values.length)
    expect(values).toHaveLength(7)
    for (const value of values) expect(value).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })
})

describe('hydrated read receipt normalization', () => {
  it('preserves ordinary read history as compact tombstones with constant values', () => {
    const first = ordinary(), second = ordinary(reason, 'host-b'), existing = hash(ordinary('Earlier confirmed read'))
    const input = { 'global:events': { [first]: first, [second]: second, [existing]: 'read' } }
    const normalized = normalizeNotificationReadReceipts(input)
    expect(normalized).toEqual({ 'global:events': { [hash(first)]: 'read', [hash(second)]: 'read', [existing]: 'read' } })
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
    expect(input['global:events'][first]).toBe(first)
    expect(JSON.stringify(normalized)).not.toContain(reason)
  })

  it('does not turn a mismatched value or incomplete canonical structure into a read', () => {
    const valid = ordinary(), incomplete = JSON.stringify(['indeterminate', null, 'host-a', 'agent', 'session-a'])
    expect(normalizeNotificationReadReceipts({ 'global:events': {
      [valid]: ordinary('Another operation'), [incomplete]: incomplete, 'not-an-event': 'read'
    } })).toEqual({})
    expect(normalizeNotificationReadReceipts(null)).toEqual({})
    expect(normalizeNotificationReadReceipts({ broken: [], another: 'text' })).toEqual({})
  })

  it('moves a complete native workflow read to the exact current owner, without changing its kind', () => {
    const canonical = native('host-a', 'session-a', 'run-a', reason, 'process-degraded')
    const nativeOwner = JSON.stringify(['AGENT_NATIVE_IDENTITY_UNCONFIRMED', 'host-a', 'session-a', 'run-a'])
    const value = fingerprint(canonical)
    const normalized = normalizeNotificationReadReceipts({ 'global:workflow': { current: value, other: fingerprint('Other cause') } })
    expect(normalized).toEqual({
      'global:events': { [identity(nativeOwner, reason, 'process-degraded')]: 'read' },
      'global:workflow': { other: fingerprint(hash('Other cause')) }
    })
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
    expect(normalized['global:events']![identity(owner())]).toBeUndefined()
  })

  it('retains native read isolation across the original Host, Session and Run', () => {
    const cases = [['host-a', 'session-a', 'run-a'], ['host-b', 'session-a', 'run-a'],
      ['host-a', 'session-b', 'run-a'], ['host-a', 'session-a', 'run-b']]
    const identities = cases.map(([host, session, run]) => {
      const normalized = normalizeNotificationReadReceipts({ 'global:workflow': { current: fingerprint(native(host, session, run)) } })
      const expected = identity(JSON.stringify(['AGENT_NATIVE_IDENTITY_UNCONFIRMED', host, session, run]))
      expect(normalized).toEqual({ 'global:events': { [expected]: 'read' } })
      return expected
    })
    expect(cases).toHaveLength(4)
    expect(new Set(identities).size).toBe(4)
  })

  it('does not infer a native read from a missing Run, another subject kind or an unrelated workflow', () => {
    const missing = JSON.stringify(['indeterminate', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', 'host-a', 'agent', 'session-a', null, null, null, null, reason])
    const terminal = JSON.stringify(['indeterminate', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', 'host-a', 'terminal', null, 'run-a', null, null, null, reason])
    for (const canonical of [missing, terminal, ordinary()]) {
      expect(normalizeNotificationReadReceipts({ 'global:workflow': { current: fingerprint(canonical) } }))
        .toEqual({ 'global:workflow': { current: fingerprint(hash(canonical)) } })
    }
  })

  it('does not grant a typed read from a fingerprint that the original projection could not have produced', () => {
    const launch = JSON.stringify(['launch', 'region-a']), local = `local:lifecycle:${JSON.stringify({ regionId: 'region-a' })}`
    const cause = JSON.stringify(['launch', reason])
    const input = { 'global:workflow': { current: fingerprint(native(), 'another-occurrence') },
      'global:sessions': { [launch]: fingerprint(cause, null, 'process-degraded') },
      [local]: { lifecycle: fingerprint(cause, null, 'agent-broken') } }
    expect(normalizeNotificationReadReceipts(input)).toEqual({
      'global:workflow': { current: fingerprint(hash(native()), 'another-occurrence') },
      'global:sessions': { [launch]: fingerprint(hash(cause), null, 'process-degraded') },
      [local]: { lifecycle: input[local]!.lifecycle }
    })
    expect(normalizeNotificationReadReceipts({ 'global:workflow': { current: fingerprint(native(), null, 'process-degraded') } }))
      .toEqual({ 'global:workflow': { current: fingerprint(hash(native()), null, 'process-degraded') } })
  })

  it('preserves startup workflow and unrelated scopes while hashing their full causes', () => {
    const startup = JSON.stringify(['indeterminate', null, null, null, null, null, null, ['session-a', 'session-b'], null, reason])
    const details = { step: 'Saving the workbench', mode: reason, restore: 'Retry the exact save.' }
    const input = { 'global:workflow': { current: fingerprint(startup) }, 'global:workbench-save': { original: fingerprint(details, 'operation-a') },
      unrelated: { opaque: 'An opaque original receipt' } }
    const normalized = normalizeNotificationReadReceipts(input)
    expect(normalized).toEqual({ 'global:workflow': { current: fingerprint(hash(startup)) },
      'global:workbench-save': { original: fingerprint(hash(JSON.stringify(details)), 'operation-a') }, unrelated: input.unrelated })
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
    expect(normalized['global:events']).toBeUndefined()
  })

  it('preserves mailbox read ownership even when a mail receipt resembles a service fingerprint', () => {
    const mail = { original: JSON.stringify(['assistant', 'message-a', reason]),
      'service-shaped': fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-a', 'session-a', 'run-a'])) }
    const unrelated = { receipt: JSON.stringify([null, 'another-kind', reason]) }
    const normalized = normalizeNotificationReadReceipts({ 'mail:session-a': mail, unrelated })
    expect(normalized).toEqual({ 'mail:session-a': mail, unrelated })
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
    expect(normalized['global:events']).toBeUndefined()
    expect(normalized[`local:lifecycle:${owner()}`]).toBeUndefined()
  })

  it('moves each exact launch and recovery global read to its original owner', () => {
    const launchA = JSON.stringify(['launch', 'region-a']), launchB = JSON.stringify(['launch', 'region-b'])
    const recoveryA = JSON.stringify(['host-a', 'session-a', 'recovery']), recoveryB = JSON.stringify(['host-b', 'session-a', 'recovery'])
    const normalized = normalizeNotificationReadReceipts({ 'global:sessions': {
      [launchA]: fingerprint(JSON.stringify(['launch', reason])), [launchB]: fingerprint(JSON.stringify(['launch', reason])),
      [recoveryA]: fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-a', 'session-a', 'run-a'])),
      [recoveryB]: fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-b', 'session-a', 'run-a']))
    } })
    expect(normalized).toEqual({ 'global:events': { [identity(launchA)]: 'read', [identity(launchB)]: 'read',
      [identity(owner())]: 'read', [identity(owner('host-b'))]: 'read' } })
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
  })

  it('keeps mismatched global recovery addresses and incomplete occurrences from conferring read', () => {
    const key = JSON.stringify(['host-b', 'session-a', 'recovery'])
    const mismatch = fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-a', 'session-a', 'run-a']))
    const incomplete = fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-b', 'session-a']))
    for (const value of [mismatch, incomplete]) {
      const normalized = normalizeNotificationReadReceipts({ 'global:sessions': { [key]: value } })
      expect(normalized['global:events']).toBeUndefined()
      expect(normalized['global:sessions']![key]).toBe(fingerprint(hash(JSON.stringify(['resume', reason])), JSON.parse(value)[0]))
    }
  })

  it('preserves independent local reads when normalizing legacy lifecycle owner objects', () => {
    const launch = JSON.stringify(['launch', 'region-a']), resume = owner()
    const input = {
      [`local:lifecycle:${JSON.stringify({ regionId: 'region-a' })}`]: { lifecycle: fingerprint(JSON.stringify(['launch', reason])) },
      [`local:lifecycle:${JSON.stringify({ subject: subject() })}`]: { lifecycle: fingerprint(JSON.stringify(['resume', reason])) }
    }
    const normalized = normalizeNotificationReadReceipts(input)
    expect(normalized).toEqual({ [`local:lifecycle:${launch}`]: { lifecycle: fingerprint(identity(launch)) },
      [`local:lifecycle:${resume}`]: { lifecycle: fingerprint(identity(resume)) } })
    expect(normalized['global:events']).toBeUndefined()
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
  })

  it('moves a Session Composer recovery read to canonical local scope without marking the global issue read', () => {
    const recovery = fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-a', 'session-a', 'run-a']))
    const original = fingerprint('Original independent provider failure', 'turn-a', 'process-degraded')
    const normalized = normalizeNotificationReadReceipts({ 'session-a': { recovery, 'provider-request': original } })
    expect(normalized).toEqual({ 'session-a': { 'provider-request': fingerprint(hash('Original independent provider failure'), 'turn-a', 'process-degraded') },
      [`local:lifecycle:${owner()}`]: { lifecycle: fingerprint(identity(owner())) } })
    expect(normalized[`local:lifecycle:${owner('host-b')}`]).toBeUndefined()
    expect(normalized[`local:lifecycle:${owner('host-a', 'session-a', 'run-b')}`]).toBeUndefined()
    expect(normalized['global:events']).toBeUndefined()
  })

  it('does not guess a local owner from an incomplete control or a different Composer Session', () => {
    const incomplete = `local:lifecycle:${JSON.stringify({ subject: { kind: 'agent', hostId: 'host-a', agentSessionId: 'session-a' } })}`
    const value = fingerprint(JSON.stringify(['resume', reason]))
    const mismatch = fingerprint(JSON.stringify(['resume', reason]), JSON.stringify(['host-a', 'session-a', 'run-a']))
    expect(normalizeNotificationReadReceipts({ [incomplete]: { lifecycle: value }, 'session-b': { recovery: mismatch } }))
      .toEqual({ [incomplete]: { lifecycle: fingerprint(hash(JSON.stringify(['resume', reason]))) },
        'session-b': { recovery: fingerprint(hash(JSON.stringify(['resume', reason])), JSON.stringify(['host-a', 'session-a', 'run-a'])) } })
  })

  it('keeps an already canonical local receipt when an older alias is present', () => {
    const canonical = `local:lifecycle:${owner()}`, alias = `local:lifecycle:${JSON.stringify({ subject: subject() })}`
    const current = fingerprint(identity(owner(), 'A later original cause'))
    const input = { [canonical]: { lifecycle: current }, [alias]: { lifecycle: fingerprint(JSON.stringify(['resume', reason])) } }
    expect(normalizeNotificationReadReceipts(input)).toEqual({ [canonical]: { lifecycle: current } })
    expect(normalizeNotificationReadReceipts(Object.fromEntries(Object.entries(input).reverse()))).toEqual({ [canonical]: { lifecycle: current } })
  })

  it('bounds persistent bytes per read without dropping any supported tombstone', () => {
    const diagnostic = 'Complete original diagnostic\n'.repeat(1024)
    const originals = Array.from({ length: 64 }, (_, index) => ordinary(`${diagnostic}Original cause ${index}`))
    const input = { 'global:events': Object.fromEntries(originals.map(id => [id, id])) }
    const normalized = normalizeNotificationReadReceipts(input)
    expect(Object.keys(normalized['global:events']!)).toHaveLength(64)
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_000_000)
    expect(Buffer.byteLength(JSON.stringify(normalized))).toBeLessThan(6_000)
    expect(JSON.stringify(normalized)).not.toContain('Complete original diagnostic')
    for (const original of originals) expect(normalized['global:events']![hash(original)]).toBe('read')
    expect(normalizeNotificationReadReceipts(normalized)).toEqual(normalized)
  })
})

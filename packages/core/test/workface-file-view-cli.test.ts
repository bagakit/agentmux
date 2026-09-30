import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { isLongAgentMuxControlOperation } from '../src/control.js'
import { workfaceCliFixture, location, saved } from './helpers/workface-cli.js'
const base = { schemaVersion: 5, requestId: 'file-mode-request' }
const body = { operation: 'space.view' as const, scope: 'file-region' as const, regionId: 'region-exact', tabId: 'tab-exact', workspaceId: 'resource-exact',
  storedOverride: null, effectiveMode: 'source' as const, supportedModes: ['source', 'diff'] as ('source' | 'diff')[], data: 'text' as const,
  content: { status: 'available' as const, reason: null }, locations: [location], changed: false, outcome: 'read' as const, save: null, issues: [] }
describe('File Region view public CLI wire', () => {
  const h = workfaceCliFixture(body)
  it('queries the exact Region without starting a write and preserves actual supported modes', async () => {
    expect(await h.receipt(['space', 'view', '--region', 'region-exact'])).toMatchObject({ result: { supportedModes: ['source', 'diff'], save: null } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: expect.any(String), operation: 'space.view', regionId: 'region-exact' })
    expect(isLongAgentMuxControlOperation('space.view')).toBe(true)
    const longId = 'region:file:resource:' + 'folder/'.repeat(90) + 'note.md'
    h.setReply({ ...body, regionId: longId, locations: [{ ...location, regionId: longId }] })
    await h.receipt(['space', 'view', '--region', longId])
    expect(h.seen.at(-1)).toMatchObject({ regionId: longId }); h.setReply(body)
  })
  it('transports mode application separately from unavailable diff data', async () => {
    h.setReply({ ...body, storedOverride: 'diff', effectiveMode: 'diff', content: { status: 'failed', reason: 'diff unavailable' }, changed: true, outcome: 'partial', save: saved })
    expect(await h.receipt(['space', 'view', '--region=region-exact', '--mode', 'diff', '--request-id', 'file-mode-request'], 1)).toMatchObject({ requestId: 'file-mode-request', result: { effectiveMode: 'diff', changed: true, content: { status: 'failed' } } })
    expect(h.seen.at(-1)).toEqual({ ...base, operation: 'space.view', regionId: 'region-exact', mode: 'diff' }); h.setReply(body)
  })
  it('unknown data remains nullable rather than invented support', async () => {
    h.setReply({ ...body, effectiveMode: null, supportedModes: null, data: 'unconfirmed', content: { status: 'unconfirmed', reason: null }, outcome: 'unknown' })
    expect(await h.receipt(['space', 'view', '--region', 'region-exact'], 1)).toMatchObject({ result: { supportedModes: null, data: 'unconfirmed' } }); h.setReply(body)
  })
  it('rejects Agent modes and implicit selectors before contact', async () => {
    for (const args of [['--region', 'self'], ['--region', 'region-exact', '--mode', 'activity']]) {
      const count = h.seen.length; expect((await h.run(['space', 'view', ...args])).code).toBe(1); expect(h.seen).toHaveLength(count)
    }
  })
  it('uses a strict File schema including nonempty support evidence', () => {
    const { operation, ...result } = body
    expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result })).toMatchObject({ result: { supportedModes: ['source', 'diff'] } })
    expect(() => parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result, supportedModes: ['source', 'source'] } })).toThrow()
    expect(() => parseSpaceControlRequest({ ...base, operation, regionId: 'region-exact', mode: 'terminal' })).toThrow()
  })
  it('refuses a receipt for another Region and offers the exact grammar through help', async () => {
    h.setReply({ ...body, regionId: 'replacement-region' }); expect((await h.run(['space', 'view', '--region', 'region-exact'])).code).toBe(1); h.setReply(body)
    const count = h.seen.length, help = await h.run(['space', 'view', '--help'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('source|diff|preview'); expect(h.seen).toHaveLength(count)
  })
})

import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { isLongAgentMuxControlOperation } from '../src/control.js'
import { workfaceCliFixture, location, saved } from './helpers/workface-cli.js'
const base = { schemaVersion: 5, requestId: 'swap-request' }
const body = { operation: 'space.swap' as const, scope: 'tab-layout' as const, regionId: 'region-exact', withRegionId: 'region-other', tabId: 'tab-exact', workspaceId: 'resource-exact',
  beforeOrder: ['region-exact', 'region-other'], afterOrder: ['region-other', 'region-exact'], activeRegionId: 'region-exact', locations: [location], changed: true, outcome: 'swapped' as const, save: saved, issues: [] }
describe('Region exchange public CLI wire', () => {
  const h = workfaceCliFixture(body)
  it('sends only two exact entity IDs and returns the actual shared layout order', async () => {
    expect(await h.receipt(['space', 'swap', '--region', 'region-exact', '--with', 'region-other', '--request-id', 'swap-request'])).toMatchObject({ result: { beforeOrder: body.beforeOrder, afterOrder: body.afterOrder, activeRegionId: 'region-exact' } })
    expect(h.seen.at(-1)).toEqual({ ...base, operation: 'space.swap', regionId: 'region-exact', withRegionId: 'region-other' })
    expect(isLongAgentMuxControlOperation('space.swap')).toBe(true)
    const longId = 'region:file:resource:' + 'folder/'.repeat(90) + 'note.md'
    h.setReply({ ...body, withRegionId: longId, beforeOrder: ['region-exact', longId], afterOrder: [longId, 'region-exact'] })
    await h.receipt(['space', 'swap', '--region', 'region-exact', '--with', longId])
    expect(h.seen.at(-1)).toMatchObject({ withRegionId: longId }); h.setReply(body)
  })
  it('retains a typed partial applied exchange, and does not repeat the operation', async () => {
    h.setReply({ ...body, outcome: 'partial', save: { ...saved, storageFlushRequested: false, reason: 'flush failed' } })
    const count = h.seen.length; expect(await h.receipt(['space', 'swap', '--region', 'region-exact', '--with', 'region-other'], 1)).toMatchObject({ result: { changed: true, outcome: 'partial' } })
    expect(h.seen).toHaveLength(count + 1); h.setReply(body)
  })
  it('treats option-looking other Region IDs as literal data', async () => {
    h.setReply({ ...body, withRegionId: '--help' })
    await h.receipt(['space', 'swap', '--region', 'region-exact', '--with', '--help'])
    expect(h.seen.at(-1)).toMatchObject({ withRegionId: '--help' }); h.setReply(body)
  })
  it('requires both exact IDs and rejects navigation options before contact', async () => {
    for (const args of [['--region', 'region-exact'], ['--region', 'self', '--with', 'region-other'], ['--region', 'region-exact', '--with', 'region-other', '--focus']]) {
      const count = h.seen.length; expect((await h.run(['space', 'swap', ...args])).code).toBe(1); expect(h.seen).toHaveLength(count)
    }
  })
  it('strictly decodes distinct leaf IDs and refuses an additional space selector', () => {
    const { operation, ...result } = body
    expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result })).toMatchObject({ result: { beforeOrder: ['region-exact', 'region-other'] } })
    expect(() => parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result, beforeOrder: ['region-exact', 'region-exact'] } })).toThrow()
    expect(() => parseSpaceControlRequest({ ...base, operation, regionId: 'region-exact', withRegionId: 'region-other', spaceId: 'space-exact' })).toThrow()
  })
  it('does not accept a replacement target receipt and describes replay consequences', async () => {
    h.setReply({ ...body, withRegionId: 'replacement' }); expect((await h.run(['space', 'swap', '--region', 'region-exact', '--with', 'region-other'])).code).toBe(1); h.setReply(body)
    const count = h.seen.length, help = await h.run(['space', 'swap', '--help'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('never repeat blindly'); expect(h.seen).toHaveLength(count)
  })
})

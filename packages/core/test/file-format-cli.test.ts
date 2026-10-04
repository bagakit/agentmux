import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { workfaceCliFixture } from './helpers/workface-cli.js'
const report = { operation: 'file.format' as const, regionId: 'original-file', status: 'formatted' as const, message: null }
describe('original File draft format public wire', () => {
  const h = workfaceCliFixture(report)
  it('discovers and calls the exact Region without save or focus fields', async () => {
    expect((await h.run(['file', 'format', '--help'])).stdout).toContain('without saving')
    expect(await h.receipt(['file', 'format', '--region', 'original-file', '--operation-id', 'format-original'])).toMatchObject({ result: { regionId: 'original-file', status: 'formatted' } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: 'format-original', operation: 'file.format', regionId: 'original-file' })
  })
  it('reports stale and unavailable work without pretending the draft was formatted', async () => {
    for (const status of ['unsupported', 'unavailable', 'stale', 'cancelled', 'failed'] as const) {
      h.setReply({ ...report, status, message: `Format ${status}; source retained.` })
      expect(await h.receipt(['file', 'format', '--region', 'original-file'], 1)).toMatchObject({ result: { status } })
    }
    h.setReply({ ...report, status: 'unchanged' })
    expect(await h.receipt(['file', 'format', '--region', 'original-file'])).toMatchObject({ result: { status: 'unchanged' } })
    h.setReply(report)
  })
  it('rejects replacement targets and unknown formatter statuses', async () => {
    h.setReply({ ...report, regionId: 'replacement-file' })
    expect((await h.run(['file', 'format', '--region', 'original-file'])).code).toBe(1)
    h.setReply(report)
    const request = { schemaVersion: 5, requestId: 'format-original', operation: 'file.format', regionId: 'original-file' }
    expect(parseSpaceControlRequest(request)).toEqual(request)
    expect(() => parseSpaceControlRequest({ ...request, save: true })).toThrow()
    const { operation, ...result } = report
    expect(() => parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'format-original', ok: true, operation, result: { ...result, status: 'saved' } })).toThrow()
  })
})

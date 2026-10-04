import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { workfaceCliFixture } from './helpers/workface-cli.js'

const report = {
  operation: 'file.build' as const, regionId: 'original-file', buildId: 'original-build',
  status: 'running' as const, message: null, log: '', artifact: null
}
describe('explicit original File compilation public wire', () => {
  const h = workfaceCliFixture(report)
  it('discovers and starts only an explicit original draft operation', async () => {
    expect((await h.run(['file', 'build', '--help'])).stdout).toContain('Opening Preview never starts')
    expect(await h.receipt(['file', 'build', '--region', 'original-file', '--operation-id', 'original-build']))
      .toMatchObject({ result: { regionId: 'original-file', buildId: 'original-build', status: 'running' } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: 'original-build', operation: 'file.build', regionId: 'original-file' })
  })
  it('inspects real metadata and cancels the exact original job', async () => {
    h.setReply({ ...report, operation: 'file.build.inspect', status: 'succeeded', artifact: { kind: 'pdf', byteLength: 1024 }, log: 'Compiler finished.' })
    expect(await h.receipt(['file', 'build', 'inspect', '--region', 'original-file', '--build', 'original-build']))
      .toMatchObject({ result: { status: 'succeeded', artifact: { kind: 'pdf', byteLength: 1024 } } })
    expect(h.seen.at(-1)).toMatchObject({ operation: 'file.build.inspect', regionId: 'original-file', buildId: 'original-build' })
    h.setReply({ ...report, operation: 'file.build.cancel', status: 'cancelled', message: 'Compiler exited.' })
    expect(await h.receipt(['file', 'build', 'cancel', '--region', 'original-file', '--build', 'original-build']))
      .toMatchObject({ result: { status: 'cancelled' } })
  })
  it('rejects replaced jobs, false artifacts and ambiguous targets', async () => {
    h.setReply({ ...report, buildId: 'replacement-build' })
    expect((await h.run(['file', 'build', '--region', 'original-file', '--operation-id', 'original-build'])).code).toBe(1)
    h.setReply({ ...report, operation: 'file.build.inspect', regionId: 'replacement-file' })
    expect((await h.run(['file', 'build', 'inspect', '--region', 'original-file', '--build', 'original-build'])).code).toBe(1)
    const request = { schemaVersion: 5, requestId: 'original-build', operation: 'file.build', regionId: 'original-file' }
    expect(parseSpaceControlRequest(request)).toEqual(request)
    expect(() => parseSpaceControlRequest({ ...request, save: true })).toThrow()
    expect(() => parseSpaceControlRequest({ ...request, operation: 'file.build.cancel' })).toThrow()
    const { operation, ...result } = report
    const receipt = { schemaVersion: 5, requestId: 'original-build', ok: true, operation, result }
    expect(() => parseSpaceControlSuccessReceipt({ ...receipt, result: { ...result, status: 'succeeded' } })).toThrow()
    expect(() => parseSpaceControlSuccessReceipt({ ...receipt, result: { ...result, artifact: { kind: 'pdf', byteLength: 1 } } })).toThrow()
    for (const status of ['missing', 'unavailable', 'unknown', 'failed', 'stale', 'unsupported'] as const) {
      h.setReply({ ...report, status, message: `Build ${status}; source retained.` })
      expect(await h.receipt(['file', 'build', '--region', 'original-file', '--operation-id', 'original-build'], 1)).toMatchObject({ result: { status } })
    }
    h.setReply(report)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { parseBrowserTaskControlPayload, parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from '../src/browser-task-control.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const input = { operationId: 'original-operation', concurrency: 2, targets: [{ id: 'one', browserId: 'target-browser', profileId: 'target-profile', parameters: { secret: 'fresh value' } }] }
const summary = { operationId: input.operationId, browserId: 'source', assetId: 'asset', version: 1, status: 'running', targetCount: 1,
  requestedConcurrency: 2, concurrency: 1, counts: { queued: 1, preparing: 0, running: 0, waitingHuman: 0, ready: 0, completed: 0, interrupted: 0, failed: 0, stopped: 0 },
  startedAt: 1, updatedAt: 2, admission: 'confirmed' }
const request = { operation: 'browser.task.parallel', browserId: 'source', assetId: 'asset', version: 1, input } as const
const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop() })
describe('public exact parallel task operation', () => {
  it('preserves explicit target invocation and original managed caller through the business codec', () => {
    const { operation, ...business } = request
    const caller = { agentSessionId: 'original-agent', capability: 'original-capability' }
    const decoded = rpcControlRequest(operation, business, caller)
    expect(decoded).toMatchObject({ ...request, caller })
    expect(parseBrowserTaskControlPayload(decoded)).toEqual(request)
    const result = parseBrowserTaskControlResult(operation, { run: summary })
    expect(() => assertBrowserTaskControlTarget(request, result)).not.toThrow()
    expect(() => assertBrowserTaskControlTarget({ ...request, version: 2 }, result)).toThrow()
    expect(() => assertBrowserTaskControlTarget({ ...request, input: { ...input, operationId: 'replacement' } }, result)).toThrow()
    expect(() => parseBrowserTaskControlPayload({ ...request, input: { ...input, targets: [{ ...input.targets[0], runId: 'fake' }] } })).toThrow()
    expect(() => parseBrowserTaskControlResult(operation, { run: { ...summary, counts: { ...summary.counts, running: 1 } } })).toThrow()
  })
  it('routes start, bounded original target inspection and paged history through the compiled CLI', async () => {
    const probe = new ObjectCliProbe(); probes.push(probe); await probe.start()
    await writeFile(probe.inputPath, JSON.stringify(input))
    const commands = [
      ['browser','task','parallel','--browser','source','--asset','asset','--version','1','--input',probe.inputPath],
      ['browser','task','parallel-inspect','--browser','source','--operation-id',input.operationId,'--after','one','--limit','2'],
      ['browser','task','parallel-list','--browser','source','--before',input.operationId,'--limit','3']
    ]
    for (const args of commands) { const reply = await probe.run(args); expect(reply.code,reply.stderr).toBe(1); expect(reply.stderr).toContain('CLI_ROUTE_PROBE') }
    expect(probe.requests.map(({method,params}) => ({method,params}))).toEqual([
      { method:'browser.task.parallel',params:{browserId:'source',assetId:'asset',version:1,input} },
      { method:'browser.task.parallel-inspect',params:{browserId:'source',operationId:input.operationId,after:'one',limit:2} },
      { method:'browser.task.parallel-list',params:{browserId:'source',before:input.operationId,limit:3} }
    ])
    expect(agentMuxCommandHelp('browser.task.parallel')).toContain('--input')
    expect(agentMuxCommandHelp('browser.task.parallel-inspect')).toContain('--operation-id')
    expect(agentMuxCommandHelp('browser.task.parallel-list')).toContain('--before')
    const before = probe.requests.length
    const invalid = await probe.run(['browser','task','parallel-inspect','--browser','source','--limit','65'])
    expect(invalid.code).toBe(1); expect(probe.requests).toHaveLength(before)
  },45_000)
})

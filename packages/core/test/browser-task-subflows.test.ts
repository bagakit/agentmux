import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { parseBrowserTaskInvocation } from '../src/browser-task-invocation.js'
import { assertBrowserTaskControlTarget, parseBrowserTaskControlPayload, parseBrowserTaskControlResult } from '../src/browser-task-control.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const invocation = () => ({ parameters: { rootValue: 'fresh root' }, calls: { submit: { parameters: { secret: 'fresh child' },
  items: [{ id: 'first', parameters: { label: 'one' } }, { id: 'second', parameters: { label: 'two' } }] } } })
const payload = (extra: Record<string, unknown> = {}) => ({ operation: 'browser.task.run' as const, browserId: 'browser', assetId: 'root', version: 1, ...invocation(), ...extra })
const run = (id: string, assetId: string, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, browserId: 'browser', nextStep: 0, status: 'ready', operationIds: [], startedAt: 1, updatedAt: 2, ...extra })
const inspection = () => ({ rootRunId: 'root-run', currentRunId: 'child-run', operationCount: 1, executedMillis: 2,
  runs: [run('root-run', 'root', { calls: [{ stepId: 'submit', assetId: 'child', version: 1, nextItem: 0, items: [{ id: 'first', runId: 'child-run' }] }] }),
    run('child-run', 'child', { parent: { runId: 'root-run', stepId: 'submit', itemId: 'first' }, operationIds: ['original-op'], executedMillis: 2 })] })
const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop() })

describe('finite fresh task calls at the shared public boundary', () => {
  it('keeps explicit per-item inputs and managed caller identity through the original RPC codec', () => {
    expect(parseBrowserTaskInvocation(invocation())).toEqual(invocation())
    const input = payload()
    const { operation, ...business } = input
    const caller = { agentSessionId: 'original-session', capability: 'exact-capability' }
    const result = rpcControlRequest(operation, business, caller)
    expect(result).toMatchObject({ ...input, caller })
    expect(parseBrowserTaskControlPayload(result)).toEqual(input)
  })
  it.each([
    ['implicit loop', () => ({ parameters: {}, calls: { submit: { parameters: {}, count: 2, items: [] } } })],
    ['duplicate item', () => { const value = invocation(); value.calls.submit.items[1]!.id = 'first'; return value }],
    ['secret from non-string value', () => ({ parameters: {}, calls: { submit: { parameters: { secret: 42 }, items: [{ id: 'first', parameters: {} }] } } })],
    ['child control facts', () => ({ parameters: {}, calls: { submit: { parameters: {}, items: [{ id: 'first', parameters: {}, runId: 'injected' }] } } })],
    ['aggregate input bytes', () => ({ parameters: {}, calls: { submit: { parameters: {}, items: Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, parameters: { value: 'x'.repeat(16_000) } })) } } })],
    ['excessive depth', () => { let value: any = { submit: { parameters: {}, items: [{ id: 'item', parameters: {} }] } }; for (let i = 0; i < 3; i++) value = { submit: { parameters: {}, items: [{ id: 'item', parameters: {}, calls: value }] } }; return { parameters: {}, calls: value } }]
  ] as const)('rejects %s before dispatch without echoing fresh values', (_label, make) => {
    expect(() => parseBrowserTaskInvocation(make())).toThrow()
  })
  it('rejects public execution parent and lease fields, retaining ordinary flat parameter runs', () => {
    expect(() => parseBrowserTaskControlPayload(payload({ parent: { runId: 'unrelated' } }))).toThrow('unsupported field')
    expect(() => parseBrowserTaskControlPayload(payload({ budget: { operations: 999 } }))).toThrow('unsupported field')
    expect(parseBrowserTaskControlPayload(payload({ calls: undefined }))).toEqual(payload({ calls: undefined }))
  })
  it('parses only one exact bounded call tree and binds it to the requested Browser and run', () => {
    const value = inspection()
    const parsed = parseBrowserTaskControlResult('browser.task.inspect', { inspection: value })
    expect(parsed).toEqual({ operation: 'browser.task.inspect', inspection: value })
    expect(() => assertBrowserTaskControlTarget({ operation: 'browser.task.inspect', browserId: 'browser', runId: 'child-run' }, parsed)).not.toThrow()
    expect(() => assertBrowserTaskControlTarget({ operation: 'browser.task.inspect', browserId: 'other' }, parsed)).toThrow('another original run or Browser')
    expect(() => assertBrowserTaskControlTarget({ operation: 'browser.task.inspect', browserId: 'browser', runId: 'other' }, parsed)).toThrow('another original run or Browser')
    expect(() => parseBrowserTaskControlResult('browser.task.inspect', { inspection: { ...value, operationCount: 0 } })).toThrow('costs')
    const wrong = inspection(); (wrong.runs[1] as any).parent.itemId = 'other'
    expect(() => parseBrowserTaskControlResult('browser.task.inspect', { inspection: wrong })).toThrow('original call item')
  })
  it('routes full fresh input and bounded inspection through the compiled CLI, preserving original flat stdin', async () => {
    const probe = new ObjectCliProbe(); probes.push(probe); await probe.start()
    await writeFile(probe.inputPath, JSON.stringify(invocation()))
    for (const [args, stdin] of [
      [['browser', 'task', 'run', '--browser', 'browser', '--asset', 'root', '--version', '1', '--input', probe.inputPath], ''],
      [['browser', 'task', 'run', '--browser', 'browser', '--asset', 'root', '--version', '1', '--input', '-'], JSON.stringify(invocation())],
      [['browser', 'task', 'run', '--browser', 'browser', '--asset', 'root', '--version', '1'], '{"rootValue":"flat input"}'],
      [['browser', 'task', 'inspect', '--browser', 'browser', '--run', 'child-run'], '']
    ] as const) {
      const result = await probe.run(args, stdin)
      expect(result.code, result.stderr).toBe(1)
      expect(result.stderr).toContain('CLI_ROUTE_PROBE')
    }
    expect(probe.requests).toHaveLength(4)
    expect(probe.requests.slice(0, 2).map(request => request.params)).toEqual([0, 1].map(() => ({ browserId: 'browser', assetId: 'root', version: 1, ...invocation() })))
    expect(probe.requests[2]!.params).toEqual({ browserId: 'browser', assetId: 'root', version: 1, parameters: { rootValue: 'flat input' } })
    expect(probe.requests[3]!.params).toEqual({ browserId: 'browser', runId: 'child-run' })
    expect(agentMuxCommandHelp('browser.task.run')).toContain('--input')
    expect(agentMuxCommandHelp('browser.task.inspect')).toContain('--run ID')
  }, 45_000)
})

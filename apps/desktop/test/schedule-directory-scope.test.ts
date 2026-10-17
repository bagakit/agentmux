import { describe, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { parseScheduleRpcParams, validateScheduleRpcResult } from '../../../packages/core/src/public-rpc-schedules.js'
import { createScheduleRpcFixture } from './helpers/schedule-rpc-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const scope = { hostId: 'private-host', workspacePath: new URL("private/home", new URL('/', import.meta.url)).pathname }
const record = (loopId: string, fields: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...scope, loopId, agentSessionId: 'session-' + loopId, providerId: 'generic', afterMs: 90000,
  prompt: 'original ' + loopId, nextCheckAt: 100000, intervalMs: 1000, status: 'active', revision: 1, creationOperationId: 'create-' + loopId, futureIntentId: 'intent-' + loopId, ...fields })
const interval = () => { const { afterMs: _, ...loop } = record('interval'); return loop }
const records = () => [record('first'), record('second', { providerId: 'another-provider', status: 'paused' }), record('neighbor', { workspacePath: new URL("private/home-other", new URL('/', import.meta.url)).pathname }), record('child', { workspacePath: new URL("private/home/child", new URL('/', import.meta.url)).pathname }), record('other-host', { hostId: 'other-host' }), record('container', { workspacePath: '/private' }), interval()]

describe('exact schedule directory scope', () => {
  it('includes all original Sessions and Providers only at the exact Host and directory', async () => {
    const fixture = await createScheduleRpcFixture({ records: records() })
    try {
      const result = await fixture.manager.call('schedule.list', { scope })
      expect(result.schedules.map(item => item.loopId)).toEqual(['first', 'second'])
      expect(validateScheduleRpcResult('schedule.list', result, { scope })).toEqual(result)
      expect((await fixture.rpc.call('schedule.list', { scope })).schedules).toEqual(result.schedules)
      const first = records()[0]!, target = { hostId: first.hostId, workspacePath: first.workspacePath, agentSessionId: first.agentSessionId, providerId: first.providerId }
      expect((await fixture.manager.call('schedule.list', { target })).schedules.map(item => item.loopId)).toEqual(['first'])
      expect((await fixture.manager.call('schedule.list', {})).schedules).toHaveLength(6)
      expect(await fixture.store.load()).toEqual(records())
    } finally { await fixture.dispose() }
  })

  it('rejects ambiguous or malformed selectors and counterfeit cross-scope receipts', () => {
    const first = records()[0]!, target = { hostId: first.hostId, workspacePath: first.workspacePath, agentSessionId: first.agentSessionId, providerId: first.providerId }
    expect(parseScheduleRpcParams('schedule.list', { scope })).toEqual({ scope })
    for (const input of [{ target, scope }, { scope: { hostId: 'private-host' } }, { scope: { ...scope, prefix: true } }, { scope: { ...scope, workspacePath: '' } }, { workspacePath: scope.workspacePath }]) {
      expect(() => parseScheduleRpcParams('schedule.list', input)).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
    for (const wrong of [record('wrong-path', { workspacePath: new URL("private/home-other", new URL('/', import.meta.url)).pathname }), record('wrong-host', { hostId: 'other-host' }), interval()]) {
      expect(() => validateScheduleRpcResult('schedule.list', { executionScope: 'connected-host', schedules: [wrong] }, { scope })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })

  it('uses actual compiled CLI scope JSON through public RPC and Main private Store', async () => {
    const fixture = await createScheduleRpcFixture({ records: records() }), calls = vi.spyOn(fixture.manager, 'call')
    const run = (input: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + fixture.server.path, 'schedule', 'list', '--data', '-'], objectCliEnvironment(fixture.directory), JSON.stringify(input))
    try {
      const success = await run({ scope })
      expect(success.code, success.stderr).toBe(0)
      expect(JSON.parse(success.stdout).result.schedules.map((item: ContinuousProgressLoop) => item.loopId)).toEqual(['first', 'second'])
      expect(calls).toHaveBeenCalledWith('schedule.list', { scope }, expect.objectContaining({ transport: 'unix', principal: expect.objectContaining({ kind: 'user' }) }))
      const count = calls.mock.calls.length, original = records()[0]!
      const failed = await run({ scope, target: { hostId: original.hostId, workspacePath: original.workspacePath, providerId: original.providerId, agentSessionId: original.agentSessionId } })
      expect(failed.code).toBe(1)
      expect(JSON.parse(failed.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CONTROL_REQUEST' } })
      expect(calls).toHaveBeenCalledTimes(count)
      expect(await fixture.store.load()).toEqual(records())
    } finally { calls.mockRestore(); await fixture.dispose() }
  })
})

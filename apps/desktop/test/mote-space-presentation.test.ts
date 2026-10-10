// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { rpcControlRequest, rpcControlResult, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser.js'
import { agentMuxCommandHelp, AGENTMUX_CLI_SKILL } from '../../../packages/core/src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { moteAppearanceSource } from './fixtures/mote-current-expression'
import { executeSpatialControl, type SpatialControlPorts } from '../src/renderer/src/lib/space-agent-control'
const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop(); vi.restoreAllMocks() })
import type { AgentMuxSpaceCatalog } from '../../../packages/core/src/space-control.js'
it('strict public codecs preserve actual owner Host and remaining duration and reject malformed metadata', async () => {
  const owner = moteAppearanceSource(), appearance = (await owner.read()).filter(entry => entry.spaceId === owner.target.key)
  const result = { operation: 'space.ls' as const, catalog: { ...owner.catalog, appearance } }
  const parsed = parseRpcControlResult('space.ls', rpcControlResult('space.ls', result), { target: { spaceId: owner.target.key }, presentation: true }) as { catalog: AgentMuxSpaceCatalog }
  const item = parsed.catalog.appearance?.find(value => value.spaceId === owner.target.key)!.activities![0]!
  expect(item).toMatchObject({ hostId: owner.state.sessions[0]!.hostId, runId: owner.state.sessions[0]!.control.run.runId, agentSessionId: owner.state.sessions[0]!.id, expression: 'thinking' })
  expect(item.activeForMs).toEqual(expect.any(Number)); expect(item.activeForMs).toBeGreaterThan(0)
  for (const bad of [{ activeForMs: -1 }, { activeForMs: Infinity }, { activeForMs: '1000' }, { hostId: '' }, { extraAuthority: true }]) {
    const value = { ...result, catalog: { ...result.catalog, appearance: appearance.map(entry => ({ ...entry, activities: entry.activities?.map(activity => ({ ...activity, ...bad })) })) } }
    expect(() => parseRpcControlResult('space.ls', rpcControlResult('space.ls', value), { target: {}, presentation: true })).toThrow()
  }
  const without = { ...result, catalog: { ...result.catalog, appearance: appearance.map(entry => ({ ...entry, activities: entry.activities?.map(({ hostId: _host, activeForMs: _time, ...identity }) => identity) })) } }
  expect((parseRpcControlResult('space.ls', rpcControlResult('space.ls', without), { target: {}, presentation: true }) as { catalog: AgentMuxSpaceCatalog }).catalog.appearance?.length).toBeGreaterThan(0)
})
it('actual compiled CLI flags reach the Desktop owner and retain nonempty strict results while default reads remain topology-only', async () => {
  const owner = moteAppearanceSource(), reads = vi.fn(owner.read), lifecycle = vi.fn(() => { throw new Error('A presentation read must not start or stop an Agent') })
  const ports = { get: () => owner.state, topics: async () => [owner.topic], appearance: reads,
    patch: lifecycle, launch: lifecycle, creation: lifecycle, createResource: lifecycle, attach: lifecycle, save: lifecycle, focus: lifecycle, isFocused: () => false, notice: lifecycle, closing: () => false } as unknown as SpatialControlPorts
  let invalid = false, failed = false
  const probe = new ObjectCliProbe(async request => {
    if (failed) throw Object.assign(new Error('Original presentation unavailable; input retained'), { code: 'CONTROL_UNAVAILABLE' })
    const input = rpcControlRequest(request.method as 'space.ls' | 'space.inspect', request.params)
    if (input.operation !== 'space.ls' && input.operation !== 'space.inspect') throw new Error('Wrong method')
    const result = await executeSpatialControl(ports, input)
    const { operation, ...body } = result
    const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: input.requestId, ok: true, operation, result: body })
    if (!receipt.ok) throw new Error('Expected exact read')
    const wire = rpcControlResult(request.method as 'space.ls' | 'space.inspect', result)
    if (invalid && wire.catalog && typeof wire.catalog === 'object') (wire.catalog as typeof result.catalog).appearance![0]!.activities![0]!.activeForMs = -1
    return wire
  }); probes.push(probe); await probe.start()
  for (const verb of ['ls', 'inspect']) {
    const read = await probe.run(['space', verb, '--space', owner.target.key, '--presentation'])
    expect(read.code).toBe(0); expect(read.stderr).toBe('')
    const activities = JSON.parse(read.stdout).result.catalog.appearance.find((value: { spaceId: string }) => value.spaceId === owner.target.key).activities
    expect(activities).toHaveLength(1); expect(activities[0].hostId).toBe(owner.state.sessions[0]!.hostId); expect(activities[0].activeForMs).toBeGreaterThan(0)
    expect(probe.requests.at(-1)?.params.presentation).toBe(true)
  }
  const count = reads.mock.calls.length
  const topology = await probe.run(['space', 'ls', '--space', owner.target.key])
  expect(topology.code).toBe(0); expect(JSON.parse(topology.stdout).result.catalog.appearance).toBeUndefined(); expect(reads).toHaveBeenCalledTimes(count)
  expect(probe.requests.at(-1)?.params).not.toHaveProperty('presentation')
  invalid = true
  const bad = await probe.run(['space', 'inspect', '--space', owner.target.key, '--presentation'])
  expect(bad.code).not.toBe(0); expect(JSON.parse(bad.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
  invalid = false; failed = true
  const unavailable = await probe.run(['space', 'inspect', '--space', owner.target.key, '--presentation'])
  expect(unavailable.code).not.toBe(0); expect(JSON.parse(unavailable.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  const requests = probe.requests.length
  const wrong = await probe.run(['space', 'inspect', '--space', owner.target.key, '--presentation=maybe'])
  expect(wrong.code).not.toBe(0); expect(probe.requests).toHaveLength(requests)
  expect(lifecycle).not.toHaveBeenCalled()
  expect(agentMuxCommandHelp('space.ls')).toContain('--presentation')
  expect(agentMuxCommandHelp('space.inspect')).toContain('--presentation')
  expect(agentMuxModuleSkill('space')).toContain('leaf --help')
  expect(AGENTMUX_CLI_SKILL).toContain('amux space --skill')
  const help = await probe.run(['space', '--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('--presentation')
}, 30000)

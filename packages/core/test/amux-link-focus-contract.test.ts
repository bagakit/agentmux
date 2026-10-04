import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { assertControlResultTarget } from '../src/rpc-business-codec.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import type { AgentMuxControlFocusRequest } from '../src/control.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop() })

const sid = "--original SID $HOME/'quoted/中文"
const regionId = "region:exact $PATH/'quoted/中文"
function request(): AgentMuxControlFocusRequest {
  return { schemaVersion: 5, requestId: 'amux-link-focus', operation: 'focus',
    target: { kind: 'space', regionId }, inputPolicy: 'preserve', expectedAgentSessionId: sid }
}
function result() {
  const facts = focusFacts(request())
  facts.navigation.expectedAgentSessionId = sid
  return facts
}

describe('amux Agent link exact Session focus condition', () => {
  it('preserves the original SID independently of the exact spatial identity on the public wire', async () => {
    expect(parseAgentMuxControlRequest(request())).toEqual(request())
    const { parseAgentMuxControlRequest: compiledParse } = await import('../dist/control-host.js')
    expect(compiledParse(request())).toEqual(request())
    const spatialOnly = request()
    delete spatialOnly.expectedAgentSessionId
    expect(parseAgentMuxControlRequest(spatialOnly)).toEqual(spatialOnly)
  })

  it('rejects guessed, empty or non-Region conditions before navigation reaches an owner', () => {
    const invalid = [
      ...[undefined, null, '', 1, {}, ['SID']].map(expectedAgentSessionId => ({ ...request(), expectedAgentSessionId })),
      ...[
        { kind: 'space', spaceId: 'S' }, { kind: 'space', zoneId: 'Z' },
        { kind: 'space', tabId: 'T' }, { kind: 'space', regionId: 'self' },
        { kind: 'goal', goalId: 'G' }, { kind: 'surface', surface: 'space' }
      ].map(target => ({ ...request(), target })),
      { ...request(), expectedSessionId: sid }
    ]
    expect(invalid).toHaveLength(13)
    for (const raw of invalid) expect(() => parseAgentMuxControlRequest(raw), JSON.stringify(raw)).toThrow()
  })

  it('echoes the condition and rejects a validly shaped receipt for a different or omitted Session', async () => {
    const { operation, ...body } = result()
    const receipt = { schemaVersion: 5, requestId: request().requestId, ok: true, operation, result: body }
    expect(parseAgentMuxControlReceipt(receipt)).toMatchObject({ result: {
      navigation: { expectedAgentSessionId: sid, requested: { kind: 'space', regionId } }
    } })
    const { assertControlResultTarget: compiledAssert } = await import('../dist/rpc-business-codec.js')
    for (const assertTarget of [assertControlResultTarget, compiledAssert]) {
      expect(() => assertTarget(request(), result())).not.toThrow()
      const wrong = result(); wrong.navigation.expectedAgentSessionId = 'replacement-SID'
      const missing = result(); delete missing.navigation.expectedAgentSessionId
      expect(() => assertTarget(request(), wrong)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect(() => assertTarget(request(), missing)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      const noCondition = request(); delete noCondition.expectedAgentSessionId
      expect(() => assertTarget(noCondition, result())).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })

  it('routes --expect-session literally through the compiled CLI into the existing space.focus method', async () => {
    const probe = new ObjectCliProbe(); probes.push(probe); await probe.start()
    const reply = await probe.run(['space', 'focus', '--region', regionId, '--expect-session', sid])
    expect(reply.code).toBe(1)
    expect(JSON.parse(reply.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    expect(probe.requests).toHaveLength(1)
    expect(probe.requests[0]).toMatchObject({ method: 'space.focus', params: {
      target: { kind: 'space', regionId }, inputPolicy: 'preserve', expectedAgentSessionId: sid
    } })
    expect(probe.requests[0]!.params).not.toHaveProperty('sessionId')
    expect(agentMuxCommandHelp('space.focus')).toContain('--expect-session')
  })

  it('rejects CLI conditions on non-Region targets and repeated conditions without invoking navigation', async () => {
    const root = await mkdtemp(fixturePath("tmp/amx-link-focus-"))
    const seen: unknown[] = []
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [],
      async execute(request) { seen.push(request); throw new Error('Invalid condition reached navigation owner.') } })
    await server.start()
    const invalid = [
      ['--space', 'S', '--expect-session', sid], ['--zone', 'Z', '--expect-session', sid],
      ['--tab', 'T', '--expect-session', sid], ['--region', 'self', '--expect-session', sid],
      ['--region', regionId, '--expect-session', ''],
      ['--region', regionId, '--expect-session', sid, '--expect-session', sid]
    ]
    expect(invalid).toHaveLength(6)
    try {
      for (const args of invalid) {
        const reply = await runCompiledObjectCli(['space', 'focus', ...args], objectCliEnvironment(root))
        expect(reply.code, reply.stdout || reply.stderr).toBe(1)
        const failure = JSON.parse(reply.stderr || reply.stdout)
        expect(failure).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^INVALID_(CLI_ARGUMENT|CONTROL_REQUEST)$/u) } })
      }
      expect(seen).toHaveLength(0)
    } finally {
      await server.stop(); await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

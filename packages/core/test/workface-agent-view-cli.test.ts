import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { isLongAgentMuxControlOperation } from '../src/control.js'
import { workfaceCliFixture, location, saved } from './helpers/workface-cli.js'

const body = { operation: 'agent.view' as const, scope: 'agent-session' as const, agentSessionId: 'agent-exact', storedOverride: null,
  effectiveMode: 'terminal' as const, sessionFacts: 'unconfirmed' as const,
  regions: [{ regionId: 'region-exact', tabId: 'tab-exact', kind: 'agent' as const, agentSessionId: 'agent-exact', runId: null, execution: null }],
  locations: [location], changed: false, outcome: 'read' as const, save: null, issues: [] }
const base = { schemaVersion: 5, requestId: 'request-exact' }
describe('Agent view public CLI wire', () => {
  const h = workfaceCliFixture(body)
  it('sends an exact Session query without an implicit mode or caller', async () => {
    expect(await h.receipt(['agent', 'view', '--session', 'agent-exact'])).toMatchObject({ operation: 'agent.view', result: { outcome: 'read', save: null, sessionFacts: 'unconfirmed', regions: body.regions } })
    expect(h.seen.at(-1)).toEqual({ ...base, requestId: expect.any(String), operation: 'agent.view', agentSessionId: 'agent-exact' })
    expect(isLongAgentMuxControlOperation('agent.view')).toBe(true)
  })
  it('passes a typed explicit preference and preserves partial applied state as one JSON exit 1', async () => {
    h.setReply({ ...body, storedOverride: 'activity', effectiveMode: 'activity', changed: true, outcome: 'partial', save: { ...saved, reason: 'flush failed' } })
    expect(await h.receipt(['agent', 'view', '--session=agent-exact', '--mode', 'activity', '--request-id', 'request-exact'], 1)).toMatchObject({ requestId: 'request-exact', result: { effectiveMode: 'activity', changed: true, outcome: 'partial' } })
    expect(h.seen.at(-1)).toEqual({ ...base, operation: 'agent.view', agentSessionId: 'agent-exact', mode: 'activity' })
    h.setReply(body)
  })
  it('accepts opaque option-looking exact IDs as data, but refuses self and modes from another owner', async () => {
    h.setReply({ ...body, agentSessionId: '--help' })
    await h.receipt(['agent', 'view', '--session', '--help'])
    expect(h.seen.at(-1)).toMatchObject({ agentSessionId: '--help' })
    h.setReply(body)
    for (const args of [['--session', 'self'], ['--session', 'agent-exact', '--mode', 'preview']]) {
      const count = h.seen.length, result = await h.run(['agent', 'view', ...args])
      expect(result.code).toBe(1); expect(h.seen).toHaveLength(count)
    }
  })
  it('rejects an actual reply for another Session instead of printing claimed success', async () => {
    h.setReply({ ...body, agentSessionId: 'other-agent' })
    const actual = await h.run(['agent', 'view', '--session', 'agent-exact'])
    expect(actual.code).toBe(1); expect(JSON.parse(actual.stderr)).toMatchObject({ ok: false, error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    h.setReply(body)
  })
  it('strictly decodes modes and real nonempty region facts', () => {
    expect(parseSpaceControlRequest({ ...base, operation: 'agent.view', agentSessionId: 'constructor', mode: 'terminal' })).toMatchObject({ agentSessionId: 'constructor', mode: 'terminal' })
    const { operation, ...result } = body
    expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result })).toMatchObject({ result: { regions: body.regions } })
    expect(() => parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result, effectiveMode: 'preview' } })).toThrow()
    expect(() => parseSpaceControlRequest({ ...base, operation, agentSessionId: 'agent-exact', focus: true })).toThrow()
  })
  it('discovers owner-specific help without contacting the owner', async () => {
    const count = h.seen.length, actual = await h.run(['agent', 'view', '--help'])
    expect(actual.code).toBe(0); expect(actual.stdout).toContain('--mode terminal|activity'); expect(h.seen).toHaveLength(count)
  })
})

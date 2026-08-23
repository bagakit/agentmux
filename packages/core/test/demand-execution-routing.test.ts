import { describe, expect, it } from 'vitest'
import { parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'

describe('Demand execution routing', () => {
  it('keeps assignment, start, and handoff as typed operations', () => {
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'routing' }
    const assigned = parseAgentMuxControlRequest({ ...base, operation: 'demand.assign', demandId: 'd-1', projectId: 'p-1', assigneeExecutorId: 'a-1', start: false })
    expect(assigned.operation).toBe('demand.assign')
    expect('start' in assigned && assigned.start).toBe(false)
    expect(parseAgentMuxControlRequest({ ...base, operation: 'demand.start', demandId: 'd-1', sessionId: 's-1' }).operation).toBe('demand.start')
    expect(parseAgentMuxControlRequest({ ...base, operation: 'demand.handoff', demandId: 'd-1', assigneeExecutorId: 'a-2', sessionId: 's-2' }).operation).toBe('demand.handoff')
  })
})

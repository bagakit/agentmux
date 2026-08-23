import { describe, expect, it } from 'vitest'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'

const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'task-request' }

describe('demand control contract', () => {
  it('parses demand create with an auditable decision', () => {
    const request = parseAgentMuxControlRequest({
      ...base, operation: 'demand.create', title: 'Route this request', projectId: 'repo',
      decision: {
        input: 'put this in the repo project', candidates: [{ projectId: 'repo', reason: 'matches workspace context' }],
        selectedProjectId: 'repo', risk: 'low', confirmation: 'user', wikiVersion: 'v1', recordedAt: 10, sourceSessionId: 'session-1'
      }
    })
    expect(request.operation).toBe('demand.create')
    expect('decision' in request && request.decision?.selectedProjectId).toBe('repo')
  })

  it('rejects unknown demand status before it reaches a host', () => {
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.update', demandId: 'task-1', patch: { status: 'running' } })).toThrow(/Demand status is invalid/)
  })

  it('parses stable JSON demand receipts', () => {
    const receipt = parseAgentMuxControlReceipt({
      ...base, ok: true, operation: 'demand.list', result: { demands: [{ id: 'task-1', title: 'One', description: '', status: 'backlog', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' }] }
    })
    expect(receipt.ok && 'demands' in receipt.result && receipt.result.demands[0]?.id).toBe('task-1')
  })

  it('parses assignment and handoff as explicit Demand operations', () => {
    const assigned = parseAgentMuxControlRequest({ ...base, operation: 'demand.assign', demandId: 'task-1', projectId: 'repo', assigneeExecutorId: 'agent-a', start: false })
    expect(assigned.operation).toBe('demand.assign')
    expect('start' in assigned && assigned.start).toBe(false)
    const handoff = parseAgentMuxControlRequest({ ...base, operation: 'demand.handoff', demandId: 'task-1', assigneeExecutorId: 'agent-b', sessionId: 'session-b' })
    expect(handoff.operation).toBe('demand.handoff')
    expect('sessionId' in handoff && handoff.sessionId).toBe('session-b')
    const receipt = parseAgentMuxControlReceipt({
      ...base,
      ok: true,
      operation: 'demand.start',
      result: {
        demand: { id: 'task-1', title: 'One', description: '', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', assigneeExecutorId: 'agent-a', sessionIds: ['session-a'], createdAt: 1, updatedAt: 2, source: 'default-topic' },
        receipt: { demandId: 'task-1', startedAt: 2, sessionId: 'session-a' }
      }
    })
    expect(receipt.ok && 'demand' in receipt.result && receipt.result.demand?.status).toBe('in_progress')
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.delete', demandId: 'task-1', confirmation: 'no' })).toThrow(/explicit confirmation/)
  })
})

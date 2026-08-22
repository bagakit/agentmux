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
    expect(request.decision?.selectedProjectId).toBe('repo')
  })

  it('rejects unknown demand status before it reaches a host', () => {
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.update', demandId: 'task-1', patch: { status: 'running' } })).toThrow(/Demand status is invalid/)
  })

  it('parses stable JSON demand receipts', () => {
    const receipt = parseAgentMuxControlReceipt({
      ...base, ok: true, operation: 'demand.list', result: { demands: [{ id: 'task-1', title: 'One', description: '', status: 'backlog', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' }] }
    })
    expect(receipt.ok && receipt.result.demands[0]?.id).toBe('task-1')
  })
})

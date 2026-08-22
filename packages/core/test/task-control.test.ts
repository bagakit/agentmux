import { describe, expect, it } from 'vitest'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'

const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'task-request' }

describe('task CUI control contract', () => {
  it('parses task create with an auditable decision', () => {
    const request = parseAgentMuxControlRequest({
      ...base, operation: 'task.create', title: 'Route this request', projectId: 'repo',
      decision: {
        input: 'put this in the repo project', candidates: [{ projectId: 'repo', reason: 'matches workspace context' }],
        selectedProjectId: 'repo', risk: 'low', confirmation: 'user', wikiVersion: 'v1', recordedAt: 10, sourceSessionId: 'session-1'
      }
    })
    expect(request.operation).toBe('task.create')
    expect(request.decision?.selectedProjectId).toBe('repo')
  })

  it('rejects unknown task status before it reaches a host', () => {
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'task.update', taskId: 'task-1', patch: { status: 'running' } })).toThrow(/Task status is invalid/)
  })

  it('parses stable JSON task receipts', () => {
    const receipt = parseAgentMuxControlReceipt({
      ...base, ok: true, operation: 'task.list', result: { tasks: [{ id: 'task-1', title: 'One', description: '', status: 'backlog', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' }] }
    })
    expect(receipt.ok && receipt.result.tasks[0]?.id).toBe('task-1')
  })
})

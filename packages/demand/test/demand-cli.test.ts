import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDemandCli } from '../src/cli.js'
import type { Demand } from '../src/demand-types.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-cli-'))
}

async function invoke(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: Record<string, unknown>[]; err: Record<string, unknown>[] }> {
  const out: Record<string, unknown>[] = []
  const err: Record<string, unknown>[] = []
  const code = await runDemandCli(args, {
    env,
    stdout: (text) => out.push(JSON.parse(text) as Record<string, unknown>),
    stderr: (text) => err.push(JSON.parse(text) as Record<string, unknown>),
  })
  return { code, out, err }
}

describe('agentmux-demand CLI', () => {
  it('routes create/list/update/link/decision-log through one stable JSON interface', async () => {
    const root = await tempRoot()
    const created = await invoke(['--root', root, 'create', '--title', 'CLI demand', '--status', 'todo', '--session-id', 'session-a'])
    expect(created.code).toBe(0)
    const { id } = created.out[0]?.demand as Demand
    expect(id).toEqual(expect.any(String))
    expect(created.out[0]).toMatchObject({ schemaVersion: 'agentmux.demand-cli.v1', requestId: expect.any(String), operation: 'create', revision: 1, receipt: { operationId: expect.any(String), demand: { id } } })

    const shown = await invoke(['--root', root, 'show', '--id', id])
    expect(shown.code).toBe(0)
    expect(shown.out[0]).toMatchObject({ demand: { id, title: 'CLI demand' } })

    const linked = await invoke(['--root', root, 'link-session', '--id', id, '--session-id', 'session-b'])
    expect(linked.code).toBe(0)
    const decision = await invoke(['--root', root, 'decision-log', '--id', id, '--question', 'What?', '--decision', 'This', '--rationale', 'Because'])
    expect(decision.code).toBe(0)
    const updated = await invoke(['--root', root, 'update', '--id', id, '--status', 'in_progress', '--priority', 'high'])
    expect(updated.code).toBe(0)

    const listed = await invoke(['--root', root, 'list'])
    expect(listed.out[0]).toMatchObject({ operation: 'list', revision: 4 })
    expect((listed.out[0]?.demands as Array<{ sessionIds: string[]; status: string; decisions: unknown[] }>)[0]).toMatchObject({
      sessionIds: ['session-a', 'session-b'],
      status: 'in_progress',
      decisions: [{ question: 'What?', decision: 'This' }],
    })
  })

  it('rejects a caller-supplied creation ID before saving a Demand', async () => {
    const root = await tempRoot()
    const rejected = await invoke(['--root', root, 'create', '--id', 'd-cli', '--title', 'Custom identity'])
    expect(rejected.code).toBe(1)
    expect(rejected.out).toEqual([])
    expect(rejected.err[0]).toMatchObject({ error: { code: 'INVALID_INPUT', phase: 'validate', message: expect.stringContaining('--id') } })

    const listed = await invoke(['--root', root, 'list'])
    expect(listed.out[0]).toMatchObject({ revision: 0, demands: [] })
  })

  it('keeps assignment, explicit start, no-start, and handoff as auditable Demand operations', async () => {
    const root = await tempRoot()
    const created = await invoke(['--root', root, 'create', '--title', 'Route me'])
    const { id } = created.out[0]?.demand as Demand
    const assigned = await invoke(['--root', root, 'assign', '--id', id, '--project-id', 'project-a', '--assignee-session-id', 'session-a', '--no-start'])
    expect(assigned.code).toBe(0)
    expect(assigned.out[0]).toMatchObject({ startRequested: false, demand: { status: 'backlog', projectId: 'project-a', assigneeSessionIds: ['session-a'] } })
    const started = await invoke(['--root', root, 'start', '--id', id, '--session-id', 'session-a'])
    expect(started.code).toBe(0)
    expect(started.out[0]).toMatchObject({ submitted: false, demand: { status: 'in_progress', sessionIds: ['session-a'] } })
    const handedOff = await invoke(['--root', root, 'handoff', '--id', id, '--to-session', 'session-b'])
    expect(handedOff.code).toBe(0)
    expect(handedOff.out[0]).toMatchObject({ demand: { assigneeSessionIds: ['session-b'], sessionIds: ['session-a', 'session-b'] } })
  })

  it('accepts the explicit environment root and emits typed JSON failures', async () => {
    const root = await tempRoot()
    const listed = await invoke(['list'], { AGENTMUX_DEMAND_ROOT: root })
    expect(listed.code).toBe(0)
    expect(listed.out[0]).toMatchObject({ operation: 'list', revision: 0, demands: [] })

    const missing = await invoke(['--root', root, 'show', '--id', 'missing'])
    expect(missing.code).toBe(1)
    expect(missing.err[0]).toMatchObject({ schemaVersion: 'agentmux.demand-cli.v1', ok: false, error: { code: 'NOT_FOUND', phase: 'validate' } })
  })

  it('requires an explicit delete confirmation', async () => {
    const root = await tempRoot()
    const created = await invoke(['--root', root, 'create', '--title', 'Delete me'])
    const { id } = created.out[0]?.demand as Demand
    const blocked = await invoke(['--root', root, 'delete', '--id', id])
    expect(blocked.code).toBe(1)
    expect(blocked.err[0]).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    const deleted = await invoke(['--root', root, 'delete', '--id', id, '--confirm', 'delete'])
    expect(deleted.code).toBe(0)
    expect(deleted.out[0]).toMatchObject({ operation: 'delete', receipt: { operationId: expect.any(String) } })
  })
})

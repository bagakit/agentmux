import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDemandCli } from '../src/cli.js'

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
    const created = await invoke(['--root', root, 'create', '--id', 'd-cli', '--title', 'CLI demand', '--status', 'todo', '--session-id', 'session-a'])
    expect(created.code).toBe(0)
    expect(created.out[0]).toMatchObject({ schemaVersion: 'agentmux.demand-cli.v1', operation: 'create', revision: 1 })

    const linked = await invoke(['--root', root, 'link-session', '--id', 'd-cli', '--session-id', 'session-b'])
    expect(linked.code).toBe(0)
    const decision = await invoke(['--root', root, 'decision-log', '--id', 'd-cli', '--question', 'What?', '--decision', 'This', '--rationale', 'Because'])
    expect(decision.code).toBe(0)
    const updated = await invoke(['--root', root, 'update', '--id', 'd-cli', '--status', 'in_progress', '--priority', 'high'])
    expect(updated.code).toBe(0)

    const listed = await invoke(['--root', root, 'list'])
    expect(listed.out[0]).toMatchObject({ operation: 'list', revision: 4 })
    expect((listed.out[0]?.demands as Array<{ sessionIds: string[]; status: string; decisions: unknown[] }>)[0]).toMatchObject({
      sessionIds: ['session-a', 'session-b'],
      status: 'in_progress',
      decisions: [{ question: 'What?', decision: 'This' }],
    })
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
})

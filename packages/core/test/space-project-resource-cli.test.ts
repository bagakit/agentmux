import { afterEach, describe, expect, it } from 'vitest'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop() })
async function start(handle?: ConstructorParameters<typeof ObjectCliProbe>[0]) {
  const probe = new ObjectCliProbe(handle); probes.push(probe); await probe.start(); return probe
}

describe('Project resources and Space placement through the compiled CLI', () => {
  it('sends an exact Project source and independent Space without requiring a first Tab anchor', async () => {
    const probe = await start()
    const result = await probe.run(['agent', 'open', '--executor', 'E', '--project', 'P',
      '--source-workspace', 'W', '--space', 'MOTE', '--new-zone', '--worktree', '--new-branch', 'feature/one',
      '--path', 'work/one', '--new-tab', '--prompt', 'First task', '--operation-id', 'OPEN-ONE'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    expect(probe.requests).toHaveLength(1)
    expect(probe.requests[0]).toMatchObject({ method: 'agent.open', params: {
      operationId: 'OPEN-ONE', content: { kind: 'new-agent', executorId: 'E', prompt: 'First task' },
      destination: { spaceId: 'MOTE', newTab: true, newZone: {
        kind: 'worktree', projectId: 'P', sourceWorkspaceId: 'W', branch: 'feature/one', path: 'work/one', createBranch: true
      } }, focus: false
    } })
    expect(probe.requests[0]!.id).not.toBe('OPEN-ONE')
    expect(probe.requests[0]!.params.destination).not.toHaveProperty('tabId')
  })

  it('preserves retained resource, Session and prompt uncertainty; reads the original operation without repeating a write', async () => {
    const retained = {
      outcome: 'partial', operationId: 'OPEN-RETAINED', from: null, to: null,
      resource: { projectId: 'P', sourceWorkspaceId: 'W', hostId: 'EXEC', workspaceId: 'W-NEW', path: 'work/kept', kind: 'worktree', branch: 'feature/kept' },
      agent: { agentSessionId: 'SID', runId: 'RUN', providerId: 'codex', executorId: 'E', hostId: 'EXEC', cwd: 'work/kept',
        createOperationId: 'OPEN-RETAINED', initialPrompt: 'unconfirmed' },
      save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null },
      issues: [{ step: 'first-prompt', code: 'INITIAL_PROMPT_UNCONFIRMED', message: 'Delivery is unconfirmed.', recovery: 'Read the original operation; do not resend.' }]
    }
    const inspected = { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      request: { operationId: 'OPEN-RETAINED', known: true, report: retained } }
    const probe = await start(request => request.method === 'space.inspect' ? inspected : retained)
    const opened = await probe.run(['agent', 'open', '--executor', 'E', '--project', 'P', '--space', 'MOTE',
      '--new-zone', '--worktree', '--branch', 'feature/kept', '--path', 'work/kept', '--new-tab', '--prompt', 'First task', '--operation-id', 'OPEN-RETAINED'])
    expect(opened.code).toBe(1)
    expect(opened.stderr).toBe('')
    expect(JSON.parse(opened.stdout).result).toEqual(retained)
    const read = await probe.run(['space', 'inspect', '--operation-id', 'OPEN-RETAINED'])
    expect(read.code).toBe(1)
    expect(JSON.parse(read.stdout).result).toEqual(inspected)
    expect(probe.requests.map(request => ({ method: request.method, operationId: request.params.operationId, target: request.params.target }))).toEqual([
      { method: 'agent.open', operationId: 'OPEN-RETAINED', target: undefined },
      { method: 'space.inspect', operationId: undefined, target: { operationId: 'OPEN-RETAINED' } }
    ])
  })

  it('rejects resource qualifiers on existing Zones and missing Project before any RPC request', async () => {
    const probe = await start()
    const invalid = [
      ['--zone', 'Z', '--source-workspace', 'W'],
      ['--zone', 'Z', '--project', 'P'],
      ['--space', 'S', '--new-zone', '--directory', 'work/one', '--source-workspace', 'W'],
      ['--space', 'S', '--new-zone', '--worktree', '--branch', 'feature/one', '--path', 'work/one'],
      ['--space', 'S', '--new-zone', '--directory', 'work/one', '--project', '']
    ]
    expect(invalid.length).toBeGreaterThan(0)
    for (const placement of invalid) {
      const result = await probe.run(['agent', 'open', '--executor', 'E', '--new-tab', ...placement])
      expect(result.code, placement.join(' ')).toBe(1)
      expect(JSON.parse(result.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
    }
    expect(probe.requests).toEqual([])
  })
})

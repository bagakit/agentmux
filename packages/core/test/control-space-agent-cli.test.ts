import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlRequest, type AgentMuxControlResult,
  type AgentMuxSpaceCatalog, type AgentMuxSpaceMutationReport } from '../src/control.js'
import { AgentMuxError } from '../src/errors.js'

// Mutation runs use an isolated copy of the same public bin/dist, never the shared build.
const cli = process.env.AGENTMUX_TEST_SPACE_CLI ?? fileURLToPath(new URL('../bin/agentmux', import.meta.url))
// Real opaque keys can exceed the ordinary 512-byte ID limit through nested absolute paths.
const spaceId = JSON.stringify(['local', `/directory with spaces/${'long-directory/'.repeat(70)}`])
const zoneId = JSON.stringify([spaceId, 'workspace', 'ws-target'])
const address = { spaceId, zoneId, workspaceId: 'ws-target', tabId: 'tab-target', regionId: 'region-target' }
const catalog: AgentMuxSpaceCatalog = {
  spaces: [{ spaceId, kind: 'folder', name: 'Target', hostId: 'local', directoryPath: '/repo', projectId: '["local","/repo"]' }],
  zones: [{ spaceId, zoneId, workspaceId: 'ws-target', kind: 'worktree', hostId: 'local', directoryPath: '/worktree', branch: 'task' }],
  tabs: [{ spaceId, zoneId, workspaceId: 'ws-target', tabId: 'tab-target', groupId: 'group-target', name: null, regionIds: ['region-target'] }],
  regions: [{ ...address, kind: 'agent', agentSessionId: 'agent-target', runId: 'run-target', execution: { hostId: 'original-host', cwd: '/original-cwd' } }]
}
function report(requestId: string, outcome: AgentMuxSpaceMutationReport['outcome'] = 'opened'): AgentMuxSpaceMutationReport {
  return { requestId, outcome, from: outcome === 'moved' ? { ...address, tabId: 'original-tab' } : null, to: address,
    agent: { agentSessionId: 'agent-target', runId: 'run-target', providerId: 'codex', executorId: 'saved-executor', hostId: 'original-host',
      cwd: '/original-cwd', createOperationId: 'creation-op', initialPrompt: 'confirmed' }, resource: null,
    save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }, issues: [] }
}

describe('public built Agent-first Space CLI uses one private Control owner', () => {
  let root: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[]
  let outcome: AgentMuxSpaceMutationReport['outcome'], failOwner: boolean, inspectKnown: boolean
  beforeEach(async () => {
    root = await mkdtemp('/tmp/amx-space-cli-')
    seen = []; outcome = 'opened'; failOwner = false; inspectKnown = true
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (failOwner) throw new AgentMuxError('Private owner unavailable; result unconfirmed.', 'CONTROL_OWNER_LOST')
      if (request.operation === 'space.ls') return { operation: request.operation, catalog }
      if (request.operation === 'space.inspect') return { operation: request.operation, catalog,
        ...('requestId' in request.target ? { request: { requestId: request.target.requestId, known: inspectKnown,
          report: inspectKnown ? report(request.target.requestId, outcome) : null } } : {}) }
      if (request.operation === 'agent.open' || request.operation === 'space.mv') {
        const actual = report(request.requestId, request.operation === 'space.mv' && outcome === 'opened' ? 'moved' : outcome)
        if (outcome === 'partial' || outcome === 'unknown') {
          actual.agent!.initialPrompt = 'unknown'
          actual.issues = [{ step: 'initial-prompt', code: 'UNCONFIRMED', message: 'No receipt.', recovery: 'Inspect the request.', candidates: [{ spaceId, zoneId }] }]
        }
        return request.operation === 'agent.open' ? { operation: request.operation, ...actual } : { operation: request.operation, ...actual }
      }
      if (request.operation === 'open.terminal') return { operation: request.operation,
        region: { kind: 'terminal', workspaceId: 'ws', tabId: 'tab', regionId: 'term', runId: 'term-run' } }
      if (request.operation === 'open.browser') return { operation: request.operation,
        region: { kind: 'browser', workspaceId: 'ws', tabId: 'tab', regionId: 'browser', browserId: 'browser-id' } }
      if (request.operation === 'list.projects') return { operation: request.operation, projects: [{ projectId: spaceId, name: 'Repository group',
        hostId: 'local', path: '/repo', kind: 'git', repoPath: '/repo', branch: null, activeAgentSessionIds: ['agent-target'] }] }
      throw new Error(`Unexpected private operation: ${request.operation}`)
    } }, join(root, 'control.sock'))
    await server.start()
  })
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true }) })
  async function run(args: readonly string[], managed = false) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
        AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_ENV: managed ? '1' : undefined,
        AGENTMUX_AGENT_SESSION_ID: managed ? 'caller-session' : undefined
      } })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Private Space CLI exceeded test budget.')) }, 10_000)
      child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    })
  }
  function json(output: { code: number; stdout: string; stderr: string }, code = 0) {
    expect(output.code, output.stderr).toBe(code)
    expect(output.stderr).toBe('')
    expect(output.stdout.trim().split('\n')).toHaveLength(1)
    return parseAgentMuxControlReceipt(JSON.parse(output.stdout))
  }
  async function raw(value: unknown) {
    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(server.path); let reply = ''
      socket.setEncoding('utf8'); socket.once('connect', () => socket.end(`${JSON.stringify(value)}\n`))
      socket.on('data', value => { reply += value }); socket.once('error', reject)
      socket.once('end', () => { try { resolve(JSON.parse(reply)) } catch (error) { reject(error) } })
    })
  }

  it('roundtrips discovery IDs unchanged into an anchorless first Agent Tab with a single prompt request', async () => {
    expect(Buffer.byteLength(zoneId)).toBeGreaterThan(512)
    const discovery = json(await run(['space', 'ls', '--zone', zoneId]))
    expect(discovery).toMatchObject({ operation: 'space.ls', result: { catalog } })
    const opened = json(await run(['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId, '--new-tab', '--prompt', '--help', '--request-id', 'pmo-first-tab']))
    expect(opened).toMatchObject({ requestId: 'pmo-first-tab', operation: 'agent.open', result: { ...report('pmo-first-tab') } })
    expect(seen).toEqual([
      { schemaVersion: 5, requestId: expect.any(String), operation: 'space.ls', target: { zoneId } },
      { schemaVersion: 5, requestId: 'pmo-first-tab', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'saved-executor', prompt: '--help' },
        destination: { zoneId, newTab: true }, focus: false }
    ])
  })

  it.each([['--new-branch', true], ['--branch', false]] as const)('transports a new Git Zone with %s without running a second send', async (branchFlag, createBranch) => {
    json(await run(['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--new-zone', '--worktree',
      '--path', '/literal path/$SHELL', branchFlag, 'feat/task', '--focus', '--prompt', 'task']))
    expect(seen).toEqual([{ schemaVersion: 5, requestId: expect.any(String), operation: 'agent.open',
      content: { kind: 'new-agent', executorId: 'saved-executor', prompt: 'task' }, destination: {
        spaceId, newTab: true, newZone: { kind: 'worktree', path: '/literal path/$SHELL', branch: 'feat/task', createBranch }
      }, focus: true }])
  })

  it('transports a non-Git directory Zone and precise parent selectors without rewriting the path', async () => {
    json(await run(['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--new-zone', '--directory', '/existing $DIR/ ']))
    json(await run(['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--zone', zoneId, '--tab', 'parent-tab', '--region', 'anchor', '--split', 'above'], true))
    expect(seen).toEqual([
      { schemaVersion: 5, requestId: expect.any(String), operation: 'agent.open', content: { kind: 'new-agent', executorId: 'saved-executor' },
        destination: { spaceId, newTab: true, newZone: { kind: 'directory', path: '/existing $DIR/ ' } }, focus: false },
      { schemaVersion: 5, requestId: expect.any(String), operation: 'agent.open', content: { kind: 'new-agent', executorId: 'saved-executor' },
        destination: { spaceId, zoneId, tabId: 'parent-tab', regionId: 'anchor', split: 'above' }, focus: false, caller: { agentSessionId: 'caller-session' } }
    ])
  })

  it('uses the same new destination language for additional Session display and exact source movement', async () => {
    json(await run(['agent', 'open', '--session', 'agent-target', '--zone', zoneId]))
    const moved = json(await run(['space', 'mv', '--from-region', 'source-region', '--expect-session', 'agent-target', '--zone', zoneId, '--new-tab', '--request-id', 'move-id']))
    expect(moved).toMatchObject({ operation: 'space.mv', result: { outcome: 'moved', from: { regionId: 'region-target' },
      agent: { agentSessionId: 'agent-target', runId: 'run-target', hostId: 'original-host', cwd: '/original-cwd' } } })
    expect(seen).toEqual([
      { schemaVersion: 5, requestId: expect.any(String), operation: 'agent.open', content: { kind: 'agent-session', agentSessionId: 'agent-target' }, destination: { zoneId, newTab: true }, focus: false },
      { schemaVersion: 5, requestId: 'move-id', operation: 'space.mv', fromRegionId: 'source-region', expectedAgentSessionId: 'agent-target', destination: { zoneId, newTab: true }, focus: false }
    ])
  })

  it.each(['partial', 'unknown'] as const)('retains one typed %s report and exact candidates with nonzero exit', async state => {
    outcome = state
    const receipt = json(await run(['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--request-id', 'partial-id']), 1)
    expect(receipt).toMatchObject({ requestId: 'partial-id', operation: 'agent.open', result: { outcome: state,
      agent: { agentSessionId: 'agent-target', initialPrompt: 'unknown' }, issues: [{ candidates: [{ spaceId, zoneId }] }], save: { diskDurability: 'unconfirmed' } } })
    expect(seen.map(request => request.operation)).toEqual(['agent.open'])
  })

  it.each(['partial', 'unknown'] as const)('retains a %s move report without issuing a lifecycle or resend operation', async state => {
    outcome = state
    const receipt = json(await run(['space', 'mv', '--from-region', 'source-region', '--expect-session', 'agent-target', '--zone', zoneId]), 1)
    expect(receipt).toMatchObject({ operation: 'space.mv', result: { outcome: state, agent: { agentSessionId: 'agent-target', runId: 'run-target', cwd: '/original-cwd' } } })
    expect(seen.map(request => request.operation)).toEqual(['space.mv'])
  })

  it('returns generated identities only in final receipts and preserves explicit identity on owner loss', async () => {
    const receipt = json(await run(['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId]))
    expect(receipt.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen).toHaveLength(1); expect(seen[0]!.requestId).toBe(receipt.requestId)
    failOwner = true
    const failed = await run(['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId, '--request-id', 'known-before-call'])
    expect(failed.code).toBe(1); expect(failed.stdout).toBe('')
    expect(failed.stderr.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(failed.stderr)).toMatchObject({ requestId: 'known-before-call', operation: 'agent.open', error: { code: 'CONTROL_OWNER_LOST' } })
    expect(seen.map(request => request.operation)).toEqual(['agent.open', 'agent.open'])
  })

  it('keeps caller-supplied repeat IDs and normalized inputs and only inspects a lost receipt', async () => {
    const args = ['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId, '--request-id', 'reconcile-id']
    json(await run(args)); json(await run([...args, '--new-tab']))
    expect(seen).toHaveLength(2); expect(seen[1]).toEqual(seen[0])
    expect(json(await run(['space', 'inspect', '--request', 'reconcile-id'])))
      .toMatchObject({ operation: 'space.inspect', result: { request: { requestId: 'reconcile-id', known: true, report: report('reconcile-id') } } })
    expect(seen.map(request => request.operation)).toEqual(['agent.open', 'agent.open', 'space.inspect'])
  })

  it.each([null, 'partial', 'unknown'] as const)('exits nonzero when request inspection reports %s without retrying the operation', async state => {
    inspectKnown = state !== null
    if (state) outcome = state
    const receipt = json(await run(['space', 'inspect', '--request', 'unconfirmed-request']), 1)
    expect(receipt).toMatchObject({ operation: 'space.inspect', result: { request: {
      requestId: 'unconfirmed-request', known: state !== null,
      report: state ? { requestId: 'unconfirmed-request', outcome: state } : null
    } } })
    expect(seen).toEqual([{ schemaVersion: 5, requestId: expect.any(String), operation: 'space.inspect',
      target: { requestId: 'unconfirmed-request' } }])
  })

  it('keeps real Project discovery separate from PMO Workspace resource references', async () => {
    expect(json(await run(['list', 'projects']))).toMatchObject({ result: { projects: [{ projectId: spaceId, repoPath: '/repo' }] } })
    const workspaces = JSON.parse((await run(['pmo', 'workspaces', '--workspace', 'ws-target'])).stdout)
    expect(workspaces).toMatchObject({ operation: 'pmo.workspaces', result: { workspaces: [{ workspaceId: 'ws-target', zones: catalog.zones }] } })
    expect(workspaces.result).not.toHaveProperty('projects')
    expect(seen.map(request => request.operation)).toEqual(['list.projects', 'space.ls'])
  })

  it.each([
    ['open', 'agent', '--agent', 'saved-executor', '--right-of', 'anchor'],
    ['agent', 'open', '--agent', 'saved-executor', '--zone', zoneId],
    ['agent', 'open', '--executor', 'saved-executor', '--new-tab-after', 'tab'],
    ['agent', 'open', '--executor', 'saved-executor'],
    ['agent', 'open', '--executor', 'saved-executor', '--session', 'agent-target', '--zone', zoneId],
    ['agent', 'open', '--session', 'agent-target', '--zone', zoneId, '--prompt', 'forbidden'],
    ['agent', 'open', '--session', 'agent-target', '--space', spaceId, '--new-zone', '--directory', '/existing'],
    ['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId, '--zone', zoneId],
    ['agent', 'open', '--executor', 'saved-executor', '--zone', zoneId, '--split', 'right'],
    ['agent', 'open', '--executor', 'saved-executor', '--region', 'occupied', '--new-tab'],
    ['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--worktree'],
    ['agent', 'open', '--executor', 'saved-executor', '--space', spaceId, '--new-zone', '--worktree', '--path', '/tmp', '--branch', 'a', '--new-branch', 'b'],
    ['space', 'inspect', '--request', 'id', '--region', 'region-target'],
    ['space', 'inspect'], ['space', 'ls', '--region', 'region-target'],
    ['space', 'mv', '--from-region', 'source-region', '--zone', zoneId],
    ['space', 'mv', '--from-region', 'source-region', '--expect-session', 'agent-target', '--space', spaceId, '--new-zone', '--directory', '/tmp']
  ])('rejects grammar %j before any owner operation', async (...args) => {
    const output = await run(args)
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    if (args.length === 4 && args[0] === 'agent') expect(JSON.parse(output.stderr).error.message).toContain('agentmux space ls')
    expect(seen).toEqual([])
  })

  it('preserves all four non-Agent split directions, launcher placement and explicit Tab anchors', async () => {
    for (const [flag, direction] of [['--left-of', 'left'], ['--right-of', 'right'], ['--above', 'up'], ['--below', 'down']]) {
      json(await run(['open', 'terminal', '--command', 'literal command', flag!, 'self'], true))
      expect(seen.at(-1)).toMatchObject({ operation: 'open.terminal', shellCommand: 'literal command',
        destination: { kind: 'split', direction, region: { kind: 'self' } }, caller: { agentSessionId: 'caller-session' } })
    }
    json(await run(['open', 'browser', '--url', 'https://example.org', '--tab', 'self', '--new-tab'], true))
    json(await run(['open', 'terminal', '--in-region', 'launcher']))
    expect(seen.slice(-2)).toMatchObject([
      { operation: 'open.browser', destination: { kind: 'new-tab', after: { kind: 'self' } } },
      { operation: 'open.terminal', destination: { kind: 'launcher', regionId: 'launcher' } }
    ])
    expect(seen).toHaveLength(6)
    const invalid = await run(['open', 'terminal', '--tab', 'self'])
    expect(invalid.code).toBe(1); expect(seen).toHaveLength(6)
  })

  it('prints offline help/skill for new grammar and rejects obsolete help namespaces', async () => {
    await server.stop()
    for (const args of [['agent', 'open', '--help'], ['space', 'mv', '--help'], ['space', 'inspect', '--help'], ['--skill']]) {
      const output = await run(args)
      expect(output.code).toBe(0); expect(output.stderr).toBe('')
      expect(output.stdout.length).toBeGreaterThan(100)
      expect(output.stdout).not.toContain('--new-tab-after'); expect(output.stdout).not.toContain('agentmux open agent')
    }
    expect((await run(['open', 'agent', '--help'])).code).toBe(1)
    expect(seen).toEqual([])
  })

  it.each([
    { content: { kind: 'new-agent', executorId: 'executor', extra: true } },
    { content: { kind: 'agent-session', agentSessionId: 'session', prompt: 'forbidden' } },
    { destination: { zoneId, newTab: true, regionId: 'region' } },
    { destination: { spaceId, newZone: { kind: 'directory', path: '/dir', branch: 'forbidden' } } },
    { destination: { zoneId, extra: true } }, { focus: 1 }, { extra: true }
  ])('rejects malformed public transport %j without entering the owner', async overrides => {
    expect(await raw({ schemaVersion: 5, requestId: 'malformed', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'executor' },
      destination: { zoneId }, focus: false, ...overrides })).toMatchObject({ ok: false, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([])
  })
})

describe('strict Space Control transport has bounded exact identities and complete reports', () => {
  const input = { schemaVersion: 5, requestId: 'req', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'executor' }, destination: { zoneId, newTab: true }, focus: false }
  const receipt = (result: unknown) => ({ schemaVersion: 5, requestId: 'req', ok: true, operation: 'agent.open', result })
  it('preserves exact nested keys and all mutation facts without claiming flush durability', () => {
    expect(parseAgentMuxControlRequest(input)).toEqual({ ...input, destination: { zoneId, newTab: true } })
    expect(parseAgentMuxControlReceipt(receipt(report('req')))).toEqual(receipt(report('req')))
    expect(() => parseAgentMuxControlRequest({ ...input, operation: 'open.agent' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
  it.each([
    { ...report('req'), requestId: 'wrong-request' },
    { ...report('req'), save: { ...report('req').save, diskDurability: 'confirmed' } },
    { ...report('req'), agent: { ...report('req').agent, initialPrompt: 'accepted' } },
    { ...report('req'), to: { ...address, regionId: 'self' } },
    { ...report('req'), issues: [{ step: 'target', code: 'AMBIGUOUS', message: 'Choose', recovery: 'Select a Zone', candidates: [{ zoneId, extra: true }] }] },
    { ...report('req'), issues: [] , extra: true }
  ])('rejects incomplete or misleading mutation report %#', result => {
    expect(() => parseAgentMuxControlReceipt(receipt(result))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('rejects getters, reserved IDs, empty IDs, oversized keys and complete envelope overflow', () => {
    for (const destination of [{ zoneId: 'self' }, { zoneId: '' }, { zoneId: 'x'.repeat(16 * 1024 + 1) },
      Object.defineProperty({}, 'zoneId', { enumerable: true, get: () => { throw new Error('Must not execute.') } })]) {
      expect(() => parseAgentMuxControlRequest({ ...input, destination })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
    expect(() => parseAgentMuxControlRequest({ ...input, content: { kind: 'new-agent', executorId: 'executor', prompt: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlReceipt(receipt({ ...report('req'), issues: [{ step: 'large', code: 'LARGE', message: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES), recovery: 'read' }] })))
      .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it('rejects header accessors without executing them before the strict parser', () => {
    let invoked = 0
    const accessor = { enumerable: true, get: () => { invoked += 1; throw new Error('Must not execute.') } }
    for (const key of ['operation', 'schemaVersion', 'requestId']) {
      const value = Object.defineProperty({ ...input }, key, accessor)
      expect(() => parseAgentMuxControlRequest(value)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
    for (const key of ['operation', 'schemaVersion', 'requestId', 'ok', 'result']) {
      const value = Object.defineProperty(receipt(report('req')), key, accessor)
      expect(() => parseAgentMuxControlReceipt(value)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
    expect(invoked).toBe(0)
  })
  it('requires unique catalog identities and exact inspect selector exclusivity', () => {
    expect(() => parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'req', ok: true, operation: 'space.ls',
      result: { catalog: { ...catalog, zones: [...catalog.zones, ...catalog.zones] } } })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'req', operation: 'space.inspect', target: { requestId: 'other', zoneId } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
})

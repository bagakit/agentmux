import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { sep as _tail_sep } from 'node:path'
import { fixtureIso as _tail_fixtureIso } from '../../../test/fixture-values.mjs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp, AGENTMUX_CLI_SKILL } from '../src/agentmux-cli-help.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'

const NATIVE = '19d557c3-7a9c-4e1f-a566-913c06753520'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(_tail_sep, 'tmp', "amx-native-public-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'provider'), workspacePath = join(root, 'workspace')
  const sessions = join(home, 'sessions', ..._tail_fixtureIso(0).slice(0, 10).split('-'))
  await mkdir(sessions, { recursive: true }); await mkdir(workspacePath)
  const transcriptPath = join(sessions, 'rollout-original.jsonl')
  await writeFile(transcriptPath, JSON.stringify({ type: 'session_meta', timestamp: _tail_fixtureIso(0), payload: {
    id: NATIVE, cwd: workspacePath, source: 'cli', timestamp: _tail_fixtureIso(0)
  } }) + '\n')
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: NATIVE, thread_name: 'Original conversation' }) + '\n')
  await writeFile(join(sessions, 'rollout-damaged.jsonl'), '{damaged\n')
  const providers = new AgentProviderRegistry(), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const executorOwner = new AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId: 'original-native-owner', catalog: () => providers.catalog() })
  await executorOwner.configure({ executorId: 'native-custom', config: {
    label: 'Original Executor', providerId: 'codex', command: process.execPath, args: [],
    env: { CODEX_HOME: home, PRIVATE_SECRET: 'catalog-must-not-leak' }, injectAgentMuxGuide: true
  } })
  const client = new AgentMuxClient({ store, hostExecutorOwner: executorOwner })
  cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Runtime handshake intentionally unavailable'))
  const native = await client.listHostNativeAgentSessions({ executorId: 'native-custom', workspacePath })
  expect(native.sessions).toHaveLength(1)
  const source = native.sessions[0]!.source
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-managed', providerId: 'codex', executorId: 'native-custom', hostId: 'local',
    workspacePath, run: { runId: 'original-run' }, nativeHandle: source.nativeHandle, retiredRuns: [],
    hookBindingId: 'fixture-hook', hookToken: 'fixture-token', capabilityHash: hashAgentCapability(issueAgentCapability()), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 2) })
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }] }, join(root, 'control.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  const cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(root), stdin)
  return { root, workspacePath, source, store, client, connect, server, rpc, cli }
}

describe('original native conversations through public RPC and the compiled CLI', () => {
  it('discovers the configured Provider directory and original managed identity while Runtime handshakes are unavailable', async () => {
    const f = await fixture(), params = { hostId: 'local', executorId: 'native-custom', workspacePath: f.workspacePath }
    const output = await f.cli(['agent', 'native', 'ls', '--host', 'local', '--executor', 'native-custom', '--workspace-path', f.workspacePath])
    expect(output.code, output.stdout + output.stderr).toBe(0)
    const result = await f.rpc.call('agent.native.ls', params)
    expect(result).not.toHaveProperty('workspacePath')
    expect(result.hostId).toBe('local'); expect(result.executorId).toBe('native-custom')
    expect(result.capabilities.providerResume).toBe(true)
    expect(result.sessions).toEqual([expect.objectContaining({ source: f.source, title: 'Original conversation',
      managed: { agentSessionId: 'original-managed', executorId: 'native-custom', run: { runId: 'original-run' }, state: 'active' } })])
    expect(result.issues.length).toBeGreaterThan(0)
    expect(JSON.parse(output.stdout).result).toEqual(result)
    expect(output.stdout).not.toContain('PRIVATE_SECRET'); expect(output.stdout).not.toContain('catalog-must-not-leak')
    expect(f.connect).not.toHaveBeenCalled()
    expect((await loadAgentSessions(f.store))[0]!.run).toEqual({ runId: 'original-run' })
  })

  it('consumes meaningful wrong-Host and wrong-Executor failures through the actual CLI without changing retained work', async () => {
    const f = await fixture()
    for (const [hostId, executorId, code] of [['unknown-host', 'native-custom', 'UNKNOWN_HOST'], ['local', 'unknown-executor', 'HOST_EXECUTOR_NOT_FOUND']]) {
      const output = await f.cli(['agent', 'native', 'ls', '--host', hostId!, '--executor', executorId!])
      expect(output.code).not.toBe(0)
      expect(JSON.parse(output.stdout || output.stderr)).toMatchObject({ ok: false, error: { code } })
    }
    await expect(f.rpc.call('agent.native.ls', { hostId: 'local', executorId: 'native-custom', env: {} } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect((await loadAgentSessions(f.store)).map(session => [session.agentSessionId, session.run.runId])).toEqual([['original-managed', 'original-run']])
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('carries the exact source and original operation through CLI parsing and strict shared agent.open admission without a fabricated prompt', async () => {
    const f = await fixture()
    const sourceFile = join(f.root, 'native-source.json')
    await writeFile(sourceFile, JSON.stringify(f.source))
    const parsed = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'native-custom', '--native-source', sourceFile,
      '--execution-workspace', 'execution-original', '--zone', 'display-zone', '--new-tab', '--operation-id', 'original-resume'])
    expect(parsed.command.method).toBe('agent.open')
    const request = rpcControlRequest('agent.open', parsed.params)
    expect(request).toMatchObject({ operation: 'agent.open', requestId: 'original-resume',
      content: { kind: 'new-agent', executorId: 'native-custom', executionWorkspaceId: 'execution-original', nativeResumeSource: f.source } })
    expect((request as Extract<typeof request, { operation: 'agent.open' }>).content).not.toHaveProperty('prompt')
    for (const extra of [{ title: 'Not part of the source' }, { env: {} }]) {
      await writeFile(sourceFile, JSON.stringify({ ...f.source, ...extra }))
      await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'native-custom', '--native-source', sourceFile, '--zone', 'display-zone']))
        .rejects.toMatchObject({ code: 'INVALID_AGENT_NATIVE_RESUME_SOURCE' })
    }
    await expect(parseAgentMuxCliInvocation(['agent', 'open', '--session', 'original-managed', '--native-source', sourceFile, '--zone', 'display-zone']))
      .rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    expect(agentMuxCommandHelp('agent.open')).toContain('--native-source FILE|-')
    expect(agentMuxCommandHelp('agent.native.ls')).toContain('Read-only')
    expect(AGENTMUX_CLI_SKILL).toContain('no user request is invented')
    expect(AGENTMUX_CLI_SKILL).toContain('same --operation-id')
  })

  it('checks catalog scope, capabilities, source identity and partial issues at the client boundary', async () => {
    const f = await fixture(), params = { hostId: 'local', executorId: 'native-custom' }
    const valid = await f.rpc.call('agent.native.ls', params)
    const candidate = valid.sessions[0]!
    const corruptions = [
      { ...valid, hostId: 'different' }, { ...valid, executorId: 'different' }, { ...valid, capabilities: {} },
      { ...valid, sessions: [{ ...candidate, source: { ...candidate.source, nativeHandle: { ...candidate.source.nativeHandle, providerId: 'claude' } } }] },
      { ...valid, sessions: [{ ...candidate, source: { ...candidate.source, revision: 'missing' } }] },
      { ...valid, sessions: [{ ...candidate, managed: { ...candidate.managed, run: {} } }] },
      { ...valid, issues: [{ code: 'UNREADABLE' }] }, { ...valid, privateEnvironment: { secret: 'hidden' } }
    ]
    for (const corrupt of corruptions) expect(() => parseRpcNativeResult('agent.native.ls', corrupt, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(parseRpcNativeResult('agent.native.ls', { ...valid, sessions: [{ ...candidate, updatedAt: reshapeFixtureEpoch(0, 0, 123.45) }] }, params)).toHaveProperty('sessions.0.updatedAt', 123.45)
    const malformedOwner = new AgentMuxRpcService({ nativeAgentSessions: async () => ({ ...valid, hostId: 'different' }) })
    await expect(malformedOwner.call('agent.native.ls', params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  })
})

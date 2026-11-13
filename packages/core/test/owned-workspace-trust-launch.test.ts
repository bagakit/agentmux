import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProvider, type AgentWorkspaceTrustContext, type AgentWorkspaceTrustReceipt } from '../src/agent-provider.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

/**
 * A Mote's first question used to land in Claude's "trust this folder?" prompt and exit the Run.
 * Core now asks the Provider to accept that prompt for a home the Host confirms as its own, before
 * both a creation and a resume. The Provider's own file handling is covered by its module test;
 * this one proves the launch owners consume the capability, only for confirmed homes, and that a
 * failure never blocks a launch.
 */
type Internals = {
  connected: boolean
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  hookServer: Record<string, unknown>
  ensureManagedHooks: unknown
  ensureTerminalHandshakeOrDegrade: unknown
}
let root: string, home: string, project: string, store: AgentMuxFileAgentSessionStore
let client: AgentMuxClient, events: AgentMuxClientEvent[], start: ReturnType<typeof vi.fn>, startPrepared: ReturnType<typeof vi.fn>
let trust: ReturnType<typeof vi.fn<(context: AgentWorkspaceTrustContext) => Promise<AgentWorkspaceTrustReceipt>>>
let owned: ReturnType<typeof vi.fn<(workspacePath: string) => Promise<boolean>>>
let status: (runId: string) => CtxmuxAdapterRun

function run(workspacePath: string, runId = 'private-run', state: CtxmuxAdapterRun['state'] = { type: 'running' }): CtxmuxAdapterRun {
  return { nativeService: null, runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath,
    pid: state.type === 'running' ? 424242 : null, state, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-owned-trust-')))
  home = join(root, 'motes', 'a1b2c3d4e5f60718'); project = join(root, 'project')
  await mkdir(home, { recursive: true }); await mkdir(project)
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  trust = vi.fn(async (context: AgentWorkspaceTrustContext): Promise<AgentWorkspaceTrustReceipt> =>
    ({ status: 'trusted', trustKey: context.workspacePath, configPath: join(root, '.claude.json'), code: 'CLAUDE_TRUST_RECORDED' }))
  // The Host's directory-identity owner answers for exactly one home.
  owned = vi.fn(async (workspacePath: string) => workspacePath === home)
  const claude = new AgentProviderRegistry().get('claude')
  const provider: AgentProvider = { ...claude, prepareOwnedWorkspaceTrust: context => trust(context) }
  store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  client = new AgentMuxClient({ store, providers: [provider], ownedWorkspaceHome: workspacePath => owned(workspacePath) })
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-adapter', protocolVersion: 18, buildIdentity: 'fixture' })
  inner.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'private-runtime', instanceId: 'private-adapter', protocolVersion: 18, buildIdentity: 'fixture' })
  start = vi.fn(async (request: { workspacePath?: string; cwd?: string }) => run(request.cwd ?? request.workspacePath ?? home))
  inner.kernel.start = start
  // A resume dispatches its durably prepared request rather than a plain start.
  startPrepared = vi.fn(async (request: { cwd: string }) => run(request.cwd, 'resumed-run'))
  inner.kernel.startPrepared = startPrepared
  status = () => run(home)
  inner.kernel.status = async (runId: string) => status(runId)
  inner.kernel.stop = vi.fn(async () => ({ disposition: 'graceful' as const }))
  inner.hookServer.isRunning = () => true
  // Like the real server, a binding carries the identity it was created for.
  inner.hookServer.createBinding = (_agentSessionId: string, _providerId: string, bindingId: string) => ({ bindingId,
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockImplementation(async id => ({
    providerId: id, executable: id, installed: true, capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
  events = []; client.onEvent(event => { events.push(structuredClone(event)) })
})
afterEach(async () => {
  await client.dispose()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const create = (workspacePath: string, id = 'private-session') => client.createAgentWithDelivery({ agentSessionId: id, createOperationId: `create-${id}`,
  providerId: 'claude', executorId: 'private-executor', workspacePath, injectAgentMuxGuide: false })

describe('Core pre-trusts a Host-confirmed home before creating a Provider there', () => {
  it('prepares trust for the confirmed Mote home before the Run starts', async () => {
    await create(home)
    expect(owned).toHaveBeenCalledWith(home)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(trust.mock.calls[0]![0]).toMatchObject({ workspacePath: home })
    expect(trust.mock.invocationCallOrder[0]!).toBeLessThan(start.mock.invocationCallOrder[0]!)
    expect(events.filter(event => event.type === 'agent-error')).toEqual([])
  })

  it('leaves a folder the Host does not confirm to the Provider\'s own prompt', async () => {
    await create(project)
    expect(owned).toHaveBeenCalledWith(project)
    expect(trust).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('launches anyway and names the unconfirmed trust when preparation cannot confirm it', async () => {
    trust.mockResolvedValueOnce({ status: 'unconfirmed', trustKey: home, configPath: null, code: 'CLAUDE_TRUST_UNCONFIRMED', issue: 'lock busy' })
    await create(home)
    expect(start).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'CLAUDE_TRUST_UNCONFIRMED',
      message: expect.stringContaining('the Agent launch continues') }))
  })

  it('launches anyway when preparation throws', async () => {
    trust.mockRejectedValueOnce(new Error('disk unavailable'))
    await create(home)
    expect(start).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_WORKSPACE_TRUST_UNCONFIRMED' }))
  })

  it('launches anyway, without trusting, when the Host cannot confirm whether the cwd is a home', async () => {
    owned.mockRejectedValueOnce(new Error('configuration unreadable'))
    await create(home)
    expect(trust).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_WORKSPACE_TRUST_UNCONFIRMED',
      message: expect.stringContaining('configuration unreadable') }))
  })
})

describe('Core pre-trusts a Host-confirmed home before resuming a Provider there', () => {
  // An existing Mote conversation recovers through resume, not creation. A home created before
  // pre-trust existed, or whose creation receipt was unconfirmed, is only trusted here.
  const ended = (workspacePath: string): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId: 'resumed-session', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath,
    run: { runId: 'old-run' }, retiredRuns: [], hookBindingId: 'h'.repeat(43), hookToken: 'k'.repeat(43), createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-original' }
  })
  const resume = async (workspacePath: string) => {
    await store.compareAndSwap(null, ended(workspacePath))
    status = runId => run(workspacePath, runId, { type: 'interrupted', reason: 'daemon_restart' })
    return await client.resumeAgent({ agentSessionId: 'resumed-session', operationId: 'resume-original', prompt: 'continue' })
  }

  it('prepares trust for the confirmed home before the prepared Start is dispatched', async () => {
    const resumed = await resume(home)
    expect(resumed).toMatchObject({ agentSessionId: 'resumed-session', run: { runId: 'resumed-run' }, nativeHandle: { sessionId: 'native-original' } })
    expect(owned).toHaveBeenCalledWith(home)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(trust.mock.calls[0]![0]).toMatchObject({ workspacePath: home })
    expect(startPrepared).toHaveBeenCalledTimes(1)
    expect(trust.mock.invocationCallOrder[0]!).toBeLessThan(startPrepared.mock.invocationCallOrder[0]!)
    expect(events.filter(event => event.type === 'agent-error')).toEqual([])
  })

  it('resumes the original native Session anyway when preparation throws', async () => {
    trust.mockRejectedValueOnce(new Error('disk unavailable'))
    const resumed = await resume(home)
    expect(resumed).toMatchObject({ run: { runId: 'resumed-run' }, nativeHandle: { sessionId: 'native-original' } })
    expect(startPrepared).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: 'resumed-session', code: 'AGENT_WORKSPACE_TRUST_UNCONFIRMED' }))
  })

  it('leaves a resumed user Project to the Provider\'s own prompt', async () => {
    await resume(project)
    expect(trust).not.toHaveBeenCalled()
    expect(startPrepared).toHaveBeenCalledTimes(1)
  })
})

describe('a Core launch starts the native start window for its Hook binding', () => {
  it('records when the created Run’s Hook binding became active, and forgets it with the binding', async () => {
    await create(home)
    const inner = client as unknown as { hookBindings: Map<string, unknown>; hookBindingActivatedAt: Map<string, number>; forgetHookBinding(runId: string): void }
    expect(inner.hookBindings.has('private-run')).toBe(true)
    const at = inner.hookBindingActivatedAt.get('private-run')
    expect(typeof at).toBe('number')
    expect(Date.now() - at!).toBeLessThan(10_000)
    inner.forgetHookBinding('private-run')
    expect(inner.hookBindingActivatedAt.has('private-run')).toBe(false)
  })
})

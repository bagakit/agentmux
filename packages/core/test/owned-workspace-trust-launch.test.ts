import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProvider, type AgentWorkspaceTrustContext, type AgentWorkspaceTrustReceipt } from '../src/agent-provider.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

/**
 * A Mote's first question used to land in Claude's "trust this folder?" prompt and exit the Run.
 * Core now asks the Provider to accept that prompt for AgentMux-owned homes before the launch.
 * The Provider's own file handling is covered by its module test; this one proves the launch
 * owner consumes the capability, only for owned homes, and that a failure never blocks a launch.
 */
type Internals = {
  connected: boolean
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  hookServer: Record<string, unknown>
  ensureManagedHooks: unknown
  ensureTerminalHandshakeOrDegrade: unknown
}
let root: string, owned: string, home: string, project: string
let client: AgentMuxClient, events: AgentMuxClientEvent[], start: ReturnType<typeof vi.fn>
let trust: ReturnType<typeof vi.fn<(context: AgentWorkspaceTrustContext) => Promise<AgentWorkspaceTrustReceipt>>>

function run(workspacePath: string): CtxmuxAdapterRun {
  return { nativeService: null, runId: 'private-run', lifecycleOperationId: null, program: 'claude', args: [], workspacePath,
    pid: 424242, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-owned-trust-')))
  owned = join(root, 'motes'); home = join(owned, 'a1b2c3d4e5f60718'); project = join(root, 'project')
  await mkdir(home, { recursive: true }); await mkdir(project)
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  trust = vi.fn(async (context: AgentWorkspaceTrustContext): Promise<AgentWorkspaceTrustReceipt> =>
    ({ status: 'trusted', trustKey: context.ownedRoot, configPath: join(root, '.claude.json'), code: 'CLAUDE_TRUST_RECORDED' }))
  const claude = new AgentProviderRegistry().get('claude')
  const provider: AgentProvider = { ...claude, prepareOwnedWorkspaceTrust: context => trust(context) }
  client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), providers: [provider],
    ownedWorkspaceRoots: async () => [owned] })
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-adapter', protocolVersion: 18, buildIdentity: 'fixture' })
  start = vi.fn(async (request: { workspacePath: string }) => run(request.workspacePath))
  inner.kernel.start = start
  inner.kernel.status = async () => run(home)
  inner.kernel.stop = vi.fn(async () => ({ disposition: 'graceful' as const }))
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) },
    bindRun: async () => {}, close: async () => {} })
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

describe('Core pre-trusts AgentMux-owned homes before launching a Provider there', () => {
  it('prepares trust for an owned Mote home before the Run starts', async () => {
    await create(home)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(trust.mock.calls[0]![0]).toMatchObject({ ownedRoot: owned, workspacePath: home })
    expect(trust.mock.invocationCallOrder[0]!).toBeLessThan(start.mock.invocationCallOrder[0]!)
    expect(events.filter(event => event.type === 'agent-error')).toEqual([])
  })

  it('leaves a user Project to the Provider\'s own prompt', async () => {
    await create(project)
    expect(trust).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('launches anyway and names the unconfirmed trust when preparation cannot confirm it', async () => {
    trust.mockResolvedValueOnce({ status: 'unconfirmed', trustKey: owned, configPath: null, code: 'CLAUDE_TRUST_UNCONFIRMED', issue: 'lock busy' })
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

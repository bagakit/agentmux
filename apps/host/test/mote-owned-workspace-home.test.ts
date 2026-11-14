import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { AgentProvider, AgentWorkspaceTrustContext, AgentWorkspaceTrustReceipt } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'
import { moteOwnedWorkspaceHome, moteOwnedWorkspaceRoots, ScratchTopics } from '../src/mote-resources.js'
import { scratchTopicDirectoryName } from '../src/mote-topic-model.js'

/**
 * The Host tells Core whether one launch cwd is exactly one of its own Mote or Topic homes, as its
 * directory-identity owner confirms it, so Core pre-trusts a Provider only there. Every other
 * folder, including the general Scratch root and anything nested in a home, keeps the Provider's
 * native trust prompt. An ambiguous or remote Scratch workspace owns nothing.
 */
describe('Host-owned workspace homes', () => {
  let root: string, cleanupRoot: string, config: string, scratch: string, workspace: { id: string; hostId: string; path: string }
  let mote: string, topic: string
  const write = (value: unknown) => writeFile(config, JSON.stringify(value))
  const owns = (path: string) => moteOwnedWorkspaceHome(config, path)
  beforeEach(async () => {
    // The configured Scratch path reaches its storage through a symlinked ancestor, like
    // `~/.agentmux -> /Volumes/Data/agentmux`; the Host must recognize either spelling of a home.
    const physical = await realpath(await mkdtemp(join(tmpdir(), 'amx-owned-homes-')))
    await mkdir(join(physical, 'volume', 'scratch'), { recursive: true })
    root = join(physical, 'home'); await mkdir(root)
    await symlink(join(physical, 'volume'), join(root, '.agentmux'))
    cleanupRoot = physical; config = join(root, 'config.json')
    scratch = join(root, '.agentmux', 'scratch')
    workspace = { id: '__scratch__', hostId: 'local', path: scratch }
    const topics = new ScratchTopics()
    mote = (await topics.ensureMote(workspace, 'launcher:leader')).physicalDirectoryPath!
    topic = (await topics.ensure(workspace, 'view:owned-topic', undefined, false)).physicalDirectoryPath!
    await write({ workspaces: [workspace, { id: 'project', hostId: 'local', path: join(root, 'code', 'app') }] })
  })
  afterEach(async () => { await rm(cleanupRoot, { recursive: true, force: true }) })

  it('owns exactly a Mote home and a Topic home the Host created', async () => {
    expect(await owns(mote)).toBe(true)
    expect(await owns(topic)).toBe(true)
  })

  it('owns a home by its physical spelling too, which is the path Claude actually starts in', async () => {
    expect(await realpath(mote)).not.toBe(mote)
    expect(await owns(await realpath(mote))).toBe(true)
  })

  it('owns a retained alias of a home, whose real path Claude will trust', async () => {
    const alias = join(scratch, scratchTopicDirectoryName('launcher:leader'))
    await symlink(`../motes/${basename(mote)}`, alias)
    expect(await owns(alias)).toBe(true)
  })

  it('does not confirm an alias that escapes the Host\'s storage roots', async () => {
    const outside = join(cleanupRoot, 'outside'); await mkdir(outside)
    const escape = join(scratch, scratchTopicDirectoryName('view:escaping-alias')); await symlink(outside, escape)
    await expect(owns(escape)).rejects.toThrow('escapes its confirmed object addresses')
  })

  it('keeps the general Scratch root, its other folders, the storage roots and nested folders on the native prompt', async () => {
    const clone = join(scratch, 'vendor-x'); await mkdir(join(clone, '.git'), { recursive: true })
    const nested = join(mote, 'refs', 'vendor'); await mkdir(join(nested, '.git'), { recursive: true })
    for (const path of [scratch, clone, join(root, '.agentmux', 'motes'), join(root, '.agentmux', 'topics'), nested, join(mote, 'outcome'), join(root, 'code', 'app')])
      expect(await owns(path), path).toBe(false)
  })

  it('owns nothing when the Scratch workspace is remote, duplicated or absent', async () => {
    await write({ workspaces: [{ ...workspace, hostId: 'remote' }] })
    expect(await owns(mote)).toBe(false)
    await write({ workspaces: [workspace, { ...workspace, path: join(root, 'other') }] })
    expect(await owns(mote)).toBe(false)
    await write({ workspaces: [] })
    expect(await owns(mote)).toBe(false)
  })
})

describe('moteOwnedWorkspaceRoots returns the resolved paths of all Host-owned homes', () => {
  let cleanupRoot: string, config: string, scratch: string, workspace: { id: string; hostId: string; path: string }
  let mote: string, topic: string
  const write = (value: unknown) => writeFile(config, JSON.stringify(value))
  const roots = () => moteOwnedWorkspaceRoots(config)
  beforeEach(async () => {
    const physical = await realpath(await mkdtemp(join(tmpdir(), 'amx-owned-roots-')))
    await mkdir(join(physical, 'volume', 'scratch'), { recursive: true })
    const root = join(physical, 'home'); await mkdir(root)
    await symlink(join(physical, 'volume'), join(root, '.agentmux'))
    cleanupRoot = physical; config = join(root, 'config.json')
    scratch = join(root, '.agentmux', 'scratch')
    workspace = { id: '__scratch__', hostId: 'local', path: scratch }
    const topics = new ScratchTopics()
    mote = (await topics.ensureMote(workspace, 'launcher:leader')).physicalDirectoryPath!
    topic = (await topics.ensure(workspace, 'view:owned-topic', undefined, false)).physicalDirectoryPath!
    await write({ workspaces: [workspace] })
  })
  afterEach(async () => { await rm(cleanupRoot, { recursive: true, force: true }) })

  it('includes both a Mote home and a Topic home', async () => {
    const result = await roots()
    expect(result).toContain(await realpath(mote))
    expect(result).toContain(await realpath(topic))
  })

  it('returns an empty array when the Scratch workspace is remote or absent', async () => {
    await write({ workspaces: [{ ...workspace, hostId: 'remote' }] })
    expect(await roots()).toEqual([])
    await write({ workspaces: [] })
    expect(await roots()).toEqual([])
  })

  it('retains unknown when the original configuration is missing', async () => {
    const missing = config + '.missing'
    await expect(moteOwnedWorkspaceRoots(missing)).rejects.toThrow()
  })

  it('confirms only the targeted physical home and its alias without listing other homes', async () => {
    const physical = await realpath(mote), alias = join(cleanupRoot, 'retained-alias')
    await symlink(physical, alias)
    expect(await moteOwnedWorkspaceRoots(config, mote)).toEqual([physical])
    expect(await moteOwnedWorkspaceRoots(config, alias)).toEqual([physical])
    const foreign = join(mote, 'foreign'); await mkdir(foreign)
    expect(await moteOwnedWorkspaceRoots(config, foreign)).toEqual([])
    const outside = join(cleanupRoot, 'outside'); await mkdir(outside)
    const escape = join(mote, 'escape'); await symlink(outside, escape)
    expect(await moteOwnedWorkspaceRoots(config, escape)).toEqual([])
  })
})

describe('the real Host hands its home decision to Core', () => {
  const cleanup: Array<() => unknown> = []
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('pre-trusts a Claude creation in a configured Mote home, and not in a user Project', async () => {
    const original = await rpcOwnerFixture(['original-agent'], core)
    cleanup.push(original.close)
    const base = await realpath(original.root)
    const workspace = { id: '__scratch__', hostId: 'local', path: join(base, '.agentmux', 'scratch') }
    await mkdir(workspace.path, { recursive: true })
    const home = (await new ScratchTopics().ensureMote(workspace, 'launcher:leader')).physicalDirectoryPath!
    const project = join(base, 'project'); await mkdir(project)
    const configurationPath = join(base, 'agentmux.config.json')
    await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace, { id: 'project', hostId: 'local', path: project }] }))
    const trust = vi.fn(async (context: AgentWorkspaceTrustContext): Promise<AgentWorkspaceTrustReceipt> =>
      ({ status: 'trusted', trustKey: context.workspacePath, configPath: join(base, '.claude.json'), code: 'CLAUDE_TRUST_RECORDED' }))
    const claude = new core.AgentProviderRegistry().get('claude')
    const provider: AgentProvider = { ...claude, prepareOwnedWorkspaceTrust: context => trust(context) }
    const native = original.inner.kernel
    await original.client.dispose()
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    })
    let host: Awaited<ReturnType<typeof startAgentMuxHost>>
    try {
      host = await startAgentMuxHost({ store: original.store, providers: [provider], socketPath: join(base, 'host.sock'),
        desktopSocketPath: join(base, 'desktop.sock'), configurationPath, mobileBuildDirectory: join(base, 'absent-mobile') })
      cleanup.push(() => host.dispose())
      await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
    } finally { connect.mockRestore() }
    // The Host's own Core launches through its real creation owner; only Runtime and Hook I/O are controlled.
    const inner = host.client as unknown as typeof original.inner & { hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
    const start = vi.fn(async (request: { operationKey: string; cwd: string }) => ({ nativeService: null, runId: `run-${request.operationKey}`,
      lifecycleOperationId: null, program: 'claude', args: [], workspacePath: request.cwd, pid: 424242, state: { type: 'running' as const },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }))
    inner.kernel.start = start
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = (_agentSessionId: string, _providerId: string, bindingId: string) => ({ bindingId,
      endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    vi.spyOn(host.client as unknown as { probePreparedAgent: typeof host.client.probeAgent }, 'probePreparedAgent').mockImplementation(async id => ({
      providerId: id, executable: id, installed: true, capabilities: new core.AgentProviderRegistry().get(id).catalog.capabilities }))
    inner.ensureManagedHooks = async () => {}
    inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
    const create = (agentSessionId: string, workspacePath: string) => host.client.createAgentWithDelivery({ agentSessionId,
      createOperationId: `create-${agentSessionId}`, providerId: 'claude', executorId: 'claude', workspacePath, injectAgentMuxGuide: false })

    await create('mote-agent', home)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(trust.mock.calls[0]![0]).toMatchObject({ workspacePath: await realpath(home) })
    expect(trust.mock.invocationCallOrder[0]!).toBeLessThan(start.mock.invocationCallOrder[0]!)

    await create('project-agent', project)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(2)

    // The decision is read from the original configuration at launch, not from a copy taken at startup.
    await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'project', hostId: 'local', path: project }] }))
    await create('unconfigured-agent', home)
    expect(trust).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(3)
  })
})

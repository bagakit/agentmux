import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { parseClaudeExecutionRunArguments, runClaudeExecutionHelper } from '../src/providers/claude-execution-run.js'
import { parseCodexExecutionRunArguments, runCodexExecutionHelper } from '../src/providers/codex-execution-run.js'
import { prepareClaudeToolExecutionLaunch } from '../src/providers/claude-tool-execution-launch.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { executionCreationId } from '../src/host-route-execution.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

for (const providerId of ['claude', 'codex'] as const) {
  it(`${providerId}: Core prepares a retained frontend without a default CLI and its runner relays native traffic`, async () => {
    const h = await rpcOwnerFixture([], undefined, undefined, root => ({
      creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: root, runtimeId: 'execution-runtime' })
    })); cleanup.push(h.close)
    // Neither default native CLI exists in this exact Host lookup environment.
    vi.stubEnv('PATH', h.root)
    const locator = (await h.client.hostEnvironment({ agentSessionId: 'original-agent' })).agentWorkspace
    const input = { providerId, role: 'frontend' as const, bindingId: 'original-binding', agentSessionId: 'original-agent',
      createOperationId: executionCreationId('original-binding', 'frontend'), workspacePath: locator.workspacePath,
      toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: h.root } }
    const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
    await expect(lstat(locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const pending = h.client.prepareAgentExecutionHelper(input)
    await expect(pending).resolves.toMatchObject({ role: 'frontend', providerId })
    const preparation = await pending
    expect(await h.client.prepareAgentExecutionHelper(input)).toEqual(preparation)
    expect(preparation).toMatchObject({ bindingId: input.bindingId, role: input.role, providerId,
      prepared: { createOperationId: input.createOperationId, workspacePath: locator.workspacePath } })
    expect(prepareTerminal).toHaveBeenCalledOnce()
    const markerPath = join(dirname(h.store.path), 'agent-workspace-identities', locator.workspacePath.split('/').at(-1)! + '.json')
    const markerBefore = await readFile(markerPath)
    const [rootIdentity, leafIdentity] = await Promise.all([lstat(dirname(locator.workspacePath)), lstat(locator.workspacePath)])
    expect(JSON.parse(markerBefore)).toMatchObject({ phase: 'provisioned', runtimeId: 'execution-runtime', agentSessionId: input.agentSessionId,
      workspacePath: locator.workspacePath,
      root: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) },
      leaf: { dev: String(leafIdentity.dev), ino: String(leafIdentity.ino) } })
    // Consume the actual frozen Native request, including Core's env wrapper.
    const { request } = JSON.parse(preparation.prepared.launch)
    const args: string[] = request.args
    const runnerArgs = args.slice(args.indexOf('--agentmux-execution-helper'))
    const parse = providerId === 'claude' ? parseClaudeExecutionRunArguments : parseCodexExecutionRunArguments
    expect(() => parse(runnerArgs)).not.toThrow()
    const context = parse(runnerArgs)
    expect(context).toMatchObject({ ...input, executable: providerId })
    const frames: any[] = []
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() })
    const stdout = new Writable({ write(bytes, _encoding, done) { frames.push(JSON.parse(String(bytes))); done() } })
    cleanup.push(async () => { stdin.destroy(); stdout.destroy() })
    const runner = await (providerId === 'claude' ? runClaudeExecutionHelper(context, { input: stdin, output: stdout }) : runCodexExecutionHelper(context, { input: stdin, output: stdout }))
    cleanup.push(() => runner.close())
    expect(stdin.setRawMode).toHaveBeenCalledWith(true)
    expect(frames).toEqual([{ type: 'ready', url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/u) }])
    const socket = new WebSocket(frames[0].url)
    cleanup.push(async () => { socket.terminate() })
    await once(socket, 'open')
    const payload = providerId === 'claude'
      ? { jsonrpc: '2.0', id: 17, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }
      : { id: 17, method: 'initialize', params: { clientName: 'fixture', resumeSessionId: null } }
    socket.send(JSON.stringify(payload))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'request')).toBe(true))
    const forwarded = frames.find(frame => frame.type === 'request')
    expect(forwarded.payload).toEqual(payload)
    const reply = { id: 17, result: { original: providerId } }
    const received = once(socket, 'message')
    stdin.write(JSON.stringify({ type: 'response', generation: forwarded.generation, payload: reply }) + '\n')
    expect(JSON.parse(String((await received)[0]))).toEqual(reply)

    await rm(locator.workspacePath, { recursive: true })
    await mkdir(locator.workspacePath)
    await expect(h.client.prepareAgentExecutionHelper(input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
    expect(prepareTerminal).toHaveBeenCalledOnce()
    expect(await readFile(markerPath)).toEqual(markerBefore)
  })

  it(`${providerId}: a deleted Core leaf refuses retained preparation before another terminal or runner can start`, async () => {
    const h = await rpcOwnerFixture([], undefined, undefined, root => ({
      creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: root, runtimeId: 'execution-runtime' })
    })); cleanup.push(h.close)
    vi.stubEnv('PATH', h.root)
    const locator = (await h.client.hostEnvironment({ agentSessionId: 'original-agent' })).agentWorkspace
    const input = { providerId, role: 'frontend' as const, bindingId: 'original-binding', agentSessionId: 'original-agent',
      createOperationId: executionCreationId('original-binding', 'frontend'), workspacePath: locator.workspacePath,
      toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: h.root } }
    const prepareTerminal = vi.spyOn(h.client, 'prepareTerminal')
    await h.client.prepareAgentExecutionHelper(input)
    const markerPath = join(dirname(h.store.path), 'agent-workspace-identities', locator.workspacePath.split('/').at(-1)! + '.json')
    const markerBefore = await readFile(markerPath)
    await rm(locator.workspacePath, { recursive: true })
    await expect(h.client.prepareAgentExecutionHelper(input)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
    expect(prepareTerminal).toHaveBeenCalledOnce()
    await expect(lstat(locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(markerPath)).toEqual(markerBefore)
  })

  it(`${providerId}: the actual resource helper still rejects an unavailable CLI`, async () => {
    const h = await rpcOwnerFixture([], undefined, undefined, root => ({
      creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: root, runtimeId: 'execution-runtime' })
    })); cleanup.push(h.close)
    vi.stubEnv('PATH', h.root)
    const locator = (await h.client.hostEnvironment({ agentSessionId: 'original-agent' })).agentWorkspace
    const prepare = vi.spyOn(h.client, 'prepareTerminal')
    await expect(h.client.prepareAgentExecutionHelper({ providerId, role: 'executor', bindingId: 'resource-binding',
      createOperationId: 'original-resource-helper', workspacePath: h.root, grant: { scope: 'host-user', bindingId: 'resource-binding' } })).rejects.toThrow('unavailable')
    expect(prepare).not.toHaveBeenCalled()
    await expect(lstat(locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const context = { providerId, role: 'executor', bindingId: 'resource-binding', agentSessionId: 'original-agent',
      createOperationId: 'original-resource-helper', workspacePath: h.root, journalDirectory: h.root,
      journalIdentity: 'retained-journal', grant: { scope: 'host-user', bindingId: 'resource-binding' }, executable: providerId }
    expect(() => providerId === 'claude'
      ? parseClaudeExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify(context)])
      : parseCodexExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify(context)])).toThrow('fixed')
  })
}

it('the selected absolute Claude wrapper remains the Agent launch command when no default CLI exists', async () => {
  const h = await rpcOwnerFixture([]); cleanup.push(h.close)
  vi.stubEnv('PATH', h.root); vi.stubEnv('CLAUDE_CONFIG_DIR', join(h.root, 'claude-config'))
  const command = join(h.root, 'configured-wrapper')
  await writeFile(command, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),selected:process.env.SELECTED_FIXTURE}));\n`)
  await chmod(command, 0o700)
  const plan = await prepareClaudeToolExecutionLaunch({ command, args: ['--', 'retained fixture prompt'], env: { SELECTED_FIXTURE: 'original' } }, {
    binding: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: '/original/project' },
    url: 'ws://127.0.0.1:12345/fixture-only', launchWorkspacePath: h.root,
  })
  expect(plan.command).toBe(command)
  const result = await promisify(execFile)(plan.command, plan.args, { cwd: h.root, env: { ...process.env, ...plan.env } })
  expect(JSON.parse(result.stdout)).toMatchObject({ selected: 'original', args: expect.arrayContaining(['--', 'retained fixture prompt']) })
})

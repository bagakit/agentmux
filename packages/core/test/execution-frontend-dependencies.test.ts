import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { parseClaudeExecutionRunArguments, runClaudeExecutionHelper } from '../src/providers/claude-execution-run.js'
import { parseCodexExecutionRunArguments, runCodexExecutionHelper } from '../src/providers/codex-execution-run.js'
import { prepareClaudeToolExecutionLaunch } from '../src/providers/claude-tool-execution-launch.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

for (const providerId of ['claude', 'codex'] as const) {
  it(`${providerId}: Core prepares a retained frontend without a default CLI and its runner relays native traffic`, async () => {
    const h = await rpcOwnerFixture([]); cleanup.push(h.close)
    // Neither default native CLI exists in this exact Host lookup environment.
    vi.stubEnv('PATH', h.root)
    const input = { providerId, role: 'frontend' as const, bindingId: 'original-binding', agentSessionId: 'original-agent',
      createOperationId: 'original-frontend', workspacePath: h.root,
      toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource', resourceRuntimeId: 'original-resource', workspacePath: h.root } }
    const pending = h.client.prepareAgentExecutionHelper(input)
    await expect(pending).resolves.toMatchObject({ role: 'frontend', providerId })
    const preparation = await pending
    expect(await h.client.prepareAgentExecutionHelper(input)).toEqual(preparation)
    expect(preparation).toMatchObject({ bindingId: input.bindingId, role: input.role, providerId,
      prepared: { createOperationId: input.createOperationId, workspacePath: h.root } })
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
  })

  it(`${providerId}: the actual resource helper still rejects an unavailable CLI`, async () => {
    const h = await rpcOwnerFixture([]); cleanup.push(h.close)
    vi.stubEnv('PATH', h.root)
    const prepare = vi.spyOn(h.client, 'prepareTerminal')
    await expect(h.client.prepareAgentExecutionHelper({ providerId, role: 'executor', bindingId: 'resource-binding',
      createOperationId: 'original-resource-helper', workspacePath: h.root, grant: { scope: 'host-user', bindingId: 'resource-binding' } })).rejects.toThrow('unavailable')
    expect(prepare).not.toHaveBeenCalled()
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

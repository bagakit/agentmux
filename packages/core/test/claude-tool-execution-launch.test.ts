import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareClaudeToolExecutionLaunch } from '../src/providers/claude-tool-execution-launch.js'
import { prepareClaudeExecutionHelper } from '../src/providers/claude-execution-helper.js'
import { parseClaudeExecutionRunArguments } from '../src/providers/claude-execution-run.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-claude-launch-')); roots.push(root)
  const command = join(root, 'claude')
  await writeFile(command, '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf "2.1.314 (Claude Code)\\n"\n'); await chmod(command, 0o700)
  const context = { binding: { bindingId: 'original-binding', resourceHostId: 'resource-host', resourceRuntimeId: 'resource-runtime', workspacePath: '/original/resource/project' }, url: 'ws://127.0.0.1:12345/original-private-endpoint', launchWorkspacePath: root }
  return { root, command, context }
}
describe('Claude original execution launch', () => {
  it('selects the fixed native MCP endpoint without replacing authentication, prompt or resume identity', async () => {
    const f = await fixture(), args = ['--resume', 'original-native-session', '--permission-mode', 'default', '--', 'literal --mcp-config prompt']
    const env = { CLAUDE_CONFIG_DIR: '/original/config', ANTHROPIC_BASE_URL: 'http://controlled.invalid', ORIGINAL_VALUE: 'retained' }
    const plan = await prepareClaudeToolExecutionLaunch({ command: f.command, args, env }, f.context)
    expect(plan.command).toBe(f.command); expect(plan.env).toEqual(env)
    expect(plan.args.slice(-args.length)).toEqual(args)
    const at = plan.args.indexOf('--mcp-config')
    expect(JSON.parse(plan.args[at + 1]!)).toEqual({ mcpServers: { amux_exec: { type: 'ws', url: f.context.url } } })
    expect(plan.args).not.toContain('--dangerously-skip-permissions')
    expect(plan.args.join(' ')).toContain('/original/resource/project')
  })
  it.each(['ws://elsewhere.invalid:2/capability', 'ws://127.0.0.1:2/', 'http://127.0.0.1:2/capability'])('rejects another endpoint only for this launch: %s', async url => {
    const f = await fixture()
    await expect(prepareClaudeToolExecutionLaunch({ command: f.command, args: [], env: {} }, { ...f.context, url })).rejects.toThrow('original loopback')
  })
  it('preserves an explicit tool restriction and existing MCP and plugin inputs', async () => {
    const f = await fixture()
    const originalMcp = JSON.stringify({ mcpServers: { original: { type: 'http', url: 'https://controlled.invalid/mcp' } } })
    const plan = await prepareClaudeToolExecutionLaunch({ command: f.command,
      args: ['--tools=Read', '--mcp-config', originalMcp, '--plugin-dir', '/original/plugin', '--append-system-prompt', 'Original authored instructions', '--', 'Original prompt'], env: {} }, f.context)
    expect(plan.args).toContain('--tools=Read')
    expect(plan.args).not.toContain('--strict-mcp-config')
    expect(plan.args).toContain(originalMcp); expect(plan.args).toContain('/original/plugin')
    expect(plan.args.filter(value => value === '--mcp-config')).toHaveLength(1)
    expect(plan.args.filter(value => value === '--plugin-dir')).toHaveLength(1)
    const note = plan.args[plan.args.indexOf('--append-system-prompt') + 1]!
    expect(note).toContain('/original/resource/project'); expect(note.endsWith('Original authored instructions')).toBe(true)
    expect(plan.args.slice(-2)).toEqual(['--', 'Original prompt'])
  })
  it('keeps the exact bound transport last when a user config contains the reserved server name', async () => {
    const f = await fixture(), user = JSON.stringify({ mcpServers: { amux_exec: { type: 'ws', url: 'ws://127.0.0.1:54321/other-binding' }, retained: { command: '/original/server' } } })
    const plan = await prepareClaudeToolExecutionLaunch({ command: f.command, args: ['--mcp-config=' + user, '--', 'original prompt'], env: {} }, f.context)
    const at = plan.args.indexOf('--mcp-config')
    expect(plan.args[at + 1]).toBe(user)
    expect(JSON.parse(plan.args[at + 2]!)).toEqual({ mcpServers: { amux_exec: { type: 'ws', url: f.context.url } } })
    expect(plan.args.slice(-2)).toEqual(['--', 'original prompt'])
  })

  it('retains a user prompt file and combines it without moving its contents into argv', async () => {
    const f = await fixture(), path = join(f.root, 'original.txt')
    await writeFile(path, 'Original file instructions\n')
    const plan = await prepareClaudeToolExecutionLaunch({ command: f.command, args: ['--append-system-prompt-file', path], env: {} }, f.context)
    const input = plan.args[plan.args.indexOf('--append-system-prompt-file') + 1]!
    expect(await readFile(path, 'utf8')).toBe('Original file instructions\n')
    expect((await readFile(input, 'utf8')).endsWith('Original file instructions\n')).toBe(true)
    expect(plan.args).not.toContain('Original file instructions\n')
  })

  it('prepares an original resource helper using the selected Provider and retained grant/journal', async () => {
    const f = await fixture()
    const input = { bindingId: 'original-binding', role: 'executor' as const, providerId: 'claude', agentSessionId: 'original-agent', workspacePath: f.root, journalDirectory: f.root, journalIdentity: 'original-journal', createOperationId: 'original-creation', executable: f.command, grant: { scope: 'host-user' as const, bindingId: 'original-binding' } }
    const plan = await prepareClaudeExecutionHelper(input)
    expect(parseClaudeExecutionRunArguments(plan.args.slice(-2))).toEqual(input)
    expect(plan.command).toBe(process.execPath)
    expect(plan.args[1]).toContain('claude-execution-run.js')
    expect(() => parseClaudeExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify({ ...input, grant: { scope: 'host-user', bindingId: 'foreign' } })])).toThrow('original resource grant')
  })
})

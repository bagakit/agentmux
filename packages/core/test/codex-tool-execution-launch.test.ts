import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCodexToolExecutionLaunch } from '../src/providers/codex-tool-execution-launch.js'
import { qualifyCodexExecutionExecutable } from '../src/providers/codex-execution-helper.js'
import type { AgentLaunchPlan } from '../src/types.js'

const roots: string[] = []
vi.mock('../src/providers/codex-execution-helper.js', () => ({ qualifyCodexExecutionExecutable: vi.fn(async command => command) }))
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.mocked(qualifyCodexExecutionExecutable).mockReset().mockImplementation(async command => command) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'native-launch-')); roots.push(home)
  const codexHome = join(home, '.codex'); await mkdir(codexHome)
  const plan: AgentLaunchPlan = { command: '/opt/bin/codex', args: ['--dangerously-bypass-hook-trust', '--no-alt-screen', '--', 'keep --remote and -C in this prompt'], env: { CODEX_HOME: codexHome, KEEP: 'original' } }
  const execution = { workspacePath: '/owner/project', url: 'ws://127.0.0.1:34567/private-capability' }
  const options = { inheritedEnv: {}, launchWorkspacePath: home }
  return { home, codexHome, plan, execution, options }
}

it('preserves command, original prompt, environment and ordinary TUI while binding only tool cwd', async () => {
  const f = await fixture(), before = structuredClone(f.plan)
  const result = await prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)
  expect(result).toEqual({ command: f.plan.command, args: ['--no-daemon', '-C', '/owner/project', ...f.plan.args], env: { ...f.plan.env, CODEX_EXEC_SERVER_URL: f.execution.url } })
  expect(f.plan).toEqual(before)
  expect(result).not.toHaveProperty('cwd')
})

it('keeps native resume identity and option values while replacing all native cwd spellings', async () => {
  const f = await fixture()
  f.plan.args = ['-C', '/backend', '--model', 'keep-this', '--cd=/another', '-C/third', '--no-daemon', 'resume', 'original-native-id', '--', '-C prompt']
  expect((await prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).args).toEqual(['--no-daemon', '-C', '/owner/project', '--model', 'keep-this', 'resume', 'original-native-id', '--', '-C prompt'])
})

it.each(['', '# comment only\n', 'default="local"\ninclude_local=true\n', 'default="remote"\ninclude_local=false\n[[environments]]\nid="remote"\nurl="ws://127.0.0.1:1/other"\n', 'not valid TOML'])('refuses a present TOML provider instead of silently selecting another environment', async contents => {
  const f = await fixture(), path = join(f.codexHome, 'environments.toml')
  await writeFile(path, contents)
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toMatchObject({ code: 'CODEX_TOOL_EXECUTION_LAUNCH_CONFLICT' })
  expect(await readFile(path, 'utf8')).toBe(contents)
})

it('uses plan env over inherited CODEX_HOME, and follows the actual native home directory', async () => {
  const f = await fixture(), inherited = join(f.home, 'inherited')
  await mkdir(inherited); await writeFile(join(inherited, 'environments.toml'), 'default="local"')
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, { inheritedEnv: { CODEX_HOME: inherited } })).resolves.toMatchObject({ command: f.plan.command })
  const alias = join(f.home, 'home-alias'); await symlink(inherited, alias)
  f.plan.env.CODEX_HOME = alias
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toThrow('overrides')
})

it('resolves relative native home only against the original backend launch cwd', async () => {
  const f = await fixture(); f.plan.env.CODEX_HOME = '.codex'
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, { inheritedEnv: {} })).rejects.toThrow('backend launch directory')
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).resolves.toMatchObject({ env: { CODEX_HOME: '.codex' } })
  await writeFile(join(f.codexHome, 'environments.toml'), '')
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toThrow('overrides')
})

it('checks the effective default home without replacing auth or history directories', async () => {
  const f = await fixture(); delete f.plan.env.CODEX_HOME
  const options = { inheritedEnv: { HOME: f.home } }
  const result = await prepareCodexToolExecutionLaunch(f.plan, f.execution, options)
  expect(result.env).not.toHaveProperty('CODEX_HOME')
  await writeFile(join(f.codexHome, 'environments.toml'), '')
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, options)).rejects.toThrow('overrides')
})

it.each(['CODEX_EXEC_SERVER_NOISE_REGISTRY_URL', 'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID', 'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN'])('rejects native rendezvous precedence from %s without logging its value', async name => {
  const f = await fixture()
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, { inheritedEnv: { [name]: 'private-value' } })).rejects.toThrow('overrides')
})

it.each([{ args: ['--remote', 'ws://elsewhere'] }, { args: ['--remote=unix:///tmp/native'] }, { args: ['--remote-auth-token-env', 'TOKEN'] }])('does not rewrite an app-server launch into another native identity', async ({ args }) => {
  const f = await fixture(); f.plan.args = args
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toThrow('ordinary native CLI')
})

it.each(['ws://192.0.2.1:1234/capability', 'wss://127.0.0.1:1234/capability', 'ws://127.0.0.1:1234/', 'ws://user:secret@127.0.0.1:1234/capability', 'none'])('refuses a bridge URL outside the native loopback binding', async url => {
  const f = await fixture()
  await expect(prepareCodexToolExecutionLaunch(f.plan, { ...f.execution, url }, f.options)).rejects.toMatchObject({ code: 'CODEX_TOOL_EXECUTION_LAUNCH_CONFLICT' })
})

it('does not project or stat a foreign native workspace path on the backend Host', async () => {
  const f = await fixture()
  expect((await prepareCodexToolExecutionLaunch(f.plan, { ...f.execution, workspacePath: 'C:\\owner\\project' }, f.options)).args.slice(0, 3)).toEqual(['--no-daemon', '-C', 'C:\\owner\\project'])
  await expect(prepareCodexToolExecutionLaunch(f.plan, { ...f.execution, workspacePath: 'relative' }, f.options)).rejects.toThrow('absolute')
})

it('refuses an unreadable environment selector instead of treating it as absent', async () => {
  const f = await fixture(); await mkdir(join(f.codexHome, 'environments.toml'))
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toThrow('cannot be read')
})

it('qualifies the actual Agent command with its environment and backend cwd, then freezes that executable', async () => {
  const f = await fixture(); f.plan.command = 'different-codex'; f.plan.env.PATH = '/agent/path'
  vi.mocked(qualifyCodexExecutionExecutable).mockResolvedValue('/agent/path/different-codex')
  const result = await prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)
  expect(qualifyCodexExecutionExecutable).toHaveBeenCalledWith('different-codex', { env: f.plan.env, workspacePath: f.home })
  expect(result.command).toBe('/agent/path/different-codex')
  vi.mocked(qualifyCodexExecutionExecutable).mockRejectedValue(new Error('actual Agent CLI is not qualified'))
  await expect(prepareCodexToolExecutionLaunch(f.plan, f.execution, f.options)).rejects.toThrow('actual Agent CLI is not qualified')
})


it('keeps native launch available and carries only the typed registration failure on its private URL', async () => {
  const f = await fixture()
  const server = createServer((_request, response) => { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'RUNTIME_OWNER_MISMATCH', message: 'private details must not be copied' })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing private endpoint')
    const url = `ws://127.0.0.1:${address.port}/private-capability`
    const result = await prepareCodexToolExecutionLaunch(f.plan, { ...f.execution, url }, { ...f.options, invocation: {
      agentSessionId: 'original-agent', lifecycleOperationId: 'original-lifecycle', capability: 'private-capability', endpointPath: '/original/core.sock', runtimeId: 'original-core', ctxmuxInstanceId: 'original-native'
    } })
    expect(result.env.CODEX_EXEC_SERVER_URL).toBe(url + '/unverified/RUNTIME_OWNER_MISMATCH')
    expect(result.args).toEqual(['--no-daemon', '-C', f.execution.workspacePath, ...f.plan.args])
    expect(JSON.stringify(result)).not.toContain('private details')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

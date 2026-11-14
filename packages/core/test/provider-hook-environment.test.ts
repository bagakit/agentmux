import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath } from '../src/providers/execution-environment.js'
import { cursorConfigRoot, cursorDataRoot } from '../src/providers/cursor-native-history.js'
import { claudeGlobalConfigPath } from '../src/providers/claude-native-settings.js'

const exec = promisify(execFile)
const configKeys = ['GROK_HOME', 'GEMINI_CLI_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'FACTORY_HOME_OVERRIDE', 'HERMES_HOME',
  'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CURSOR_DATA_DIR', 'CURSOR_CONFIG_DIR']
let root: string, workspace: string, privateHome: string, ambientHome: string
const registry = new AgentProviderRegistry()

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-hook-environment-')))
  workspace = join(root, 'workspace'); privateHome = join(root, 'run-home'); ambientHome = join(root, 'core-home')
  for (const path of [workspace, privateHome, ambientHome]) await mkdir(path)
  vi.stubEnv('HOME', ambientHome)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', undefined)
  for (const key of configKeys) vi.stubEnv(key, undefined)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function plan(providerId: string, env: Readonly<Record<string, string | undefined>>, cwd = workspace) {
  const value = registry.get(providerId).planManagedHooks?.({ workspacePath: cwd, env,
    endpoint: { url: 'http://127.0.0.1:1/private-unused', token: 'private-unused' } })
  expect(value, `${providerId} must produce its declared Hook plan`).toBeDefined()
  expect(value!.mutations.length).toBeGreaterThan(0)
  return value!
}

function childEnvironment(overrides: Readonly<Record<string, string | undefined>>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_')))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

describe('Provider Hook plans use the original launch environment', () => {
  it('covers every registered strategy and keeps all managed targets inside the exact private scope', () => {
    const providers = registry.list()
    expect(providers.length).toBeGreaterThan(0)
    const declared = providers.filter(provider => provider.catalog.hookStrategy.kind === 'native' &&
      provider.catalog.hookStrategy.installation === 'explicit-managed')
    expect(declared.length).toBeGreaterThan(0)
    const providerRoots: Record<string, string> = {
      claude: join(root, 'state'), grok: join(privateHome, '.grok'), gemini: join(privateHome, '.gemini'),
      antigravity: join(privateHome, '.gemini'), cursor: join(privateHome, '.cursor'), copilot: join(privateHome, '.copilot'),
      droid: join(privateHome, '.factory'), hermes: join(privateHome, '.hermes'), pi: join(privateHome, '.pi'),
      opencode: join(privateHome, '.config', 'opencode')
    }
    for (const provider of declared) {
      const expected = providerRoots[provider.id]
      expect(expected, `the native address oracle must cover ${provider.id}`).toBeDefined()
      const targets = plan(provider.id, { HOME: privateHome }).mutations
      expect(targets.length).toBeGreaterThan(0)
      expect(targets.every(target => target.path.startsWith(expected! + sep))).toBe(true)
      expect(targets.some(target => target.path.startsWith(ambientHome + sep))).toBe(false)
    }
    expect(registry.get('codex').catalog.hookStrategy).toEqual({ kind: 'native', installation: 'launch-carried' })
    expect(registry.get('kimi').catalog.hookStrategy).toEqual({ kind: 'native', installation: 'unmanaged' })
    expect(registry.get('traex').catalog.hookStrategy).toEqual({ kind: 'none' })
  })

  it.each([
    ['grok', 'GROK_HOME', 'hooks/agentmux-status.json'], ['copilot', 'COPILOT_HOME', 'hooks/agentmux.json'], ['droid', 'FACTORY_HOME_OVERRIDE', '.factory/hooks.json'],
    ['hermes', 'HERMES_HOME', 'config.yaml'], ['pi', 'PI_CODING_AGENT_DIR', 'extensions/agentmux.js'],
    ['opencode', 'OPENCODE_CONFIG_DIR', 'plugin/agentmux.js'], ['cursor', 'CURSOR_DATA_DIR', 'hooks.json'],
    ['gemini', 'GEMINI_CLI_HOME', '.gemini/settings.json']
  ])('%s preserves inherited and unset %s, and resolves relative roots at the launch workspace', (providerId, key, suffix) => {
    const inherited = join(root, 'inherited-native-root')
    vi.stubEnv(key, inherited)
    expect(plan(providerId, { HOME: privateHome }).mutations[0]!.path).toBe(join(inherited, suffix))
    const removed = plan(providerId, { HOME: privateHome, [key]: undefined }).mutations[0]!.path
    expect(removed.startsWith(privateHome + sep)).toBe(true)
    expect(plan(providerId, { HOME: privateHome, [key]: 'relative-native-root' }).mutations[0]!.path)
      .toBe(join(workspace, 'relative-native-root', suffix))
  })

  it('preserves native Grok empty and whitespace override rules', () => {
    expect(plan('grok', { HOME: privateHome, GROK_HOME: '' }).mutations[0]!.path)
      .toBe(join(privateHome, '.grok/hooks/agentmux-status.json'))
    expect(plan('grok', { HOME: privateHome, GROK_HOME: '  ' }).mutations[0]!.path)
      .toBe(join(workspace, '  /hooks/agentmux-status.json'))
  })

  it('keeps Gemini literal home overrides and its native temporary-directory fallback', async () => {
    const literal = plan('gemini', { HOME: privateHome, GEMINI_CLI_HOME: '  ' }).mutations[0]!.path
    expect(literal).toBe(join(workspace, '  /.gemini/settings.json'))
    const env = { HOME: '', GEMINI_CLI_HOME: undefined, TMPDIR: 'private-temp', TMP: undefined, TEMP: undefined }
    const target = plan('gemini', env).mutations[0]!.path
    const code = `const os=require('node:os'),path=require('node:path');
const home=process.env.GEMINI_CLI_HOME||os.homedir();
process.stdout.write(path.resolve(process.cwd(),home||os.tmpdir(),'.gemini','settings.json'));`
    const { stdout } = await exec(process.execPath, ['-e', code], { cwd: workspace, env: childEnvironment(env) })
    expect(target).toBe(join(workspace, 'private-temp/.gemini/settings.json'))
    expect(target).toBe(stdout)
  })

  it('keeps OpenCode precedence and explicit XDG unsets inside the chosen home', () => {
    vi.stubEnv('OPENCODE_CONFIG_DIR', join(root, 'inherited-opencode'))
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'inherited-xdg'))
    expect(plan('opencode', { HOME: privateHome, OPENCODE_CONFIG_DIR: undefined }).mutations[0]!.path)
      .toBe(join(root, 'inherited-xdg', 'opencode/plugin/agentmux.js'))
    expect(plan('opencode', { HOME: privateHome, OPENCODE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }).mutations[0]!.path)
      .toBe(join(privateHome, '.config/opencode/plugin/agentmux.js'))
  })

  it.each([
    ['OPENCODE_CONFIG_DIR', '', 'home', '.config/opencode/plugin/agentmux.js'],
    ['OPENCODE_CONFIG_DIR', '  ', 'workspace', '  /plugin/agentmux.js'],
    ['OPENCODE_CONFIG_DIR', 'relative root ', 'workspace', 'relative root /plugin/agentmux.js'],
    ['XDG_CONFIG_HOME', '', 'home', '.config/opencode/plugin/agentmux.js'],
    ['XDG_CONFIG_HOME', '  ', 'workspace', '  /opencode/plugin/agentmux.js'],
    ['XDG_CONFIG_HOME', 'relative root ', 'workspace', 'relative root /opencode/plugin/agentmux.js']
  ] as const)('keeps native OpenCode %s=%j literal path semantics', (key, value, base, suffix) => {
    // Native 1.18.25 debug config/paths, with private HOME and localhost-only networking:
    // empty overrides fall back; whitespace and trailing spaces remain path content.
    const env = { HOME: privateHome, OPENCODE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, [key]: value }
    expect(plan('opencode', env).mutations[0]!.path).toBe(join(base === 'home' ? privateHome : workspace, suffix))
  })

  it('uses the same launch home for Cursor Hook data and native inspection roots', () => {
    vi.stubEnv('CURSOR_DATA_DIR', join(root, 'inherited-data'))
    vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'inherited-config'))
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'inherited-xdg'))
    const env = { HOME: 'relative-home', CURSOR_DATA_DIR: undefined, CURSOR_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }
    const expected = join(workspace, 'relative-home/.cursor')
    expect(cursorDataRoot(workspace, env)).toBe(expected)
    expect(cursorConfigRoot(workspace, env)).toBe(expected)
    const targets = plan('cursor', env).mutations
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every(target => target.path.startsWith(expected + sep))).toBe(true)
  })

  it.each([undefined, '', '  ', 'relative-home'])('matches a real Node child home for literal HOME=%s without modifying the Core environment', async value => {
    const env = { HOME: value }
    const { stdout } = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({home:require("node:os").homedir()}))'],
      { cwd: workspace, env: childEnvironment(env) })
    expect(executionHomeDirectory(env)).toBe(JSON.parse(stdout).home)
    expect(executionPath(join(executionHomeDirectory(env), '.grok'), workspace))
      .toBe(resolve(workspace, JSON.parse(stdout).home, '.grok'))
    expect(process.env.HOME).toBe(ambientHome)
    expect(homedir()).toBe(ambientHome)
    if (value === undefined) expect(executionHomeDirectory(env)).toBe(userInfo().homedir)
  })

  it('keeps Claude existing trust configuration in the same launch environment without granting trust', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'inherited-claude'))
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', 'private-ambient-auth')
    const env = { HOME: 'relative-home', CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_CUSTOM_OAUTH_URL: undefined }
    expect(await claudeGlobalConfigPath(env, workspace)).toBe(join(workspace, 'relative-home/.claude.json'))
    expect(await claudeGlobalConfigPath({ ...env, CLAUDE_CONFIG_DIR: 'relative-config' }, workspace))
      .toBe(join(workspace, 'relative-config/.claude.json'))
    const legacy = join(workspace, 'relative-home/.claude/.config.json')
    await mkdir(join(legacy, '..'), { recursive: true }); await writeFile(legacy, '{"privateOriginal":true}')
    expect(await claudeGlobalConfigPath(env, workspace)).toBe(legacy)
    expect(await readFile(legacy, 'utf8')).toBe('{"privateOriginal":true}')
  })

  it('keeps an own unset distinct from an absent environment key', () => {
    vi.stubEnv('AMX_PRIVATE_NATIVE_ROOT', 'inherited')
    expect(executionEnvironmentValue({}, 'AMX_PRIVATE_NATIVE_ROOT')).toBe('inherited')
    expect(executionEnvironmentValue({ AMX_PRIVATE_NATIVE_ROOT: undefined }, 'AMX_PRIVATE_NATIVE_ROOT')).toBeUndefined()
    expect(executionEnvironmentValue({ AMX_PRIVATE_NATIVE_ROOT: '' }, 'AMX_PRIVATE_NATIVE_ROOT')).toBe('')
  })

  it('checks the same files that two real private child processes read, without implicit repair or Runtime actions', async () => {
    const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
    const client = new AgentMuxClient({ hookInstaller: installer, store: new AgentMuxMemoryAgentSessionStore() })
    const controls = [vi.spyOn(client, 'connect'), vi.spyOn(client, 'createAgent'), vi.spyOn(client, 'stopAgent')]
    vi.stubEnv('GEMINI_CLI_HOME', join(root, 'inherited-other-gemini'))
    const consumer = `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const home=process.env.GEMINI_CLI_HOME||os.homedir();
const target=path.resolve(process.cwd(),home||os.tmpdir(),'.gemini','settings.json');
process.stdout.write(JSON.stringify({target,configuration:JSON.parse(fs.readFileSync(target,'utf8'))}));`
    try {
      for (const name of ['first', 'second']) {
        const cwd = join(root, name); await mkdir(cwd)
        const env = { HOME: 'private-home', GEMINI_CLI_HOME: undefined }
        const target = plan('gemini', env, cwd).mutations[0]!.path
        expect(target).toBe(join(cwd, 'private-home/.gemini/settings.json'))
        expect(target.startsWith(root + sep)).toBe(true)
        await mkdir(join(target, '..'), { recursive: true })
        const foreign = { type: 'command', command: 'printf private-user-hook', timeout: 3 }
        await writeFile(target, JSON.stringify({ security: { privatePreference: name }, hooks: { BeforeTool: [{ hooks: [foreign] }] } }))
        await installer.ensure(plan('gemini', env, cwd))
        const original = await readFile(target, 'utf8')
        const inspected = await client.inspectManagedHooks('gemini', { workspacePath: cwd, env })
        expect(inspected).toMatchObject({ status: 'installed', workspacePath: cwd, targets: [{ path: target, status: 'current' }] })
        expect(await readFile(target, 'utf8')).toBe(original)
        const { stdout } = await exec(process.execPath, ['-e', consumer], { cwd, env: childEnvironment(env) })
        const native = JSON.parse(stdout)
        expect(native.target).toBe(target)
        expect(native.configuration.security).toEqual({ privatePreference: name })
        expect(native.configuration.hooks.BeforeTool[0].hooks).toEqual([foreign])
      }
      for (const control of controls) expect(control).not.toHaveBeenCalled()
    } finally { await client.dispose() }
  })
})

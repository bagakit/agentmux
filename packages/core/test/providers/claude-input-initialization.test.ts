import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, type AgentProviderInputInitializationContext } from '../../src/agent-provider.js'
import { readClaudeInputInitialization } from '../../src/providers/claude-native-settings.js'

const execute = promisify(execFile)
const unavailable = { state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' }
const unconfirmed = { state: 'unknown', reason: 'native-input-unconfirmed', source: 'unavailable', scope: 'unknown' }
const prerequisite = (reason: string, source = 'native-configuration') => ({ state: 'pending', reason, source, scope: 'prerequisite' })

describe('Claude native input initialization', () => {
  let base: string, home: string, workspace: string, command: string, observation: string, response: string, config: string
  let context: AgentProviderInputInitializationContext
  const status = async (value: unknown = { loggedIn: true, authMethod: 'claude.ai', configDirectory: join(home, '.claude') }, exitCode = 0) => {
    await writeFile(response, JSON.stringify({ value, exitCode }))
  }
  const configuration = async (projects: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, path = config) => {
    await writeFile(path, JSON.stringify({ hasCompletedOnboarding: true, projects, ...extra }))
  }
  const read = () => readClaudeInputInitialization(context)

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'amux-claude-initialization-')))
    home = join(base, 'home'); workspace = join(base, 'workspace')
    await mkdir(home); await mkdir(workspace)
    command = join(base, 'native-command'); response = join(base, 'response.json'); observation = join(base, 'observation.json')
    config = join(home, '.claude.json')
    // A real executable checks the actual subprocess boundary, including inherited environment.
    await writeFile(command, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.TEST_OBSERVATION, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));\nconst response = JSON.parse(fs.readFileSync(process.env.TEST_RESPONSE, 'utf8'));\nif (response.raw !== undefined) process.stdout.write(response.raw); else process.stdout.write(JSON.stringify(response.value));\nprocess.exit(response.exitCode);\n`, { mode: 0o700 })
    context = { command, args: [], processId: process.pid, workspacePath: workspace,
      agentSessionId: 'original-agent', run: { runId: 'original-run' }, purpose: 'initial-input',
      env: { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', TEST_RESPONSE: response, TEST_OBSERVATION: observation,
        ORIGINAL_AUTH_CONTEXT: 'original', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }
    await status(); await configuration({ [workspace]: { hasTrustDialogAccepted: true } })
  })
  afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }) })

  it('runs the registered Provider reader with only original environment, cwd and settings, never its saved prompt', async () => {
    vi.stubEnv('OBSERVER_AUTH_CONTEXT', 'must-not-leak')
    vi.stubEnv('HOME', join(base, 'observer-home'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(base, 'observer-config'))
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', 'observer-oauth')
    context.args = ['--model', 'original-model', '--settings', '{"apiKeyHelper":"original-helper"}', '--setting-sources=user,local',
      '--plugin-dir', '/original-plugin', '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', 'original system prompt',
      '--resume', 'original-session', 'saved user input must never be replayed']
    const provider = new AgentProviderRegistry().get('claude')
    expect(provider.readInputInitialization).toBe(readClaudeInputInitialization)
    expect(await provider.readInputInitialization!(context)).toEqual(unconfirmed)
    const observed = JSON.parse(await readFile(observation, 'utf8'))
    expect({ args: observed.args, cwd: observed.cwd }).toEqual({ args: ['--settings', '{"apiKeyHelper":"original-helper"}', '--setting-sources=user,local', 'auth', 'status'], cwd: workspace })
    // Foundation may add its own locale variable on macOS; check original launch
    // values and the observer-only authentication/configuration keys explicitly.
    expect(observed.env).toMatchObject(context.env)
    for (const key of ['OBSERVER_AUTH_CONTEXT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_CUSTOM_OAUTH_URL']) expect(Object.hasOwn(observed.env, key)).toBe(false)
    expect(await readFile(config, 'utf8')).toBe(JSON.stringify({ hasCompletedOnboarding: true, projects: { [workspace]: { hasTrustDialogAccepted: true } } }))
  })

  it('uses native JSON and exit status to identify an authentication prerequisite without reading credentials', async () => {
    await status({ loggedIn: false, authMethod: 'none', configDirectory: join(home, '.claude') }, 1)
    await rm(config)
    expect(await read()).toEqual(prerequisite('authentication', 'native-protocol'))
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(observation, 'utf8')).args).toEqual(['auth', 'status'])
  })

  it.each(['oauth_token', 'api_key', 'api_key_helper', 'third_party'])('accepts the native %s authentication method without changing it', async authMethod => {
    await status({ loggedIn: true, authMethod, configDirectory: join(home, '.claude') })
    expect(await read()).toEqual(unconfirmed)
  })

  it('reports missing directory trust as a configuration prerequisite, not a live permission request', async () => {
    await configuration({ [workspace]: { hasTrustDialogAccepted: false } })
    expect(await read()).toEqual(prerequisite('directory-trust'))
  })

  it('reports only explicit incomplete onboarding as a configuration prerequisite', async () => {
    await configuration({}, { hasCompletedOnboarding: false })
    expect(await read()).toEqual(prerequisite('onboarding'))
  })

  it('does not create missing configuration or claim which screen is showing', async () => {
    await rm(config)
    expect(await read()).toEqual(unavailable)
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not inherit observer config roots when the original native environment leaves them unset', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(base, 'observer-config'))
    vi.stubEnv('CLAUDE_CODE_CUSTOM_OAUTH_URL', 'observer-oauth')
    expect(await read()).toEqual(unconfirmed)
  })

  it('follows original custom configuration and the native legacy config file precedence', async () => {
    const directory = join(base, 'native-config'); await mkdir(directory)
    context.env = { ...context.env, CLAUDE_CONFIG_DIR: directory }
    await status({ loggedIn: true, authMethod: 'claude.ai', configDirectory: directory })
    await configuration({}, {}, join(directory, '.claude.json'))
    await configuration({ [workspace]: { hasTrustDialogAccepted: true } }, {}, join(directory, '.config.json'))
    expect(await read()).toEqual(unconfirmed)
  })

  it('binds configuration to the config directory reported by the original native command', async () => {
    await status({ loggedIn: false, authMethod: 'none', configDirectory: join(base, 'other-source') }, 1)
    expect(await read()).toEqual(unavailable)
  })

  it('reads physical native workspace keys through a symlink', async () => {
    const alias = join(base, 'workspace-alias'); await symlink(workspace, alias)
    context.workspacePath = alias
    expect(await read()).toEqual(unconfirmed)
  })

  it('honors trusted ancestors outside Git without inventing an exact-directory requirement', async () => {
    await configuration({ [base]: { hasTrustDialogAccepted: true } })
    expect(await read()).toEqual(unconfirmed)
  })

  it('does not carry trust from an ancestor into a different nested Git repository', async () => {
    await execute('git', ['init', '--quiet', workspace], { env: context.env })
    await configuration({ [base]: { hasTrustDialogAccepted: true } })
    expect(await read()).toEqual(prerequisite('directory-trust'))
    const child = join(workspace, 'child'); await mkdir(child)
    context.workspacePath = child
    await configuration({ [workspace]: { hasTrustDialogAccepted: true } })
    expect(await read()).toEqual(unconfirmed)
  })

  it('keeps unknown when a nonstandard Git environment prevents binding the trust ancestry', async () => {
    context.env = { ...context.env, GIT_WORK_TREE: join(base, 'different-tree') }
    await configuration({ [base]: { hasTrustDialogAccepted: true } })
    expect(await read()).toEqual(unavailable)
  })

  it.each([
    { loggedIn: true, authMethod: 'none' }, { loggedIn: 'yes', authMethod: 'claude.ai' },
    { loggedIn: true, authMethod: 'future-method' }, { loggedIn: true }, null
  ])('keeps malformed native authentication facts unknown: %j', async value => {
    await status(value && { ...value, configDirectory: join(home, '.claude') })
    expect(await read()).toEqual(unavailable)
  })

  it.each([[true, 1], [false, 0], [false, 2]])('rejects contradictory native login status %s / exit %s', async (loggedIn, exitCode) => {
    await status({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', configDirectory: join(home, '.claude') }, exitCode as number)
    expect(await read()).toEqual(unavailable)
  })

  it('keeps invalid JSON and invalid configuration unknown', async () => {
    await writeFile(response, JSON.stringify({ raw: 'not JSON', exitCode: 0 }))
    expect(await read()).toEqual(unavailable)
    await status(); await writeFile(config, '{ malformed')
    expect(await read()).toEqual(unavailable)
  })

  it.each([['--unknown-wrapper-option'], ['auth', 'login'], ['--settings'], ['--', 'two', 'inputs']])('does not invoke ambiguous original arguments: %j', async (...args) => {
    context.args = args
    expect(await read()).toEqual(unavailable)
    await expect(stat(observation)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops an exact final separator and opaque saved input', async () => {
    context.args = ['--settings={}', '--', '--auth-looking-saved-input']
    expect(await read()).toEqual(unconfirmed)
    expect(JSON.parse(await readFile(observation, 'utf8')).args).toEqual(['--settings={}', 'auth', 'status'])
  })

  it('uses the original PATH for a bare native command and original cwd for a relative command', async () => {
    context.command = 'native-command'; context.env = { ...context.env, PATH: base }
    expect(await read()).toEqual(unconfirmed)
    context.command = '../native-command'; context.env = { ...context.env, PATH: undefined }
    expect(await read()).toEqual(unconfirmed)
  })

  it('does not inspect a remote, missing command or incomplete original environment', async () => {
    for (const change of [{ processId: undefined }, { command: undefined }, { env: {} }, { command: 'native-command', env: { ...context.env, PATH: undefined } }]) {
      expect(await readClaudeInputInitialization({ ...context, ...change })).toEqual(unavailable)
    }
    await expect(stat(observation)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels only this read-only observation without invoking native input', async () => {
    const abort = new AbortController(); abort.abort(new Error('observation canceled'))
    await expect(readClaudeInputInitialization({ ...context, signal: abort.signal })).rejects.toThrow('observation canceled')
    await expect(stat(observation)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

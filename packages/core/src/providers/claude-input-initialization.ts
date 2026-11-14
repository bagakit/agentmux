import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProviderInputInitialization, AgentProviderInputInitializationContext } from '../agent-provider.js'
import { claudeLaunchValueOptions } from './claude-launch-options.js'
import { claudeGlobalConfigPath, claudeTrustKey } from './claude-workspace-trust.js'

const execute = promisify(execFile)
const unavailable: AgentProviderInputInitialization = { state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' }
const unconfirmed: AgentProviderInputInitialization = { state: 'unknown', reason: 'native-input-unconfirmed', source: 'unavailable', scope: 'unknown' }
const flags = new Set(['--continue', '-c', '--print', '-p', '--verbose', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config', '--no-session-persistence', '--chrome', '--no-chrome', '--disable-slash-commands'])
const authMethods = new Set(['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'])

/** Keep native settings selection, never the launch prompt or a conversation command. */
function authenticationArgs(original: readonly string[]): string[] | undefined {
  const selected: string[] = []
  for (let i = 0; i < original.length; i++) {
    const arg = original[i]!
    if (arg === '--') return i >= original.length - 2 ? selected : undefined
    if (!arg.startsWith('-')) return i === original.length - 1 ? selected : undefined
    if (flags.has(arg)) continue
    // Safe mode also changes which native configuration is active.
    if (arg === '--safe-mode') { selected.push(arg); continue }
    const at = arg.indexOf('='), name = at < 0 ? arg : arg.slice(0, at)
    if (name === '--mcp-config') {
      if (at >= 0) continue
      const start = ++i
      while (i < original.length && !original[i]!.startsWith('-')) i++
      if (i === start) return
      i--
      continue
    }
    if (!claudeLaunchValueOptions.has(name)) return
    const value = at < 0 ? original[++i] : arg.slice(at + 1)
    if (value === undefined) return
    if (name === '--settings' || name === '--setting-sources') selected.push(...(at < 0 ? [arg, value] : [arg]))
  }
  return selected
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  return resolve(left) === resolve(right) || await realpath(left) === await realpath(right)
}

/** Match the existing native trust contract, including nested repository boundaries. */
async function directoryTrusted(config: Record<string, unknown>, context: AgentProviderInputInitializationContext, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (config.projects !== undefined && !object(config.projects)) throw new Error('Unconfirmed native projects configuration')
  const projects = (config.projects ?? {}) as Record<string, unknown>
  const workspace = await realpath(context.workspacePath)
  const trusted = async (directory: string) => { const entry = projects[await claudeTrustKey(directory)]; return object(entry) && entry.hasTrustDialogAccepted === true }
  if (await trusted(workspace)) return true
  // These native overrides can place the repository outside the physical ancestry.
  if (env.GIT_DIR || env.GIT_WORK_TREE) throw new Error('Unconfirmed native repository scope')
  let directory = workspace, repositoryMarker: string | undefined
  for (;;) {
    context.signal?.throwIfAborted()
    try { await stat(join(directory, '.git')); repositoryMarker ??= directory }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (await trusted(directory)) {
      if (!repositoryMarker) return true
      const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], {
        cwd: context.workspacePath, env, ...(context.signal ? { signal: context.signal } : {}), maxBuffer: 1024 * 1024
      })
      const root = await realpath(stdout.trim())
      // A trusted ancestor above the native repository cannot cover that repository.
      const contains = (path: string) => { const child = relative(root, path); return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`) }
      return contains(workspace) && contains(directory)
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * A fresh read of native prerequisites, never proof of a live prompt or permission to answer it.
 * Core supplies the original process environment; observer environment is never merged in.
 */
export async function readClaudeInputInitialization(context: AgentProviderInputInitializationContext): Promise<AgentProviderInputInitialization> {
  const args = authenticationArgs(context.args)
  const home = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const commandHasPath = context.command && (isAbsolute(context.command) || context.command.includes('/') || process.platform === 'win32' && context.command.includes('\\'))
  if (!context.command || !commandHasPath && !context.env.PATH || context.processId === undefined || !args || !context.env[home]) return unavailable
  context.signal?.throwIfAborted()
  try {
    const env = Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    let stdout: string, exitCode = 0
    try {
      ;({ stdout } = await execute(context.command, [...args, 'auth', 'status'], {
        cwd: context.workspacePath, env, ...(context.signal ? { signal: context.signal } : {}), maxBuffer: 1024 * 1024
      }))
    } catch (error) {
      context.signal?.throwIfAborted()
      const result = error as { code?: unknown; stdout?: unknown }
      if (result.code !== 1 || typeof result.stdout !== 'string') return unavailable
      stdout = result.stdout; exitCode = 1
    }
    const status: unknown = JSON.parse(stdout)
    if (!object(status) || typeof status.loggedIn !== 'boolean' || typeof status.authMethod !== 'string' ||
        !authMethods.has(status.authMethod) || typeof status.configDirectory !== 'string' ||
        status.loggedIn !== (exitCode === 0) || status.loggedIn && status.authMethod === 'none') return unavailable
    const configRoot = resolve(context.workspacePath, env.CLAUDE_CONFIG_DIR || join(env[home]!, '.claude'))
    if (!await sameDirectory(status.configDirectory, configRoot)) return unavailable
    if (!status.loggedIn) return { state: 'pending', reason: 'authentication', source: 'native-protocol', scope: 'prerequisite' }
    // Explicit absence prevents the shared config locator from inheriting observer settings.
    const configPath = await claudeGlobalConfigPath({ ...env, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_CUSTOM_OAUTH_URL: env.CLAUDE_CODE_CUSTOM_OAUTH_URL }, context.workspacePath)
    const config: unknown = JSON.parse(await readFile(configPath, { encoding: 'utf8', ...(context.signal ? { signal: context.signal } : {}) }))
    if (!object(config)) return unavailable
    if (config.hasCompletedOnboarding === false) return { state: 'pending', reason: 'onboarding', source: 'native-configuration', scope: 'prerequisite' }
    if (!await directoryTrusted(config, context, env)) return { state: 'pending', reason: 'directory-trust', source: 'native-configuration', scope: 'prerequisite' }
    return unconfirmed
  } catch {
    context.signal?.throwIfAborted()
    return unavailable
  }
}

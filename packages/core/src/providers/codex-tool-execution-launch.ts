import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import type { AgentLaunchPlan } from '../types.js'
import { agentControlFailureCode, registerAgentExecutionInvocation, type AgentExecutionInvocation } from '../agent-execution-rpc-relay.js'
import { qualifyCodexExecutionExecutable } from './codex-execution-helper.js'

const noiseOverrides = ['CODEX_EXEC_SERVER_NOISE_REGISTRY_URL', 'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID', 'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN'] as const
const valueOptions = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '-i', '--image', '--add-dir'])

export class CodexToolExecutionLaunchError extends Error {
  readonly code = 'CODEX_TOOL_EXECUTION_LAUNCH_CONFLICT'
}

function nativeArguments(args: readonly string[], workspacePath: string): string[] {
  const retained: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    // Provider-produced prompt footer is opaque user input, even if it looks
    // like native flags or subcommands. Preserve native resume IDs unchanged.
    if (arg === '--') { retained.push(...args.slice(index)); break }
    if (arg === '--remote' || arg.startsWith('--remote=') || arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env=')) throw new CodexToolExecutionLaunchError('The launch targets an app server; tool execution requires the original ordinary native CLI')
    if (arg === '-C' || arg === '--cd') {
      if (args[++index] === undefined) throw new CodexToolExecutionLaunchError('Native working-directory option is missing its value')
      continue
    }
    if (arg.startsWith('--cd=') || (arg.startsWith('-C') && arg.length > 2) || arg === '--no-daemon') continue
    retained.push(arg)
    if (valueOptions.has(arg)) {
      const value = args[++index]
      if (value === undefined) throw new CodexToolExecutionLaunchError('Native CLI option is missing its value')
      retained.push(value)
    }
  }
  return ['--no-daemon', '-C', workspacePath, ...retained]
}

/**
 * Qualify the native environment selector before launching the ordinary TUI.
 * This reads configuration, never edits it or replaces CODEX_HOME/history.
 * It does not set the Run cwd: backend process cwd and tool cwd have different
 * owners. The caller still verifies the native executor binding after launch.
 */
export async function prepareCodexToolExecutionLaunch(
  plan: AgentLaunchPlan,
  execution: { workspacePath: string; url: string },
  options: { inheritedEnv?: Readonly<NodeJS.ProcessEnv>; launchWorkspacePath?: string; invocation?: AgentExecutionInvocation } = {},
): Promise<AgentLaunchPlan> {
  const { workspacePath } = execution
  if (!workspacePath || workspacePath.includes('\0') || (!isAbsolute(workspacePath) && !win32.isAbsolute(workspacePath))) throw new CodexToolExecutionLaunchError('Tool workspace must be an absolute owner-Host path')
  let url: URL
  try { url = new URL(execution.url) } catch { throw new CodexToolExecutionLaunchError('Invalid native executor bridge URL') }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname === '/' || url.username || url.password || url.search || url.hash) throw new CodexToolExecutionLaunchError('Native executor bridge must use a capability URL on IPv4 loopback')
  const env = { ...(options.inheritedEnv ?? process.env), ...plan.env }
  if (noiseOverrides.some(name => env[name]?.trim())) throw new CodexToolExecutionLaunchError('Native rendezvous environment configuration overrides the requested tool execution binding')
  let codexHome: string
  if (env.CODEX_HOME) {
    if (!isAbsolute(env.CODEX_HOME) && !options.launchWorkspacePath) throw new CodexToolExecutionLaunchError('A relative CODEX_HOME requires the original backend launch directory')
    codexHome = isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : resolve(options.launchWorkspacePath!, env.CODEX_HOME)
    // Match the native requirement for an explicit CODEX_HOME directory.
    try {
      if (!(await stat(codexHome)).isDirectory()) throw new Error('not a directory')
      codexHome = await realpath(codexHome)
    } catch { throw new CodexToolExecutionLaunchError('The effective CODEX_HOME directory is unavailable') }
  } else {
    const home = env.HOME || env.USERPROFILE || homedir()
    if (!isAbsolute(home)) throw new CodexToolExecutionLaunchError('The effective native user home is not absolute')
    codexHome = join(home, '.codex')
  }
  const environmentPath = join(codexHome, 'environments.toml')
  try {
    await readFile(environmentPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexToolExecutionLaunchError('The effective environments.toml cannot be read; the requested execution binding is unconfirmed')
    const command = await qualifyCodexExecutionExecutable(plan.command, { env, ...(options.launchWorkspacePath === undefined ? {} : { workspacePath: options.launchWorkspacePath }) })
    let nativeUrl = execution.url
    if (options.invocation) {
      // Agent control qualification is independent of healthy native execution.
      // Failed or unknown registration remains visible without blocking native tools.
      try { nativeUrl = await registerAgentExecutionInvocation(execution.url, options.invocation) } catch (error) {
        // This reserved machine path reports qualification only; it grants no caller.
        nativeUrl = execution.url + '/unverified/' + agentControlFailureCode(error)
      }
    }
    return { ...plan, command, args: nativeArguments(plan.args, workspacePath), env: { ...plan.env, CODEX_EXEC_SERVER_URL: nativeUrl } }
  }
  // Native selects the TOML provider by presence, even for an empty/comment-only
  // file. It does not merge CODEX_EXEC_SERVER_URL into that provider. No TOML
  // guessing, user-file rewriting or silent local fallback is permitted here.
  throw new CodexToolExecutionLaunchError('The effective environments.toml overrides CODEX_EXEC_SERVER_URL; the requested execution binding is not selected')
}

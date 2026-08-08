import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const PROFILE_SHELL_TIMEOUT_MS = 5_000

export type LoginShellEnvironmentHydration =
  | { ok: true; shell: string; mode: 'interactive-login' | 'login' }
  | { ok: false; reason: 'unsupported-platform' | 'unavailable-shell' | 'probe-failed' | 'invalid-environment' }

type ProfileShellRunner = (
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => Promise<string>

function mergePath(primary: string, inherited: string | undefined): string {
  const seen = new Set<string>()
  return [primary, inherited ?? '']
    .flatMap((value) => value.split(':'))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !seen.has(entry) && seen.add(entry))
    .join(':')
}

function profileShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const configured = env.SHELL?.trim()
  if (configured) return configured
  if (platform === 'darwin') return '/bin/zsh'
  if (platform === 'linux') return '/bin/bash'
  return null
}

function runProfileShell(
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(shell, [...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: PROFILE_SHELL_TIMEOUT_MS
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

// Frame NUL-delimited env output, keeping banners outside and arbitrary values inside untouched.
export function parseLoginShellEnvironment(stdout: string, marker: string): Record<string, string> | null {
  const boundary = `${marker}\0`
  const start = stdout.indexOf(boundary)
  if (start < 0) return null
  const valueStart = start + boundary.length
  const end = stdout.indexOf(`\0${boundary}`, valueStart)
  if (end < 0) return null
  const entries = stdout.slice(valueStart, end + 1).split('\0')
  if (entries.pop() !== '') return null
  const result: Record<string, string> = Object.create(null)
  for (const entry of entries) {
    const equals = entry.indexOf('=')
    if (equals <= 0) return null
    result[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return result
}

export async function hydrateProcessEnvironmentFromLoginShell(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  runner?: ProfileShellRunner
} = {}): Promise<LoginShellEnvironmentHydration> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'darwin' && platform !== 'linux') {
    return { ok: false, reason: 'unsupported-platform' }
  }
  const shell = profileShell(platform, env)
  if (!shell) return { ok: false, reason: 'unavailable-shell' }

  const marker = `__AGENTMUX_ENV_${randomUUID()}__`
  const command = `printf '%s\\0' '${marker}'; /usr/bin/env -0; printf '%s\\0' '${marker}'`
  const runner = options.runner ?? runProfileShell
  let probeFailed = false
  for (const args of [['-ilc', command], ['-lc', command]] as const) {
    let stdout: string
    try {
      stdout = await runner(shell, args, env)
    } catch {
      probeFailed = true
      continue
    }
    const parsed = parseLoginShellEnvironment(stdout, marker)
    if (!parsed) continue
    if (args[0] === '-lc') parsed.PATH = mergePath(parsed.PATH ?? '', env.PATH)
    // These belong to the probe shell, not to the application that launched it.
    for (const key of ['_', 'SHLVL', 'PWD', 'OLDPWD']) delete parsed[key]
    Object.assign(env, parsed)
    return { ok: true, shell, mode: args[0] === '-ilc' ? 'interactive-login' : 'login' }
  }
  return { ok: false, reason: probeFailed ? 'probe-failed' : 'invalid-environment' }
}

export function loginShellEnvironmentWarning(result: LoginShellEnvironmentHydration): string | undefined {
  if (result.ok) {
    return result.mode === 'interactive-login' ? undefined
      : 'Only the non-interactive login environment was loaded; interactive configuration such as .zshrc could not be confirmed.'
  }
  if (result.reason === 'unsupported-platform') return undefined
  return 'Shell environment loading did not complete. New Agents and terminals use the inherited application environment.'
}

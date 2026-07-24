import { execFile } from 'node:child_process'

const PATH_MARKER = '__AGENTMUX_LOGIN_SHELL_PATH__'
const PROFILE_SHELL_TIMEOUT_MS = 5_000
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g // eslint-disable-line no-control-regex

export type LoginShellPathHydration =
  | { ok: true; path: string; shell: string }
  | { ok: false; reason: 'unsupported-platform' | 'unavailable-shell' | 'probe-failed' | 'empty-path' }

type ProfileShellRunner = (
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => Promise<string>

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

export function parseLoginShellPath(stdout: string): string | null {
  const clean = stdout.replace(ANSI_ESCAPE, '')
  const start = clean.indexOf(PATH_MARKER)
  if (start < 0) return null
  const valueStart = start + PATH_MARKER.length
  const end = clean.indexOf(PATH_MARKER, valueStart)
  if (end < 0) return null
  return clean.slice(valueStart, end).trim() || null
}

export async function hydrateProcessPathFromLoginShell(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  runner?: ProfileShellRunner
} = {}): Promise<LoginShellPathHydration> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'darwin' && platform !== 'linux') {
    return { ok: false, reason: 'unsupported-platform' }
  }
  const shell = profileShell(platform, env)
  if (!shell) return { ok: false, reason: 'unavailable-shell' }

  const command = `printf '%s' '${PATH_MARKER}'; printf '%s' "$PATH"; printf '%s' '${PATH_MARKER}'`
  let stdout: string
  try {
    stdout = await (options.runner ?? runProfileShell)(shell, ['-ilc', command], env)
  } catch {
    return { ok: false, reason: 'probe-failed' }
  }
  const path = parseLoginShellPath(stdout)
  if (!path) return { ok: false, reason: 'empty-path' }

  // The profile-loading shell is authoritative. Core detection and every local
  // CtxMux child now inherit exactly the same PATH instead of separately
  // guessing tool locations from a packaged GUI process.
  env.PATH = path
  return { ok: true, path, shell }
}

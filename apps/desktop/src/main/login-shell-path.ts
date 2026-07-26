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
  const runner = options.runner ?? runProfileShell
  let stdout: string | null = null
  let probeFailed = false
  for (const args of [['-ilc', command], ['-lc', command]] as const) {
    try {
      stdout = await runner(shell, args, env)
    } catch {
      probeFailed = true
      continue
    }
    const parsed = parseLoginShellPath(stdout)
    if (parsed) {
      // A packaged GUI can inherit a sparse PATH. Keep the profile result first, but retain any
      // already-provided entries so a shell profile that intentionally omits them cannot make an
      // otherwise executable Host disappear.
      const path = args[0] === '-lc' ? mergePath(parsed, env.PATH) : parsed
      env.PATH = path
      return { ok: true, path, shell }
    }
  }
  if (probeFailed) return { ok: false, reason: 'probe-failed' }
  return { ok: false, reason: 'empty-path' }
}

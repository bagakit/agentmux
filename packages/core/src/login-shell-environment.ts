import { mintObjectId } from './object-id.js'
import { execFile } from 'node:child_process'

/** Total budget for the whole hydration, spent across every probe arm — not a per-arm allowance. */
const PROFILE_SHELL_TIMEOUT_MS = 30_000
/** Leave room for the killed child to exit before the caller's hard deadline settles. */
const PROFILE_SHELL_REAP_MARGIN_MS = 100

export type LoginShellEnvironmentHydration =
  | { ok: true; shell: string; mode: 'interactive-login' | 'login' }
  | { ok: false; reason: 'unsupported-platform' | 'unavailable-shell' | 'probe-failed' | 'invalid-environment' }

type ProfileShellRunner = (
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
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

/**
 * `killSignal: 'SIGKILL'` is load-bearing, not defensive tidying. `execFile`'s `timeout` sends
 * SIGTERM, and an interactive shell blocked on a `read` in the user's `.zshrc` ignores SIGTERM:
 * measured on a probe rc that reads a line, the callback never fires — `killed=true`,
 * `exitCode=null`, `signalCode=null`, and the promise never settles. SIGKILL is not catchable, so
 * the child dies and the callback runs (measured: settles at ~5004ms with `err=SIGKILL`).
 *
 * The rejected first candidate is worth recording, because it reads as the obvious fix: giving the
 * child `stdio: ['ignore', …]` so `read` sees EOF. It does not work — an interactive shell reads
 * from `/dev/tty`, not from stdin, so the probe still hung past 8s.
 */
function runProfileShell(
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(shell, [...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: Math.max(1, timeoutMs - PROFILE_SHELL_REAP_MARGIN_MS),
      killSignal: 'SIGKILL'
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Bound a probe arm at the caller's side as well.
 *
 * The SIGKILL above fixes the shipped runner. Bound its caller too so a runner that loses
 * its callback cannot leave new execution preparation waiting forever. Window creation,
 * original metadata and healthy Run use proceed independently of this preparation.
 * A missed deadline keeps the inherited environment and publishes the existing warning.
 *
 * `work` is a thunk, not a promise, so an exhausted budget never starts the arm at all. Taking a
 * promise made the caller evaluate `runner(…, remainingMs)` before the budget check, and a negative
 * remainder reached `execFile` as an asynchronously-thrown `ERR_OUT_OF_RANGE` — which vitest reports
 * as an unhandled error while still printing every test as passed.
 */
function withDeadline(work: () => Promise<string>, budgetMs: number): Promise<string> {
  if (budgetMs <= 0) return Promise.reject(new Error('Login shell probe budget exhausted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Login shell probe exceeded its deadline')), budgetMs)
    // A probe that overruns is abandoned, not awaited: `unref` keeps the timer from holding the
    // event loop open, and settling first wins because a settled promise ignores later calls.
    timer.unref?.()
    work().then(resolve, reject).finally(() => clearTimeout(timer))
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
  timeoutMs?: number
} = {}): Promise<LoginShellEnvironmentHydration> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'darwin' && platform !== 'linux') {
    return { ok: false, reason: 'unsupported-platform' }
  }
  const shell = profileShell(platform, env)
  if (!shell) return { ok: false, reason: 'unavailable-shell' }

  const marker = `__AGENTMUX_ENV_${mintObjectId()}__`
  const command = `printf '%s\\0' '${marker}'; /usr/bin/env -0; printf '%s\\0' '${marker}'`
  const runner = options.runner ?? runProfileShell
  const budgetMs = options.timeoutMs ?? PROFILE_SHELL_TIMEOUT_MS
  // Start both modes together under one deadline. A ready login result cannot replace complete
  // interactive exports merely because it returned first.
  type Probe = { kind: 'valid'; values: Record<string, string> } | { kind: 'invalid' | 'failed' }
  const probe = async (mode: '-ilc' | '-lc', remainingMs: number): Promise<Probe> => {
    try {
      const stdout = await withDeadline(() => runner(shell, [mode, command], env, remainingMs), remainingMs)
      const values = parseLoginShellEnvironment(stdout, marker)
      return values ? { kind: 'valid', values } : { kind: 'invalid' }
    } catch {
      return { kind: 'failed' }
    }
  }
  const interactive = probe('-ilc', budgetMs)
  const fallback = probe('-lc', budgetMs)
  const interactiveResult = await interactive
  if (interactiveResult.kind === 'valid') {
    for (const key of ['_', 'SHLVL', 'PWD', 'OLDPWD']) delete interactiveResult.values[key]
    Object.assign(env, interactiveResult.values)
    return { ok: true, shell, mode: 'interactive-login' }
  }
  const loginResult = await fallback
  if (loginResult.kind === 'valid') {
    loginResult.values.PATH = mergePath(loginResult.values.PATH ?? '', env.PATH)
    for (const key of ['_', 'SHLVL', 'PWD', 'OLDPWD']) delete loginResult.values[key]
    Object.assign(env, loginResult.values)
    return { ok: true, shell, mode: 'login' }
  }
  return { ok: false, reason: interactiveResult.kind === 'failed' || loginResult.kind === 'failed' ? 'probe-failed' : 'invalid-environment' }
}

/** Prepare exports off to the side; shell setup never owns the original Host namespace. */
export async function prepareProcessEnvironmentFromLoginShell(
  options: Parameters<typeof hydrateProcessEnvironmentFromLoginShell>[0] = {}
): Promise<LoginShellEnvironmentHydration> {
  const target = options.env ?? process.env
  const prepared = { ...target }
  const result = await hydrateProcessEnvironmentFromLoginShell({ ...options, env: prepared })
  for (const [key, value] of Object.entries(prepared)) {
    // HOME and temporary roots also participate in Core's default namespace paths.
    if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_') || ['HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(key)) continue
    if (value !== undefined) target[key] = value
  }
  return result
}

export function loginShellEnvironmentWarning(result: LoginShellEnvironmentHydration): string | undefined {
  if (result.ok) {
    return result.mode === 'interactive-login' ? undefined
      : 'Only the non-interactive login environment was loaded; interactive configuration such as .zshrc could not be confirmed.'
  }
  if (result.reason === 'unsupported-platform') return undefined
  return 'Shell environment loading did not complete. New Agents and terminals use the inherited application environment.'
}

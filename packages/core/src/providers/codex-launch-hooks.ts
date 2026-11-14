import { parse, type TomlValue } from 'smol-toml'
import { HOOK_COMMAND_TIMEOUT_SECONDS, runScopedHookCommand } from './shared.js'

export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'
] as const

export const CODEX_HOOK_SOURCE_PATH = '/<session-flags>/config.toml'
const PERMISSION_TIMEOUT_SECONDS = 600
const INTERRUPT_TIMEOUT_SECONDS = 3
type HookGroup = { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }
const VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
  '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'])
const SWITCHES = new Set(['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust', '--yolo', '--worktree', '--search', '--no-alt-screen', '--no-daemon', '-h', '--help', '-V', '--version'])
function unknownOption(arg: string): boolean {
  return arg.startsWith('--') ? !arg.includes('=') && !SWITCHES.has(arg)
    : arg.startsWith('-') && !SWITCHES.has(arg) &&
      !['-c', '-i', '-m', '-p', '-s', '-C', '-a'].some(prefix => arg.startsWith(prefix) && arg.length > prefix.length)
}

/** Native effective values: a permission callback waits for the person; Interrupt is capped at 3s. */
export function codexManagedHooks(): Record<(typeof CODEX_HOOK_EVENTS)[number], HookGroup[]> {
  const command = runScopedHookCommand('codex')
  return Object.fromEntries(CODEX_HOOK_EVENTS.map(event => [event, [{
    ...(event === 'SessionStart' ? { matcher: 'startup|resume|clear|compact' } : {}),
    hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? PERMISSION_TIMEOUT_SECONDS
      : event === 'Interrupt' ? INTERRUPT_TIMEOUT_SECONDS : HOOK_COMMAND_TIMEOUT_SECONDS }]
  }]])) as ReturnType<typeof codexManagedHooks>
}

/** TOML inline values preserve parsed user callbacks, including literal strings and quoted keys. */
function inline(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value).replaceAll('\u007f', '\\u007f')
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : value === Infinity ? 'inf' : value === -Infinity ? '-inf' : String(value)
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return `[${value.map(inline).join(',')}]`
  return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${inline(child)}`).join(',')}}`
}

/** The same declarations feed launch, the native reader and managed-server qualification. */
export function codexManagedHookConfigs(): string[] {
  return Object.entries(codexManagedHooks()).map(([event, groups]) => `hooks.${event}=${inline(groups)}`)
}

export function isCodexManagedHookConfig(value: string): boolean {
  return codexManagedHookConfigs().includes(value)
}

/** A prompt or another option's value cannot grant the native trust bypass. Unknown argv stays unknown. */
export function codexHookTrustBypassed(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') return false
    if (VALUE_OPTIONS.has(arg)) { index += 1; continue }
    if (arg === '--dangerously-bypass-hook-trust') return true
    if (unknownOption(arg)) return false
  }
  return false
}

/**
 * Session flags replace an event's entire array. Preserve the last effective user array before
 * adding our callback, rather than letting our appended flag erase it. A malformed/unknown Hook
 * override stays byte-for-byte on the original invocation; inspection reports that exact gap.
 */
export function withCodexLaunchHooks(args: readonly string[]): { args: string[]; issue?: string } {
  let overrides: Record<string, TomlValue> = {}
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!
      if (arg === '--') return { args: [...args], issue: 'The configured Codex argument boundary is opaque; the original arguments were retained.' }
      const config = arg === '-c' || arg === '--config' ? args[++index]
        : arg.startsWith('--config=') ? arg.slice('--config='.length)
        : arg.startsWith('-c') && !arg.startsWith('--') && arg.length > 2 ? arg.slice(2) : undefined
      if (config === undefined) {
        if (arg === '-c' || arg === '--config') return { args: [...args], issue: 'The configured Codex Hook option has no value; the original arguments were retained.' }
        if (VALUE_OPTIONS.has(arg)) { index += 1; continue }
        if (unknownOption(arg)) return { args: [...args], issue: 'A configured Codex option could not be interpreted; the original arguments were retained.' }
        continue
      }
      const equals = config.indexOf('=')
      if (equals < 0) continue
      // Parsing the key separately avoids treating Codex's unrelated raw-string values as TOML.
      const key = parse(config.slice(0, equals) + '=0').hooks
      if (key === undefined) continue
      const hooks = parse(config).hooks
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks) || hooks instanceof Date) {
        return { args: [...args], issue: 'The configured Codex hooks override is not a table.' }
      }
      overrides = key === 0 ? { ...hooks } : { ...overrides, ...hooks }
    }
    const flags: string[] = []
    let complete = true
    for (const [event, owned] of Object.entries(codexManagedHooks())) {
      const existing = overrides[event]
      if (existing !== undefined && !Array.isArray(existing)) {
        return { args: [...args], issue: `The configured Codex hooks.${event} override is not an array.` }
      }
      const groups = existing ?? []
      const present = groups.some(group => inline(group) === inline(owned[0]!))
      complete &&= present
      const declaration = present ? groups : [...groups, ...owned]
      flags.push('-c', `hooks.${event}=${inline(declaration)}`)
    }
    return { args: complete ? [...args] : [...args, ...flags] }
  } catch {
    return { args: [...args], issue: 'The configured Codex Hook session flags could not be interpreted; the original flags were retained.' }
  }
}

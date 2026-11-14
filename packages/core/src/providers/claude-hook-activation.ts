import { readFile } from 'node:fs/promises'
import { executionEnvironmentValue, executionHomeDirectory, executionPath } from './execution-environment.js'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { claudeLaunchValueOptions } from './claude-launch-options.js'
import type { AgentProviderHookActivation, AgentProviderHookActivationContext } from '../agent-provider.js'

const MANAGED_SETTINGS = process.platform === 'darwin'
  ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
  : '/etc/claude-code/managed-settings.json'
const DISABLED: AgentProviderHookActivation = { active: false, code: 'HOOK_CONFIGURATION_DISABLED',
  action: 'Claude settings disable AgentMux Hooks for this launch. Review that Claude setting, then inspect again.' }

type Source = { name: string; read(): Promise<Record<string, unknown> | undefined> }

async function settingsFile(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  let text: string
  try { text = await readFile(path, { encoding: 'utf8', signal }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return parse(text, path)
}

function parse(text: string, name: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new AgentMuxError(`Claude settings source ${name} is not valid JSON.`, 'HOOK_TARGET_UNPARSEABLE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError(`Claude settings source ${name} is not a JSON object.`, 'HOOK_TARGET_UNPARSEABLE')
  return value as Record<string, unknown>
}

/** Known value options consume opaque data, even when that value resembles another flag. */
function launchOptions(args: readonly string[]): Map<string, string | true> {
  const options = new Map<string, string | true>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') break
    const at = arg.indexOf('=')
    const name = at < 0 ? arg : arg.slice(0, at)
    if (!name.startsWith('-')) continue
    if (at >= 0) options.set(name, arg.slice(at + 1))
    else if (claudeLaunchValueOptions.has(name)) {
      const value = args[++index]
      if (value === undefined) throw new AgentMuxError(`Claude ${name} has no value.`, 'HOOK_TARGET_UNPARSEABLE')
      options.set(name, value)
    } else options.set(name, true)
  }
  return options
}

function launchSettings(context: AgentProviderHookActivationContext, options: ReadonlyMap<string, string | true>): Source | undefined {
  const value = options.get('--settings')
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new AgentMuxError('Claude --settings has no value.', 'HOOK_TARGET_UNPARSEABLE')
  return { name: '--settings', read: async () => {
    if (value.trimStart().startsWith('{')) return parse(value, '--settings')
    const path = isAbsolute(value) ? value : resolve(context.workspacePath, value)
    const settings = await settingsFile(path, context.signal)
    if (!settings) throw new AgentMuxError('Claude --settings file is unavailable.', 'HOOK_TARGET_UNPARSEABLE')
    return settings
  } }
}

/**
 * Whether Claude will run the Hooks AgentMux's plugin carries for this launch. Claude's settings
 * sources are read in its own precedence; the first that sets disableAllHooks decides, and managed
 * settings that allow only managed Hooks exclude the plugin. A missing source is skipped; one that
 * cannot be read is an error, never reported as active.
 */
export async function inspectClaudeHookActivation(context: AgentProviderHookActivationContext): Promise<AgentProviderHookActivation> {
  context.signal.throwIfAborted()
  const env = { ...process.env, ...context.env }
  const options = launchOptions(context.args)
  if (options.has('--safe-mode') || ['1', 'true'].includes(env.CLAUDE_CODE_SAFE_MODE ?? '')) return DISABLED
  const selected = options.get('--setting-sources')
  if (selected === true) throw new AgentMuxError('Claude --setting-sources has no value.', 'HOOK_TARGET_UNPARSEABLE')
  const sourcesToRead = selected === undefined ? ['user', 'project', 'local'] : selected.split(',').map(value => value.trim()).filter(Boolean)
  if (sourcesToRead.some(value => !['user', 'project', 'local'].includes(value))) {
    throw new AgentMuxError('Claude setting sources are not recognized.', 'HOOK_TARGET_UNPARSEABLE')
  }
  const userRoot = executionPath(executionEnvironmentValue(context.env, 'CLAUDE_CONFIG_DIR')?.trim() ||
    join(executionHomeDirectory(context.env), '.claude'), context.workspacePath)
  const sources: Source[] = [
    { name: 'managed settings', read: () => settingsFile(MANAGED_SETTINGS, context.signal) },
    ...[launchSettings(context, options)].filter((source): source is Source => source !== undefined),
    ...(sourcesToRead.includes('local') ? [{ name: 'local project settings', read: () => settingsFile(join(context.workspacePath, '.claude', 'settings.local.json'), context.signal) }] : []),
    ...(sourcesToRead.includes('project') ? [{ name: 'project settings', read: () => settingsFile(join(context.workspacePath, '.claude', 'settings.json'), context.signal) }] : []),
    ...(sourcesToRead.includes('user') ? [{ name: 'user settings', read: () => settingsFile(join(userRoot, 'settings.json'), context.signal) }] : [])
  ]
  for (const [index, source] of sources.entries()) {
    const settings = await source.read()
    if (!settings) continue
    if (index === 0 && (settings.allowManagedHooksOnly === true || settings.disableSideloadFlags === true)) return DISABLED
    if (!Object.hasOwn(settings, 'disableAllHooks')) continue
    if (typeof settings.disableAllHooks !== 'boolean') {
      throw new AgentMuxError(`Claude ${source.name} disableAllHooks is not a boolean.`, 'HOOK_TARGET_UNPARSEABLE')
    }
    return settings.disableAllHooks ? DISABLED : { active: true, code: 'MANAGED_HOOK_CURRENT', action: null }
  }
  return { active: true, code: 'MANAGED_HOOK_CURRENT', action: null }
}

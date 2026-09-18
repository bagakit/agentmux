import type { AgentMuxControlSettingsGetRequest, AgentMuxControlSettingsSetRequest } from './control.js'
import { AgentMuxError } from './errors.js'

type SettingsCommand =
  | Omit<AgentMuxControlSettingsGetRequest, 'schemaVersion' | 'requestId'>
  | Omit<AgentMuxControlSettingsSetRequest, 'schemaVersion' | 'requestId'>

/** Positional scalar values are data, including literal --help and empty strings. */
export function parseSettingsCommand(args: readonly string[]): SettingsCommand {
  if (args[0] === 'get' && args.length <= 2) {
    const target = args[1]
    if (target?.startsWith('-')) throw invalid('settings get accepts a target, not options.')
    return { operation: 'settings.get', ...(target === undefined ? {} : { target }) }
  }
  if (args[0] === 'set' && args.length === 3) {
    const key = args[1]!
    if (!key.trim() || key.startsWith('-')) throw invalid('A setting key is required.')
    return { operation: 'settings.set', key, value: args[2]! }
  }
  throw invalid('Usage: agentmux settings get [target] | settings set <key> <value>.')
}

function invalid(message: string): AgentMuxError {
  return new AgentMuxError(message, 'INVALID_CLI_ARGUMENT')
}

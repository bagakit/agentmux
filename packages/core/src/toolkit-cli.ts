import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { isAbsolute } from 'node:path'
import { parseToolkitPackageFields } from './toolkit.js'

export interface ToolkitCliCommand { method: string; params: Record<string, unknown> }
const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }

/** JSON is only a carrier here; the Toolkit owner validates definitions/admission. */
export async function parseToolkitCommand(args: readonly string[]): Promise<ToolkitCliCommand> {
  const [action, toolId] = args
  if (action === 'ls' && args.length === 1) return { method: 'toolkit.ls', params: {} }
  if (!toolId?.length) invalid('An exact Toolkit ID is required.')
  if (action === 'install') {
    const flags = new Map<string, string>()
    for (let index = 2; index < args.length; index++) {
      const argument = args[index]!, separator = argument.indexOf('=')
      const key = separator < 0 ? argument : argument.slice(0, separator)
      if (!['--path', '--cwd'].includes(key) || flags.has(key)) invalid('Use one --path and an optional --cwd for Toolkit install.')
      const value = separator < 0 ? args[++index] : argument.slice(separator + 1)
      if (!value || !isAbsolute(value)) invalid(`${key} requires an absolute Host path.`)
      flags.set(key, value!)
    }
    if (!flags.has('--path')) invalid('Toolkit install requires --path <absolute directory>.')
    const value = { kind: 'package' as const, packagePath: flags.get('--path')!, enabled: true,
      statusBar: 'icon' as const, args: [], ...(flags.has('--cwd') ? { workspacePath: flags.get('--cwd')! } : {}) }
    parseToolkitPackageFields(value, false, 'INVALID_CLI_ARGUMENT', true)
    return { method: 'toolkit.create', params: { toolId, value } }
  }
  if ((action === 'watch' || toolId === 'performance' && action === 'inspect') && args.length > 2) {
    const flags = args.slice(2), allowed = action === 'watch'
      ? ['--evaluate', ...(toolId === 'performance' ? ['--capture-failure', '--failure-evidence'] : [])] : ['--failure-evidence']
    if (new Set(flags).size !== flags.length || flags.some(flag => !allowed.includes(flag))) invalid('Use distinct Toolkit evaluation or supported Performance capture/read flags.')
    return { method: `toolkit.${action}`, params: { toolId,
      ...(flags.includes('--evaluate') ? { evaluateOnDisplay: true } : {}),
      ...(flags.includes('--capture-failure') ? { captureFailure: true } : {}),
      ...(flags.includes('--failure-evidence') ? { includeFailureEvidence: true } : {}) } }
  }
  const method = `toolkit.${action}`
  if (['inspect', 'script', 'watch', 'run', 'evaluate', 'stop', 'delete'].includes(action ?? '') && args.length === 2) return { method, params: { toolId } }
  if (action === 'action' && args.length === 5 && args[2]?.length && args[3] === '--input') {
    return { method, params: { toolId, actionId: args[2], input: await readControlJsonInput(args[4]!, 'Toolkit') } }
  }
  if (!['create', 'update', 'delete', 'run', 'evaluate', 'stop'].includes(action ?? '') || args.length !== 4 || args[2] !== '--input') invalid('Use an exact Toolkit action and --input <file|->.')
  const value = await readControlJsonInput(args[3]!, 'Toolkit')
  if (action === 'create') return { method, params: { toolId, value } }
  return { method, params: { toolId, input: value } }
}

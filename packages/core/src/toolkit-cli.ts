import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'

export interface ToolkitCliCommand { method: string; params: Record<string, unknown> }
const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }

/** JSON is only a carrier here; the Toolkit owner validates definitions/admission. */
export async function parseToolkitCommand(args: readonly string[]): Promise<ToolkitCliCommand> {
  const [action, toolId] = args
  if (action === 'ls' && args.length === 1) return { method: 'toolkit.ls', params: {} }
  if (!toolId?.length) invalid('An exact Toolkit ID is required.')
  const method = `toolkit.${action}`
  if (['inspect', 'script', 'watch', 'run', 'stop', 'delete'].includes(action ?? '') && args.length === 2) return { method, params: { toolId } }
  if (action === 'action' && args.length === 5 && args[2]?.length && args[3] === '--input') {
    return { method, params: { toolId, actionId: args[2], input: await readControlJsonInput(args[4]!, 'Toolkit') } }
  }
  if (!['create', 'update', 'delete', 'run', 'stop'].includes(action ?? '') || args.length !== 4 || args[2] !== '--input') invalid('Use an exact Toolkit action and --input <file|->.')
  const value = await readControlJsonInput(args[3]!, 'Toolkit')
  if (action === 'create') return { method, params: { toolId, value } }
  return { method, params: { toolId, input: value } }
}

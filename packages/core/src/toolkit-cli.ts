import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { settingsResourceEnvelope, settingsResourceRecord } from './settings-resource-json.js'
import { parseToolkitActionInput, parseToolkitRunInput, parseToolkitToolFields, type ToolkitRequest, type ToolkitToolFields } from './toolkit.js'

type WithoutEnvelope<T> = T extends ToolkitRequest ? Omit<T, 'schemaVersion' | 'requestId'> : never
export type ToolkitCommand = WithoutEnvelope<ToolkitRequest>
const invalid = (message: string) => new AgentMuxError(message, 'INVALID_CLI_ARGUMENT')
const input = (path: string) => readControlJsonInput(path, 'Toolkit')

/** IDs remain positional data; writes use the same resource envelope as Settings. */
export async function parseToolkitCommand(args: readonly string[]): Promise<ToolkitCommand> {
  const [verb, toolId] = args
  if (verb === 'list' && args.length === 1) return { operation: 'toolkit.list' }
  if (typeof toolId !== 'string' || !toolId.trim()) throw invalid('A tool ID is required. Run agentmux toolkit --help.')
  if ((verb === 'get' || verb === 'script' || verb === 'watch') && args.length === 2) return { operation: `toolkit.${verb}`, toolId }
  if ((verb === 'run' || verb === 'stop') && args.length === 2) return { operation: `toolkit.${verb}`, toolId }
  if (verb === 'action' && args.length === 5 && args[2]?.trim() && args[3] === '--input' && args[4]) {
    return { operation: 'toolkit.action', toolId, actionId: args[2], input: parseToolkitActionInput(await input(args[4]), 'INVALID_CLI_ARGUMENT') }
  }
  const hasInput = args.length === 4 && args[2] === '--input' && Boolean(args[3])
  if (verb === 'remove' && args.length === 2) return { operation: 'toolkit.remove', toolId }
  if (!hasInput || !['add', 'update', 'remove', 'run', 'stop'].includes(verb ?? '')) throw invalid('Run agentmux toolkit --help for tool operations.')
  const value = await input(args[3]!)
  if (verb === 'run') return { operation: 'toolkit.run', toolId, input: parseToolkitRunInput(value, 'INVALID_CLI_ARGUMENT') }
  if (verb === 'stop') {
    const envelope = settingsResourceEnvelope(value, ['executionId'], 'INVALID_CLI_ARGUMENT')
    if (!Object.hasOwn(envelope, 'executionId') || (envelope.executionId !== null && typeof envelope.executionId !== 'string')) throw invalid('Stop input requires an exact executionId, or null for no active execution.')
    return { operation: 'toolkit.stop', toolId, executionId: envelope.executionId as string | null }
  }
  if (verb === 'add') {
    const fields = settingsResourceRecord(value, 'INVALID_CLI_ARGUMENT')
    // These are explicit creation defaults, not persisted legacy-shape compatibility.
    const complete = { enabled: true, statusBar: 'icon', args: [], actions: [], ...fields }
    return { operation: 'toolkit.add', toolId, value: parseToolkitToolFields(complete, false, 'INVALID_CLI_ARGUMENT') as ToolkitToolFields }
  }
  const envelope = settingsResourceEnvelope(value, verb === 'update' ? ['changes', 'expected'] : ['expected'], 'INVALID_CLI_ARGUMENT')
  const expected = Object.hasOwn(envelope, 'expected') ? { expected: parseToolkitToolFields(envelope.expected, verb === 'update', 'INVALID_CLI_ARGUMENT') } : {}
  if (verb === 'remove') return { operation: 'toolkit.remove', toolId, ...expected } as ToolkitCommand
  const changes = parseToolkitToolFields(envelope.changes, true, 'INVALID_CLI_ARGUMENT')
  if (!Object.keys(changes).length) throw invalid('Tool changes must contain at least one field.')
  return { operation: 'toolkit.update', toolId, changes, ...expected }
}

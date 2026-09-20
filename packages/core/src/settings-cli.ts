import { createReadStream } from 'node:fs'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlSettingsGetRequest,
  type AgentMuxControlSettingsSetRequest, type AgentMuxControlSettingsResourceRequest,
  type AgentMuxControlSettingsBrowserLinksRequest, type AgentMuxControlSettingsWorkspaceAddRequest } from './control.js'
import { AgentMuxError } from './errors.js'
import { settingsResourceEnvelope, settingsResourceRecord } from './settings-resource-json.js'

type SettingsCommand =
  | Omit<AgentMuxControlSettingsGetRequest, 'schemaVersion' | 'requestId'>
  | Omit<AgentMuxControlSettingsSetRequest, 'schemaVersion' | 'requestId'>
  | ResourceCommand
  | WithoutEnvelope<AgentMuxControlSettingsBrowserLinksRequest>
  | Omit<AgentMuxControlSettingsWorkspaceAddRequest, 'schemaVersion' | 'requestId'>
type WithoutEnvelope<T> = T extends AgentMuxControlSettingsResourceRequest | AgentMuxControlSettingsBrowserLinksRequest ? Omit<T, 'schemaVersion' | 'requestId'> : never
type ResourceCommand = WithoutEnvelope<AgentMuxControlSettingsResourceRequest>

/** Positional scalar values are data, including literal --help and empty strings. */
export async function parseSettingsCommand(args: readonly string[]): Promise<SettingsCommand> {
  if (args[0] === 'executors' || args[0] === 'prompts') return resourceCommand(args)
  if (args[0] === 'browser') return browserLinksCommand(args)
  if (args[0] === 'workspaces') {
    if (args[1] !== 'add' || args.length !== 4 || args[2] !== '--input') {
      throw invalid('Workspace add requires --input <file|->. Run agentmux settings workspaces --help.')
    }
    return { operation: 'settings.workspaces.add', input: settingsResourceRecord(await input(args[3]!), 'INVALID_CLI_ARGUMENT') }
  }
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
  throw invalid('Run agentmux settings --help for supported commands.')
}

async function browserLinksCommand(args: readonly string[]): Promise<WithoutEnvelope<AgentMuxControlSettingsBrowserLinksRequest>> {
  if (args[1] === 'links' && args[2] === 'list' && args.length === 3) return { operation: 'settings.browser.links.list' }
  if (args[1] === 'links' && args[2] === 'forget') {
    // A single positional argument is always data, even --input, --help or an empty string.
    if (args.length === 4) return { operation: 'settings.browser.links.forget', scheme: args[3]! }
    if (args.length === 5 && args[3] === '--input') {
      const envelope = settingsResourceEnvelope(await input(args[4]!), ['scheme'], 'INVALID_CLI_ARGUMENT')
      if (!Object.hasOwn(envelope, 'scheme') || typeof envelope.scheme !== 'string') throw invalid('Browser link input requires exactly {"scheme": string}.')
      return { operation: 'settings.browser.links.forget', scheme: envelope.scheme }
    }
  }
  throw invalid('Run agentmux settings browser links --help for list and forget syntax.')
}

async function input(path: string): Promise<unknown> {
  const stream = path === '-' ? process.stdin : createReadStream(path)
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw invalid('Settings input exceeds the Control message budget.')
      chunks.push(buffer)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    throw invalid('Settings input must be a readable UTF-8 JSON file or stdin.')
  } finally { if (path !== '-') stream.destroy() }
}

async function resourceCommand(args: readonly string[]): Promise<ResourceCommand> {
  const resource = args[0] as 'executors' | 'prompts', action = args[1]
  if (action === 'list' && args.length === 2) return { operation: 'settings.resource.list', resource }
  const id = args[2]
  if (typeof id !== 'string' || !id.trim()) throw invalid('A resource ID is required.')
  if (action === 'get' && args.length === 3) return { operation: 'settings.resource.get', resource, id }
  const hasInput = args.length === 5 && args[3] === '--input'
  if (action === 'remove' && args.length === 3) return { operation: 'settings.resource.remove', resource, id }
  if (!hasInput || (action !== 'add' && action !== 'update' && action !== 'remove')) {
    throw invalid('Resource add/update require --input <file|->; remove accepts one optional input. Run settings executors --help.')
  }
  const value = await input(args[4]!)
  if (action === 'add') {
    const fields = settingsResourceRecord(value, 'INVALID_CLI_ARGUMENT')
    if (Object.hasOwn(fields, 'id')) throw invalid('Resource ID belongs in the positional argument, not the input object.')
    return { operation: 'settings.resource.add', resource, id, value: fields }
  }
  const envelope = settingsResourceEnvelope(value, action === 'update' ? ['changes', 'expected'] : ['expected'], 'INVALID_CLI_ARGUMENT')
  const expected = Object.hasOwn(envelope, 'expected')
    ? { expected: settingsResourceRecord(envelope.expected, 'INVALID_CLI_ARGUMENT') } : {}
  if (action === 'remove') return { operation: 'settings.resource.remove', resource, id, ...expected }
  const changes = settingsResourceRecord(envelope.changes, 'INVALID_CLI_ARGUMENT')
  if (Object.keys(changes).length === 0) throw invalid('Resource changes must contain at least one field.')
  return { operation: 'settings.resource.update', resource, id, changes, ...expected }
}

function invalid(message: string): AgentMuxError {
  return new AgentMuxError(message, 'INVALID_CLI_ARGUMENT')
}

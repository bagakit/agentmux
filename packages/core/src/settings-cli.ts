import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'

export interface SettingsCliCommand { method: string; params: Record<string, unknown> }
const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }
const input = (path: string) => readControlJsonInput(path, 'Settings')

/** Parse carriers only. Resource fields, CAS and save semantics belong to the service. */
export async function parseSettingsCommand(args: readonly string[]): Promise<SettingsCliCommand> {
  const [resource, action, id] = args
  if (resource === 'inspect' && args.length <= 2) {
    if (action?.startsWith('-')) invalid('settings inspect accepts a target, not options.')
    return { method: 'settings.inspect', params: action === undefined ? {} : { target: action } }
  }
  if (resource === 'set' && args.length === 3) {
    if (!action?.trim() || action.startsWith('-')) invalid('A setting key is required.')
    return { method: 'settings.set', params: { key: action, value: id } }
  }
  if (resource === 'executors' || resource === 'prompts') {
    const method = `settings.${resource}.${action}`
    if (action === 'ls' && args.length === 2) return { method, params: {} }
    if (resource === 'prompts' && action === 'inspect' && args.length === 4 && id === '--keyword') {
      if (!args[3]?.length) invalid('An exact Prompt keyword is required.')
      return { method, params: { keyword: args[3] } }
    }
    if (!id?.length) invalid('An exact resource ID is required.')
    if (resource === 'executors' && action === 'refresh' && args.length === 5 && args[3] === '--host' && args[4]?.length) {
      return { method, params: { executorId: id, hostId: args[4] } }
    }
    if (action === 'inspect' && args.length === 3) return { method, params: { id } }
    if (action === 'delete' && args.length === 3) return { method, params: { id } }
    if (!['create', 'update', 'delete'].includes(action ?? '') || args.length !== 5 || args[3] !== '--input') invalid('Use create/update/delete <id> --input <file|->.')
    const value = await input(args[4]!)
    if (action === 'create') return { method, params: { id, value } }
    return { method, params: { id, input: value } }
  }
  if (resource === 'hosts') {
    if (action === 'ls' && args.length === 2) return { method: 'settings.hosts.ls', params: {} }
    if (action === 'test' && args.length === 3 && id?.length) return { method: 'settings.hosts.test', params: { id } }
    if (action === 'test' && args.length === 4 && id === '--input') return { method: 'settings.hosts.test', params: { input: await input(args[3]!) } }
  }
  if (resource === 'workspaces' && action === 'register' && args.length === 4 && id === '--input') {
    return { method: 'settings.workspaces.register', params: { input: await input(args[3]!) } }
  }
  if (resource === 'browser-links') {
    if (action === 'ls' && args.length === 2) return { method: 'settings.browser-links.ls', params: {} }
    // A lone positional value is data, including an empty scheme or --help.
    if (action === 'forget' && args.length === 3) return { method: 'settings.browser-links.forget', params: { input: { scheme: id } } }
    if (action === 'forget' && args.length === 4 && id === '--input') return { method: 'settings.browser-links.forget', params: { input: await input(args[3]!) } }
  }
  return invalid('Unsupported settings command. Run agentmux settings --help.')
}

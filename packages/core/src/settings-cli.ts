import { parseSettingsHostMaintenanceCommand } from './settings-host-maintenance-cli.js'
import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'

const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }
const input = (path: string) => readControlJsonInput(path, 'Settings')

/** Parse carriers only. Resource fields, CAS and save semantics belong to the service. */
export async function parseSettingsCommand(args: readonly string[]): Promise<Record<string, unknown>> {
  const maintenance = await parseSettingsHostMaintenanceCommand(args)
  if (maintenance) return maintenance
  const [resource, action, id] = args
  if (resource === 'inspect' && args.length <= 2) {
    if (action?.startsWith('-')) invalid('settings inspect accepts a target, not options.')
    return action === undefined ? {} : { target: action }
  }
  if (resource === 'set' && (args.length === 3 || args.length === 5 && args[3] === '--operation-id')) {
    if (!action?.trim() || action.startsWith('-')) invalid('A setting key is required.')
    if (args.length === 5 && !args[4]?.trim()) invalid('The original operation ID is required.')
    return { key: action, value: id, ...(args.length === 5 ? { operationId: args[4] } : {}) }
  }
  if (resource === 'executors' || resource === 'prompts' || resource === 'themes' || resource === 'derived-actions') {
    if (resource === 'executors' && action === 'discover') {
      const options = new Map<string, string>()
      for (let index = 2; index < args.length; index += 2) {
        const flag = args[index]!, value = args[index + 1]
        if (value === undefined) return invalid('Use discover --host ID [--executor ID] [--refresh true|false].')
        if (!['--host','--executor','--refresh'].includes(flag) || !value.length || options.has(flag)) invalid('Use discover --host ID [--executor ID] [--refresh true|false].')
        options.set(flag, value)
      }
      if (!options.has('--host') || options.has('--refresh') && !['true','false'].includes(options.get('--refresh')!)) invalid('Use discover --host ID [--executor ID] [--refresh true|false].')
      return { hostId: options.get('--host')!, refresh: options.get('--refresh') !== 'false',
        ...(options.has('--executor') ? { executorId: options.get('--executor')! } : {}) }
    }
    if (resource === 'executors' && action === 'unregister' && args.length === 7 && id?.length && args[3] === '--host' && args[4]?.length && args[5] === '--registration-revision' && args[6]?.length) {
      return { executorId: id, hostId: args[4], expectedRegistrationRevision: args[6] }
    }
    if (resource === 'executors' && action === 'register' && args.length === 7 && id?.length && args[3] === '--host' && args[4]?.length && args[5] === '--input') {
      return { executorId: id, hostId: args[4], input: await input(args[6]!) }
    }
    if (action === 'ls' && args.length === 2) return {}
    if (resource === 'prompts' && action === 'inspect' && args.length === 4 && id === '--id') {
      if (!args[3]?.length) invalid('An exact Prompt ID is required.')
      return { id: args[3] }
    }
    if (resource === 'prompts' && action === 'inspect' && args.length === 4 && id === '--keyword') {
      if (!args[3]?.length) invalid('An exact Prompt keyword is required.')
      return { keyword: args[3] }
    }
    if (!(resource === 'themes' && action === 'delete' && typeof id === 'string') && !id?.length) invalid('An exact resource ID is required.')
    if (resource === 'executors' && action === 'refresh' && args.length === 5 && args[3] === '--host' && args[4]?.length) {
      return { executorId: id, hostId: args[4] }
    }
    if (action === 'inspect' && args.length === 3) return { id }
    if (resource !== 'themes' && action === 'delete' && args.length === 3) return { id }
    if (!['create', 'update', 'delete'].includes(action ?? '') || args.length !== 5 || args[3] !== '--input') invalid('Use create/update/delete <id> --input <file|->.')
    const value = await input(args[4]!)
    if (action === 'create') return { id, value }
    return { id, input: value }
  }
  if (resource === 'applications') {
    if (action === 'ls' && (args.length === 2 || args.length === 4 && id === '--host' && args[3]?.length)) return args.length === 2 ? {} : { hostId: args[3] }
    if (action === 'configure' && args.length === 5 && id?.length && args[3] === '--input') {
      const body = await input(args[4]!); if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Application configuration requires profile and expectedRevision.')
      if (Object.keys(body as object).some(key => !['profile','expectedRevision'].includes(key))) invalid('Application configuration accepts only profile and expectedRevision.')
      return { ...body as Record<string,unknown>, profileId: id }
    }
    if ((action === 'delete' || action === 'plan') && args.length === 5 && id?.length && args[3] === '--revision' && args[4]?.length) return { profileId: id, expectedRevision: args[4] }
    if (action === 'apply' && args.length === 7 && id?.length && args[3] === '--plan' && args[4]?.length && args[5] === '--operation-id' && args[6]?.length) return { profileId: id, planId: args[4], operationId: args[6] }
    if (action === 'operation' && args.length === 3 && id?.length) return { operationId: id }
    return invalid('Use settings applications --help for exact configuration, plan, apply and original operation query commands.')
  }
  if (resource === 'hosts') {
    if (action === 'create' && args.length === 5 && id?.length && args[3] === '--input') return { id, value: await input(args[4]!) }
    if (action === 'delete' && args.length === 5 && id?.length && args[3] === '--input') {
      const body = await input(args[4]!)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'expected')) invalid('Host delete input requires the complete expected Host record.')
      return { ...body as Record<string, unknown>, id }
    }
    if ((action === 'update' || action === 'configure') && args.length === 5 && id?.length && args[3] === '--input') {
      const body = await input(args[4]!)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expected', 'candidate'].includes(key))) invalid('Host update input requires complete expected and candidate Host records.')
      return { ...body as Record<string, unknown>, id }
    }
    if (action === 'agent-resources') {
      const result: Record<string, unknown> = {}, seen = new Set<string>()
      for (let i = 2; i < args.length; i += 2) {
        const flag = args[i]!, value = args[i + 1]
        if (!['--host', '--kind', '--expected-runtime'].includes(flag) || seen.has(flag) || !value?.length) invalid('Agent resources accepts one exact --host, --kind records|running and optional --expected-runtime.')
        seen.add(flag); result[flag === '--host' ? 'hostId' : flag === '--kind' ? 'kind' : 'expectedRuntimeId'] = value
      }
      if (typeof result.hostId !== 'string' || result.kind !== 'records' && result.kind !== 'running') invalid('Choose one exact --host and --kind records|running.')
      return result
    }
    if ((action === 'inspect' || action === 'network' || action === 'home') && args.length === 4 && id === '--host' && args[3]?.length) {
      return { hostId: args[3] }
    }
    if ((action === 'trusted-sources' || action === 'message-trusted-sources') && args.length === 4 && id === '--host' && args[3]?.length) {
      return { hostId: args[3] }
    }
    if ((action === 'trust-source' || action === 'trust-message-source') && args.length === 6 && id === '--host' && args[3]?.length && args[4] === '--input') {
      return { hostId: args[3], input: await input(args[5]!) }
    }
    if (action === 'tailcat-key') {
      const flags = new Map<string, string>()
      for (let index = 2; index < args.length; index += 2) {
        const [name, value] = [args[index]!, args[index + 1]]
        if (!['--role', '--key'].includes(name) || !value?.length || flags.has(name)) invalid('Use settings hosts tailcat-key --role <server|client> [--key <name>].')
        flags.set(name, value!)
      }
      if (!flags.has('--role')) invalid('Choose --role server on the receiving Mac or --role client on the connecting Mac.')
      return { role: flags.get('--role'), ...(flags.has('--key') ? { key: flags.get('--key') } : {}) }
    }
    if (action === 'ls' && args.length === 2) return {}
    if (action === 'test' && args.length === 3 && id?.length) return { id }
    if (action === 'test' && args.length === 4 && id === '--input') return { input: await input(args[3]!) }
    if (action === 'install-check' && args.length === 3 && id?.length) return { id }
    if (action === 'install' && args.length === 5 && id?.length && args[3] === '--input') {
      const body = await input(args[4]!)
      if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Install input requires expected and operationId.')
      return { ...body as Record<string, unknown>, id }
    }
    if (action === 'install-inspect' && args.length === 5 && id?.length && args[3] === '--operation-id' && args[4]?.length) return { id, operationId: args[4] }
    if (action === 'upgrade-check' && args.length === 3 && id?.length) return { id }
    if (action === 'upgrade-check' && args.length === 4 && id === '--input') return { input: await input(args[3]!) }
    if (action === 'upgrade' && args.length === 5 && id?.length && args[3] === '--input') {
      const body = await input(args[4]!)
      if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Upgrade input requires expected and operationId.')
      return { ...body as Record<string, unknown>, id }
    }
    if ((action === 'upgrade-inspect' || action === 'upgrade-reconnect') && args.length === 5 && id?.length && args[3] === '--operation-id' && args[4]?.length) {
      return { id, operationId: args[4] }
    }
  }
  if (resource === 'workspaces' && action === 'register' && args.length === 4 && id === '--input') {
    return { input: await input(args[3]!) }
  }
  if (resource === 'browser-links') {
    if (action === 'ls' && args.length === 2) return {}
    // A lone positional value is data, including an empty scheme or --help.
    if (action === 'forget' && args.length === 3) return { input: { scheme: id } }
    if (action === 'forget' && args.length === 4 && id === '--input') return { input: await input(args[3]!) }
  }
  return invalid('Unsupported settings command. Run amux settings --help.')
}

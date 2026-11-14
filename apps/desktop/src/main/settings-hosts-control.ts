import type { AgentMuxControlSettingsHostsRequest, AgentMuxControlSettingsHostsResult, AgentMuxControlSettingsResourceFields } from '@agentmux/core'
import type { HostCheckResult, HostConfig } from '../shared/contracts.js'
import { hostSchema } from './config-store.js'
import { configValuesEqual } from '../shared/config-edit.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'
import type { SettingsHostsInstallOwner } from './settings-hosts-install.js'
import type { SettingsHostsUpgradeOwner } from './settings-hosts-upgrade.js'

/** IPC and public Control share this explicit diagnostic; no configuration transaction is held. */
export async function checkSettingsHost(input: unknown, runtime: Pick<RuntimeController, 'checkHost'>): Promise<HostCheckResult> {
  const parsed = hostSchema.safeParse(input)
  if (!parsed.success) throw Object.assign(new Error('Host Test requires a complete valid Host configuration.'), { code: 'INVALID_SETTING_VALUE' })
  const captured = parsed.data as HostConfig
  try {
    const result = await runtime.checkHost(captured)
    return { input: captured, outcome: 'ready', detail: result.detail }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return { input: captured, outcome: code === 'REMOTE_UNSUPPORTED' ? 'unsupported' : 'check-failed',
      detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function executeSettingsHostsControl(
  request: AgentMuxControlSettingsHostsRequest,
  owner: ConfigOwner,
  runtime: Pick<RuntimeController, 'checkHost'>,
  upgrades?: SettingsHostsUpgradeOwner,
  installs?: SettingsHostsInstallOwner
): Promise<AgentMuxControlSettingsHostsResult> {
  if (request.operation === 'settings.hosts.list') {
    return { operation: request.operation, hosts: structuredClone(owner.current.hosts) as AgentMuxControlSettingsResourceFields[] }
  }
  if (request.operation === 'settings.hosts.create' || request.operation === 'settings.hosts.configure' || request.operation === 'settings.hosts.delete') {
    const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
    const read = (value: unknown): HostConfig => {
      const parsed = hostSchema.safeParse(value)
      if (!parsed.success || parsed.data.id !== request.id) return fail('INVALID_SETTING_VALUE', 'A complete valid Host record with the exact requested ID is required.')
      return parsed.data as HostConfig
    }
    const candidate = request.operation === 'settings.hosts.create' ? read(request.value)
      : request.operation === 'settings.hosts.configure' ? read(request.candidate) : undefined
    const expected = request.operation === 'settings.hosts.create' ? undefined : read(request.expected)
    if (request.operation === 'settings.hosts.create' && (candidate?.kind !== 'ssh' || request.id === 'local' || candidate.runtimeId !== undefined)) {
      fail('SETTING_IDENTITY_IMMUTABLE', 'Register a new SSH Host without a Runtime binding. Only the authenticated connection learns that identity.')
    }
    const saved = await owner.update(current => {
      const actual = current.hosts.find(host => host.id === request.id)
      if (request.operation === 'settings.hosts.create') {
        if (actual) return fail('SETTING_RESOURCE_EXISTS', 'This Host ID already exists. Read hosts ls before choosing an explicit edit.')
        return { ...current, hosts: [...current.hosts, candidate!] }
      }
      if (!actual) return fail('SETTING_RESOURCE_NOT_FOUND', 'This Host is not registered; configuration changes never create an identity.')
      if (!configValuesEqual(actual, expected)) return fail('CONFIG_CONFLICT', 'The Host changed. Read hosts ls and review the original draft before another explicit edit.')
      if (request.operation === 'settings.hosts.delete') {
        if (actual.kind === 'local') return fail('SETTING_IDENTITY_IMMUTABLE', 'The original local Host cannot be removed.')
        const references = current.workspaces.filter(workspace => workspace.hostId === request.id)
        if (references.length) return fail('SETTING_RESOURCE_IN_USE', 'Host is referenced by Workspaces: ' + references.map(workspace => workspace.id).join(', ') + '. Their original work was retained.')
        // Runtime preparation checks original durable Sessions and Runs before removing its route.
        return { ...current, hosts: current.hosts.filter(host => host.id !== request.id) }
      }
      if (candidate!.kind !== actual.kind || (actual.kind === 'ssh' && candidate!.kind === 'ssh' && candidate!.runtimeId !== actual.runtimeId) ||
          (actual.kind === 'local' && candidate!.kind === 'local' && !configValuesEqual(candidate!.tailcat, actual.tailcat))) {
        return fail('SETTING_IDENTITY_IMMUTABLE', 'Keep the original Host type, Runtime binding and local ingress authorization. Use their explicit original owners for sensitive changes.')
      }
      return { ...current, hosts: current.hosts.map(host => host.id === request.id ? candidate! : host) }
    })
    return request.operation === 'settings.hosts.delete'
      ? { operation: request.operation, id: request.id, removed: true }
      : { operation: request.operation, host: structuredClone(saved.hosts.find(host => host.id === request.id)!) as AgentMuxControlSettingsResourceFields }
  }
  if (request.operation === 'settings.hosts.update') {
    const expected = hostSchema.safeParse(request.expected), candidate = hostSchema.safeParse(request.candidate)
    if (!expected.success || !candidate.success || expected.data.id !== request.id || candidate.data.id !== request.id ||
      expected.data.kind !== 'ssh' || candidate.data.kind !== 'ssh' || !expected.data.runtimeId || candidate.data.runtimeId !== expected.data.runtimeId) {
      throw Object.assign(new Error('Route repair requires complete expected and candidate records of the same bound SSH Host.'), { code: 'INVALID_SETTING_VALUE' })
    }
    const saved = await owner.update(current => {
      const actual = current.hosts.find(host => host.id === request.id)
      if (configValuesEqual(actual, candidate.data)) return current
      if (!configValuesEqual(actual, expected.data)) throw Object.assign(new Error('The Host changed; read its current configuration before another explicit update.'), { code: 'CONFIG_CONFLICT' })
      return { ...current, hosts: current.hosts.map(host => host.id === request.id ? candidate.data as HostConfig : host) }
    })
    return { operation: request.operation, host: structuredClone(saved.hosts.find(host => host.id === request.id)!) as AgentMuxControlSettingsResourceFields }
  }
  const input = request.id !== undefined ? owner.current.hosts.find(host => host.id === request.id) : 'input' in request ? request.input : undefined
  if (input === undefined) throw Object.assign(new Error(`Host not found: ${request.id}`), { code: 'SETTING_RESOURCE_NOT_FOUND' })
  if (request.operation === 'settings.hosts.install-check' || request.operation === 'settings.hosts.install' || request.operation === 'settings.hosts.install-inspect') {
    if (!installs) throw Object.assign(new Error('The original service has no first Core install owner.'), { code: 'CONTROL_UNAVAILABLE' })
    if (request.operation === 'settings.hosts.install-check') return { operation: request.operation, check: await installs.check(input) }
    if (request.operation === 'settings.hosts.install') return { operation: request.operation, receipt: await installs.install(input, request.expected, request.requestId) }
    return { operation: request.operation, receipt: await installs.inspect(input, request.requestId) }
  }
  if (request.operation === 'settings.hosts.upgrade-check' || request.operation === 'settings.hosts.upgrade' || request.operation === 'settings.hosts.upgrade-inspect' || request.operation === 'settings.hosts.upgrade-reconnect') {
    if (!upgrades) throw Object.assign(new Error('The original service has no Core maintenance owner.'), { code: 'CONTROL_UNAVAILABLE' })
    if (request.operation === 'settings.hosts.upgrade-check') return { operation: request.operation, check: await upgrades.check(input) }
    if (request.operation === 'settings.hosts.upgrade') return { operation: request.operation, receipt: await upgrades.upgrade(input, request.expected, request.requestId) }
    if (request.operation === 'settings.hosts.upgrade-inspect') return { operation: request.operation, receipt: await upgrades.inspect(input, request.requestId) }
    if (request.operation === 'settings.hosts.upgrade-reconnect') return { operation: request.operation, receipt: await upgrades.reconnect(input, request.requestId) }
  }
  const result = await checkSettingsHost(input, runtime)
  return { operation: request.operation, ...result, input: structuredClone(result.input) as AgentMuxControlSettingsResourceFields }
}

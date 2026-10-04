import type { AgentMuxControlSettingsHostsRequest, AgentMuxControlSettingsHostsResult, AgentMuxControlSettingsResourceFields } from '@agentmux/core'
import type { HostCheckResult, HostConfig } from '../shared/contracts.js'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'
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
  upgrades?: SettingsHostsUpgradeOwner
): Promise<AgentMuxControlSettingsHostsResult> {
  if (request.operation === 'settings.hosts.list') {
    return { operation: request.operation, hosts: structuredClone(owner.current.hosts) as AgentMuxControlSettingsResourceFields[] }
  }
  const input = request.id !== undefined ? owner.current.hosts.find(host => host.id === request.id) : 'input' in request ? request.input : undefined
  if (input === undefined) throw Object.assign(new Error(`Host not found: ${request.id}`), { code: 'SETTING_RESOURCE_NOT_FOUND' })
  if (request.operation === 'settings.hosts.upgrade-check' || request.operation === 'settings.hosts.upgrade' || request.operation === 'settings.hosts.upgrade-inspect') {
    if (!upgrades) throw Object.assign(new Error('The original service has no Core maintenance owner.'), { code: 'CONTROL_UNAVAILABLE' })
    if (request.operation === 'settings.hosts.upgrade-check') return { operation: request.operation, check: await upgrades.check(input) }
    if (request.operation === 'settings.hosts.upgrade') return { operation: request.operation, receipt: await upgrades.upgrade(input, request.expected, request.requestId) }
    if (request.operation === 'settings.hosts.upgrade-inspect') return { operation: request.operation, receipt: await upgrades.inspect(input, request.requestId) }
  }
  const result = await checkSettingsHost(input, runtime)
  return { operation: request.operation, ...result, input: structuredClone(result.input) as AgentMuxControlSettingsResourceFields }
}

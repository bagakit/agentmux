import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { ConfigOwner } from './config-owner.js'
import { scalarSettings as settings } from './settings/setting-catalog.js'

function unsupported(key: string): Error {
  return Object.assign(new Error(`Unsupported setting: ${key}. Run agentmux settings get to see the currently supported settings.`), { code: 'UNSUPPORTED_SETTING' })
}

export async function executeSettingsControl(
  request: Extract<AgentMuxControlRequest, { operation: 'settings.get' | 'settings.set' }>,
  owner: ConfigOwner
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.get' | 'settings.set' }>> {
  if (request.operation === 'settings.get') {
    const selected = request.target === undefined || request.target === '' ? settings :
      request.target === 'appearance' || request.target === 'notifications' || request.target === 'browser' || request.target === 'browser.toolbar'
      ? settings.filter((setting) => setting.key.startsWith(`${request.target}.`))
      : settings.filter((setting) => setting.key === request.target)
    if (!selected.length) throw unsupported(request.target ?? '')
    return { operation: request.operation, entries: selected.map((setting) => setting.entry(owner.current)), partial: true as const }
  }
  const setting = settings.find((candidate) => candidate.key === request.key)
  if (!setting) throw unsupported(request.key)
  const saved = await owner.update((current) => setting.apply(current, request.value))
  return { operation: request.operation, entry: setting.entry(saved) }
}

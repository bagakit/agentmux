import { defaultNotesDirectory } from '@agentmux/core/notebook-store'
import type { NotesStorageOwner } from './notes-storage-owner.js'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { ConfigOwner } from './config-owner.js'
import { scalarSettings as settings } from './settings/setting-catalog.js'

function unsupported(key: string): Error {
  return Object.assign(new Error(`Unsupported setting: ${key}. Run agentmux settings inspect to see the currently supported settings.`), { code: 'UNSUPPORTED_SETTING' })
}

export async function executeSettingsControl(
  request: Extract<AgentMuxControlRequest, { operation: 'settings.get' | 'settings.set' }>,
  owner: ConfigOwner,
  notes?: Pick<NotesStorageOwner, 'inspect' | 'change'>
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.get' | 'settings.set' }>> {
  if (request.operation === 'settings.get') {
    const directory = notes && (request.target === undefined || request.target === '' || request.target === 'notes' || request.target === 'notes.directory') ? { key: 'notes.directory', kind: 'string' as const, value: (await notes.inspect()).directory, default: defaultNotesDirectory() } : null
    if (request.target === 'notes.directory' && directory) return { operation: request.operation, entries: [directory], partial: true }
    const selected = request.target === undefined || request.target === '' ? settings :
      request.target === 'profile' || request.target === 'focus' || request.target === 'notes' || request.target === 'goals' || request.target === 'goalsCommonActions' || request.target === 'appearance' || request.target === 'notifications' || request.target === 'browser' || request.target === 'browser.toolbar' || request.target === 'toolkit' || request.target === 'toolkit.performance'
      ? settings.filter((setting) => setting.key.startsWith(`${request.target}.`))
      : settings.filter((setting) => setting.key === request.target)
    if (!selected.length) throw unsupported(request.target ?? '')
    return { operation: request.operation, entries: [...selected.map((setting) => setting.entry(owner.current)), ...(directory ? [directory] : [])], partial: true as const }
  }
  if (request.key === 'notes.directory' && notes) { const current = await notes.inspect(request.requestId); const saved = await notes.change({ operationId: request.requestId, expectedDirectory: current.operation?.expectedDirectory ?? current.directory, directory: request.value }); return { operation: request.operation, requestId: request.requestId, entry: { key: request.key, kind: 'string', value: saved.directory, default: defaultNotesDirectory() } } }
  const setting = settings.find((candidate) => candidate.key === request.key)
  if (!setting) throw unsupported(request.key)
  const saved = await owner.update((current) => setting.apply(current, request.value))
  return { operation: request.operation, entry: setting.entry(saved) }
}

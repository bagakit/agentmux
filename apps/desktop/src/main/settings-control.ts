import type { NotesStorageOwner } from './notes-storage-owner.js'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { ConfigOwner } from './config-owner.js'
import { scalarSettings, ownedSettings } from './settings/setting-catalog.js'

function unsupported(key: string): Error {
  return Object.assign(new Error(`Unsupported setting: ${key}. Run amux settings inspect to see the currently supported settings.`), { code: 'UNSUPPORTED_SETTING' })
}

export async function executeSettingsControl(
  request: Extract<AgentMuxControlRequest, { operation: 'settings.get' | 'settings.set' }>,
  owner: ConfigOwner,
  notes?: Pick<NotesStorageOwner, 'inspect' | 'change'>
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.get' | 'settings.set' }>> {
  const owned = ownedSettings(notes)
  if (request.operation === 'settings.get') {
    const snapshot = owner.current, settings = scalarSettings(snapshot)
    const matches = (setting: { key: string }) => !request.target || setting.key === request.target || setting.key.startsWith(`${request.target}.`)
    const selected = settings.filter(matches), selectedOwned = owned.filter(matches)
    if (!selected.length && !selectedOwned.length) throw unsupported(request.target ?? '')
    const entries = selected.map((setting) => setting.entry(snapshot))
    const issues: { key: string; code: string; message: string }[] = []
    for (const setting of selectedOwned) {
      try { entries.push(await setting.inspect()) }
      catch (cause) {
        // Asked by exact key, preserve that owner's original failure.
        if (request.target === setting.key) throw cause
        const code = typeof (cause as { code?: unknown })?.code === 'string' ? (cause as { code: string }).code : setting.unavailableCode
        const message = `${cause instanceof Error ? cause.message : String(cause)} The other settings were read; run amux settings inspect ${setting.key} to read it again.`
        issues.push({ key: setting.key, code, message })
      }
    }
    return { operation: request.operation, entries, partial: true, ...(issues.length ? { issues } : {}) }
  }
  const ownedSetting = owned.find(candidate => candidate.key === request.key)
  if (ownedSetting) return { operation: request.operation, requestId: request.requestId, entry: await ownedSetting.apply(request.value, request.requestId) }
  const saved = await owner.update(current => {
    const settings = scalarSettings(current), setting = settings.find(candidate => candidate.key === request.key)
    if (!setting) throw unsupported(request.key)
    return setting.apply(current, request.value)
  })
  const settings = scalarSettings(saved), setting = settings.find(candidate => candidate.key === request.key)!
  return { operation: request.operation, entry: setting.entry(saved) }
}

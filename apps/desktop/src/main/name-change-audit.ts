import type { AgentMuxNameContext, AgentMuxNameTarget } from '@agentmux/core/control'
import type { AppConfig } from '../shared/contracts.js'
import { unknownNameContext } from '../../../host/src/name-change-audit.js'
export { NameChangeAudit, nameChangeRequests, unknownNameContext, type NameChangeRecordPort, type NamedChange } from '../../../host/src/name-change-audit.js'

export function desktopNameContext(entryPoint: string, sender: unknown, expected: unknown,
  windowId: number): AgentMuxNameContext {
  if (!Object.is(sender, expected)) return unknownNameContext(entryPoint)
  const webContentsId = (sender as { id?: number }).id
  const uid = process.getuid?.()
  return { actor: uid === undefined ? { kind: 'unknown', id: null, verified: false }
    : { kind: 'device', id: `local-user:${uid}`, verified: true },
    source: 'desktop-ui', entryPoint, transport: 'electron-ipc',
    location: { windowId: String(windowId), webContentsId: webContentsId === undefined ? null : String(webContentsId) } }
}

// Package names belong to their manifests, not the configuration's editable labels.
function namedToolkitTools(config: AppConfig) {
  return (config.toolkit?.tools ?? []).filter(tool => 'name' in tool)
}

/** Only existing objects can be renamed. Registration/deletion is not fabricated rename history. */
export function configNameChanges(before: AppConfig, after: AppConfig): NamedChange[] {
  const changes: NamedChange[] = []
  const compare = (kind: string, old: Record<string, string>, next: Record<string, string>): void => {
    for (const [id, value] of Object.entries(old)) {
      if (Object.hasOwn(next, id) && next[id] !== value) changes.push({ target: { kind, id }, before: value, requested: next[id]! })
    }
  }
  compare('executor', Object.fromEntries(Object.entries(before.executors).map(([id, value]) => [id, value.label])),
    Object.fromEntries(Object.entries(after.executors).map(([id, value]) => [id, value.label])))
  compare('prompt', Object.fromEntries((before.composerShortcuts ?? []).map(value => [value.id, value.label])),
    Object.fromEntries((after.composerShortcuts ?? []).map(value => [value.id, value.label])))
  compare('host', Object.fromEntries(before.hosts.map(value => [value.id, value.label])),
    Object.fromEntries(after.hosts.map(value => [value.id, value.label])))
  compare('workspace', Object.fromEntries(before.workspaces.map(value => [value.id, value.name])),
    Object.fromEntries(after.workspaces.map(value => [value.id, value.name])))
  compare('toolkit', Object.fromEntries(namedToolkitTools(before).map(value => [value.id, value.name])),
    Object.fromEntries(namedToolkitTools(after).map(value => [value.id, value.name])))
  const actions = (config: AppConfig): Record<string, string> => Object.fromEntries(namedToolkitTools(config)
    .flatMap(tool => (tool.actions ?? []).map(action => [JSON.stringify([tool.id, action.id]), action.label])))
  compare('toolkit-action', actions(before), actions(after))
  return changes
}

/** Read back the original owner value; normalization can differ from the request. */
export function configNameValue(config: AppConfig, target: AgentMuxNameTarget): string | null {
  switch (target.kind) {
    case 'executor': return config.executors[target.id]?.label ?? null
    case 'prompt': return config.composerShortcuts?.find(item => item.id === target.id)?.label ?? null
    case 'host': return config.hosts.find(item => item.id === target.id)?.label ?? null
    case 'workspace': return config.workspaces.find(item => item.id === target.id)?.name ?? null
    case 'toolkit': return namedToolkitTools(config).find(item => item.id === target.id)?.name ?? null
    case 'toolkit-action': return namedToolkitTools(config).flatMap(tool => (tool.actions ?? []).map(action => ({
      id: JSON.stringify([tool.id, action.id]), label: action.label }))).find(item => item.id === target.id)?.label ?? null
    default: return null
  }
}

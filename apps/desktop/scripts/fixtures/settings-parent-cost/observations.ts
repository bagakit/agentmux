import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, vi } from 'vitest'

export const mode = process.env.AGENTMUX_SETTINGS_PARENT_MUTANT ?? 'baseline'
const evidence = resolve(process.env.AGENTMUX_SETTINGS_PARENT_EVIDENCE ?? '.bagakit/design/settings-followups-20261004/parent-cost-evidence/direct')
export type Observation = { sequence: number; window: string; kind: string; id: string; facts?: Record<string, unknown> }

export function observations() {
  const events: Observation[] = []
  let window = 'mount', functionSequence = 0
  const functionIds = new WeakMap<Function, number>()
  vi.stubGlobal('__settingsParentRecord', (kind: string, id: string, facts?: Record<string, unknown>) => {
    const value = { ...facts }
    if (typeof value.onClose === 'function') {
      if (!functionIds.has(value.onClose)) functionIds.set(value.onClose, ++functionSequence)
      value.onCloseIdentity = functionIds.get(value.onClose)
      delete value.onClose
    }
    events.push({ sequence: events.length + 1, window, kind, id, facts: value })
  })
  vi.stubGlobal('__settingsParentVisit', (hostId: string) => events.push({ sequence: events.length + 1,
    window, kind: 'predicate', id: hostId }))
  return {
    events,
    setWindow: (name: string) => { window = name },
    notify: () => events.push({ sequence: events.length + 1, window, kind: 'notify', id: 'store' }),
    summary: (name: string) => {
      const collected = events.filter(event => event.window === name)
      const count = (kind: string, id?: string) => collected.filter(event => event.kind === kind && (!id || event.id === id)).length
      return { notifications: count('notify'), appRenders: count('render', 'DesktopApp'),
        settingsRenders: count('render', 'SettingsPanel'), settingsSubtreeCommits: count('commit', 'SettingsPanel'),
        hostRenders: count('render', 'HostSettingsPane'), hostCommits: count('commit', 'HostSettingsPane'),
        hostFieldRenders: count('render', 'HostConnectionFields'), hostSessionPredicateVisits: count('predicate'),
        onCloseIdentities: collected.filter(event => event.kind === 'caller' && event.id === 'SettingsPanel').map(event => event.facts!.onCloseIdentity),
        surfaceCloseIdentities: collected.filter(event => event.kind === 'caller' && event.id === 'SurfaceSwitch').map(event => event.facts!.onCloseIdentity) }
    },
    proveCollected: () => {
      expect(events.length, '真实 observation 集合非空').toBeGreaterThan(0)
      expect(events.filter(event => event.kind === 'render' && event.id === 'SettingsPanel').length).toBeGreaterThan(0)
      expect(events.filter(event => event.kind === 'commit' && event.id === 'SettingsPanel').length).toBeGreaterThan(0)
      expect(events.filter(event => event.kind === 'render' && event.id === 'HostConnectionFields').length).toBeGreaterThan(0)
    }
  }
}

export function report(name: string, facts: Record<string, unknown>) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, `${name}.json`), JSON.stringify({ schema: 'agentmux.settings-parent-cost-observation.v1',
    mode, producer: 'actual App / development React / happy-dom / real Store', noStrictMode: true,
    liveUserPerformanceClaimed: false, ...facts }, null, 2) + '\n')
}

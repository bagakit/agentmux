import { randomUUID } from 'node:crypto'
import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import type { AgentMuxAppearanceObservation, AgentMuxAppearanceObservationPort, AgentMuxControlSettingsResourceFields } from '@agentmux/core'
import { AgentMuxError } from '@agentmux/core'
import type { AppConfig } from '../shared/contracts.js'
import { terminalPalette } from '../shared/terminal-palettes.js'
import { configValuesEqual } from '../shared/config-edit.js'
import type { ConfigOwner } from './config-owner.js'

function projection(config: AppConfig) {
  const requested = config.appearance.themeId ?? DEFAULT_THEME_ID
  const custom = config.appearance.customThemes ?? {}
  const catalog = getThemeCatalog(Object.hasOwn(custom, requested) ? { [requested]: custom[requested] } : {})
  const selected = catalog.items.find(item => item.id === requested) ?? catalog.items[0]!
  return {
    values: { themeId: selected.id, appAppearance: config.appearance.appAppearance ?? 'dark', theme: selected.value,
      terminalTheme: config.appearance.terminalTheme,
      ...(config.appearance.terminalTheme === 'workspace' ? {} : { terminalPalette: terminalPalette(config.appearance.terminalTheme) }) } as AgentMuxControlSettingsResourceFields,
    issues: [...catalog.issues.filter(issue => issue.id === requested), ...(selected.id === requested ? [] : [
      { id: requested, message: 'Selected theme is unavailable. Graphite remains usable; choose or import a valid theme in Appearance.' }
    ])]
  }
}
function relevantChanged(next: AppConfig, previous: AppConfig): boolean {
  const a = next.appearance, b = previous.appearance
  if (a.themeId !== b.themeId || a.appAppearance !== b.appAppearance || a.terminalTheme !== b.terminalTheme) return true
  const id = a.themeId ?? DEFAULT_THEME_ID
  return !configValuesEqual(a.customThemes?.[id], b.customThemes?.[id])
}

/** Per-reader derived snapshots, not another config truth or a durable event log. */
export function themeObservation(owner: ConfigOwner): AgentMuxAppearanceObservationPort {
  return { subscribe: async (onSnapshot, onEnd, signal) => {
    let closed = false, started = false, delivering = false, revision = 0
    const sourceId = randomUUID()
    let release: (() => void) | undefined, latest: AgentMuxAppearanceObservation | undefined
    const dispose = () => { if (closed) return; closed = true; latest = undefined; release?.(); signal.removeEventListener('abort', dispose) }
    const pump = async () => {
      if (closed || !started || delivering) return
      delivering = true
      try { while (!closed && latest) { const snapshot = latest; latest = undefined; await onSnapshot(snapshot) } }
      catch (cause) {
        dispose()
        try { await onEnd(cause instanceof Error ? cause : new Error('Appearance observation could not be delivered. Reopen this reader; saved themes are preserved.')) }
        catch (error) { console.warn('Appearance reader end feedback failed; its lease is already released.', error) }
      }
      finally { delivering = false }
    }
    signal.addEventListener('abort', dispose, { once: true })
    try {
      const initial = await owner.inspect(config => {
        if (signal.aborted || closed) throw new AgentMuxError('Appearance reader was cancelled; saved themes and healthy Runs are preserved.', 'CONTROL_CANCELLED')
        release = owner.subscribe((saved, previous) => {
          if (closed || !relevantChanged(saved, previous)) return
          latest = { sourceId, revision: ++revision, ...projection(saved) }
          void pump()
        })
        return { sourceId, revision, ...projection(config) } as AgentMuxAppearanceObservation
      })
      if (signal.aborted || closed) throw new AgentMuxError('Appearance reader was cancelled.', 'CONTROL_CANCELLED')
      return { initial, start: () => { started = true; return pump() }, dispose }
    } catch (error) { dispose(); throw error }
  } }
}

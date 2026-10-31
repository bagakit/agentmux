import { mintObjectId } from '@agentmux/core/object-id'
import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import type { AgentMuxAppearanceObservation, AgentMuxAppearanceObservationPort, AgentMuxControlSettingsResourceFields } from '@agentmux/core'
import { AgentMuxError } from '@agentmux/core'
import type { AppAppearanceId, TerminalThemeId } from '@agentmux/client-ui/theme'
import { terminalPalette } from '@agentmux/client-ui/theme'
import { DEFAULT_APP_ICON, isAppIconId } from '@agentmux/client-ui/app-icon-catalog'
import { isDeepStrictEqual } from 'node:util'
/** A brand choice may be newer than this client; it must not invalidate the independently readable theme. */
export type ThemeConfiguration = { appearance: { themeId?: string; appAppearance?: AppAppearanceId; terminalTheme: TerminalThemeId; customThemes?: Record<string, unknown>; appIcon?: unknown } }
export type ThemeConfigurationReader = {
  inspect<T>(capture: (current: ThemeConfiguration) => T): Promise<T>
  subscribe(listener: (saved: ThemeConfiguration, previous: ThemeConfiguration) => void, onFailure?: (error: Error) => void): () => void
}

function projection(config: ThemeConfiguration) {
  const requested = config.appearance.themeId ?? DEFAULT_THEME_ID
  const custom = config.appearance.customThemes ?? {}
  const catalog = getThemeCatalog(Object.hasOwn(custom, requested) ? { [requested]: custom[requested] } : {})
  const selected = catalog.items.find(item => item.id === requested) ?? catalog.items[0]!
  const appIcon = config.appearance.appIcon
  return {
    values: { themeId: selected.id, appAppearance: config.appearance.appAppearance ?? 'dark', theme: selected.value,
      // Keep unsupported string identities. Other malformed JSON becomes an explicit unsupported value, not a replacement default.
      appIcon: appIcon === undefined ? DEFAULT_APP_ICON : typeof appIcon === 'string' ? appIcon : null,
      terminalTheme: config.appearance.terminalTheme,
      ...(config.appearance.terminalTheme === 'workspace' ? {} : { terminalPalette: terminalPalette(config.appearance.terminalTheme) }) } as AgentMuxControlSettingsResourceFields,
    issues: [...catalog.issues.filter(issue => issue.id === requested), ...(appIcon === undefined || isAppIconId(appIcon) ? [] : [
      { id: 'app-icon', message: 'The selected App icon is unsupported. Clients retain their last confirmed brand; choose an App icon in Appearance.' }
    ]), ...(selected.id === requested ? [] : [
      { id: requested, message: 'Selected theme is unavailable. Graphite remains usable; choose or import a valid theme in Appearance.' }
    ])]
  }
}
function relevantChanged(next: ThemeConfiguration, previous: ThemeConfiguration): boolean {
  const a = next.appearance, b = previous.appearance
  if (a.themeId !== b.themeId || a.appAppearance !== b.appAppearance || a.terminalTheme !== b.terminalTheme || !isDeepStrictEqual(a.appIcon, b.appIcon)) return true
  const id = a.themeId ?? DEFAULT_THEME_ID
  return !isDeepStrictEqual(a.customThemes?.[id], b.customThemes?.[id])
}

/** Per-reader derived snapshots, not another config truth or a durable event log. */
export function themeObservation(owner: ThemeConfigurationReader): AgentMuxAppearanceObservationPort {
  return { subscribe: async (onSnapshot, onEnd, signal) => {
    let closed = false, started = false, delivering = false, revision = 0, failed = false
    const sourceId = mintObjectId()
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
        let confirmed = config
        release = owner.subscribe((saved, previous) => {
          confirmed = saved
          if (closed || !failed && !relevantChanged(saved, previous)) return
          failed = false
          latest = { sourceId, revision: ++revision, ...projection(saved) }
          void pump()
        }, error => {
          if (closed) return
          failed = true
          const retained = projection(confirmed)
          latest = { sourceId, revision: ++revision, ...retained, issues: [...retained.issues,
            { id: 'original-appearance-observation', message: error.message }] }
          void pump()
        })
        return { sourceId, revision, ...projection(config) } as AgentMuxAppearanceObservation
      })
      if (signal.aborted || closed) throw new AgentMuxError('Appearance reader was cancelled.', 'CONTROL_CANCELLED')
      return { initial, start: () => { started = true; return pump() }, dispose }
    } catch (error) { dispose(); throw error }
  } }
}

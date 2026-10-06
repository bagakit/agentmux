import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { resolveTheme, themeCssVariables, serializeThemeFile } from '@agentmux/client-ui/theme'
import { THEME_BOOTSTRAP_CHANNEL, type ThemeBootstrap } from '../shared/theme-bootstrap.js'
import type { AppearanceConfig } from '../shared/contracts.js'

export function themeBootstrap(appearance: AppearanceConfig, prefersDark: boolean): Extract<ThemeBootstrap, { status: 'available' }> {
  const resolved = resolveTheme(appearance, prefersDark)
  const document = { id: resolved.id, ...resolved.value }
  serializeThemeFile(document)
  return { status: 'available', document, appearance: appearance.appAppearance ?? 'dark', mode: resolved.mode, variables: themeCssVariables(resolved) }
}

/** Every synchronous request receives a result. This handler never reads disk or awaits Runtime. */
export function registerThemeBootstrap(ipc: Pick<IpcMain, 'on' | 'removeListener'>, window: Pick<BrowserWindow, 'webContents'>, read: () => AppearanceConfig, prefersDark: () => boolean): () => void {
  const listener = (event: IpcMainEvent) => {
    try {
      if (!event.sender || !event.senderFrame || !Object.is(event.sender, window.webContents) || !Object.is(event.senderFrame, window.webContents.mainFrame)) {
        event.returnValue = { status: 'unavailable', message: 'The initial theme request did not come from this Workbench main frame. Saved preferences are kept.' } satisfies ThemeBootstrap
        return
      }
      event.returnValue = themeBootstrap(read(), prefersDark())
    } catch (cause) {
      event.returnValue = { status: 'unavailable', message: 'The saved theme could not be projected before startup. Your preferences are kept; Appearance can refresh after startup. ' + (cause instanceof Error ? cause.message : String(cause)) } satisfies ThemeBootstrap
    }
  }
  ipc.on(THEME_BOOTSTRAP_CHANNEL, listener)
  return () => { ipc.removeListener(THEME_BOOTSTRAP_CHANNEL, listener) }
}

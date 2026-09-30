import type { BrowserWindow } from 'electron'

// Account and device events share the same native menu surface. The request token
// owns only its presentation; each original request still owns its own lifecycle.
const menus = new WeakMap<BrowserWindow, object>()

export function acquireBrowserWebAuthnWindowMenu(window: BrowserWindow, request: object): boolean {
  const current = menus.get(window)
  if (current && current !== request) return false
  menus.set(window, request)
  return true
}

export function releaseBrowserWebAuthnWindowMenu(window: BrowserWindow, request: object): void {
  if (menus.get(window) === request) menus.delete(window)
}

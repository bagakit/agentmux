import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { resolveAppIcon, type AppIconId } from '@agentmux/client-ui/app-icon-catalog'
import type { ConfigOwner } from './config-owner.js'

/** Packaged resources are derived from the shared source catalog, never from a user path. */
export function appIconPath(choice?: AppIconId): string {
  return join(import.meta.dirname, '../../resources/app-icons', `${resolveAppIcon(choice)}.png`)
}

type NativeIconPorts = {
  platform: NodeJS.Platform
  images: { createFromPath(path: string): NativeImage }
  dock?: { setIcon(image: NativeImage): void } | undefined
  window: { isDestroyed(): boolean; setIcon(image: NativeImage): void }
  reportIssue(issue: string | null): void
}

/** A transient projection of committed configuration; it neither writes config nor owns Agent state. */
export function bindAppBrandIcon(owner: Pick<ConfigOwner, 'current' | 'subscribe'>, ports: NativeIconPorts) {
  let issue: string | null = null
  const apply = (choice?: AppIconId) => {
    issue = null
    try {
      const image = ports.images.createFromPath(appIconPath(choice))
      if (image.isEmpty()) throw new Error('The selected App icon image could not be read.')
      if (ports.platform === 'darwin') {
        if (!ports.dock) throw new Error('The macOS Dock is unavailable.')
        ports.dock.setIcon(image)
      } else if (ports.platform === 'win32' || ports.platform === 'linux') {
        if (ports.window.isDestroyed()) throw new Error('The application window is no longer available.')
        ports.window.setIcon(image)
      }
    } catch (cause) {
      issue = `The system App icon could not be updated. Your App icon choice, workface and Agents are retained. ${cause instanceof Error ? cause.message : String(cause)}`
    }
    try { ports.reportIssue(issue) }
    catch (cause) { console.warn('App icon issue delivery is unconfirmed; the committed choice and healthy Agents remain available.', cause) }
  }
  apply(owner.current.appearance.appIcon)
  const dispose = owner.subscribe((saved, previous) => {
    if (resolveAppIcon(saved.appearance.appIcon) !== resolveAppIcon(previous.appearance.appIcon)) apply(saved.appearance.appIcon)
  })
  return { get issue() { return issue }, dispose }
}

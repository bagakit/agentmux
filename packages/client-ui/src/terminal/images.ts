import { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'

/** Install after open and before the first PTY byte. Terminal owns the addon's lifetime. */
export function activateTerminalImages(terminal: Terminal): void {
  const addon = new ImageAddon({
    kittySupport: true,
    sixelSupport: true,
    iipSupport: false,
    // The decoded canvas pool and each compressed sequence have independent limits.
    pixelLimit: 4 * 1024 * 1024,
    storageLimit: 32,
    sixelSizeLimit: 8 * 1024 * 1024,
    kittySizeLimit: 8 * 1024 * 1024
  })
  try {
    terminal.loadAddon(addon)
  } catch (error) {
    addon.dispose()
    throw error
  }
}

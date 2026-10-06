import type { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'

export const UNICODE_WIDTH_VERSION = '11'

/** All clients choose widths before parsing bytes; changing the table cannot repair existing cells. */
export function activateTerminalUnicodeWidth(terminal: Terminal): string {
  try {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = UNICODE_WIDTH_VERSION
    return terminal.unicode.activeVersion
  } catch (error) {
    // Rendering degradation must not prevent attachment or healthy input.
    console.warn('[terminal] Unicode width table activation failed; keeping the host default', error)
    try { return terminal.unicode.activeVersion } catch { return 'unknown' }
  }
}

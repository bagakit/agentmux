import { join } from 'node:path'
import { app } from 'electron'

/**
 * Agent Session identity (the `nativeHandle` tokens `claude --resume` / `codex resume` need) and the
 * `agent-timelines/` derived from the same root must survive a machine reboot. They belong in Electron
 * userData next to config and browser profiles — never in the ctxmux machine-level runtime directory,
 * which is ephemeral (macOS `/private/tmp` 3-day cleanup, Linux `tmpdir()` cleared on reboot).
 */
export function desktopAgentSessionStorePath(): string {
  return join(app.getPath('userData'), 'agent-sessions.json')
}

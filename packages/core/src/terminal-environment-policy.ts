/** Name of AgentMux's terminal profile. TERM continues to identify its text terminfo. */
export const AGENTMUX_TERMINAL_PROGRAM = 'AgentMux-Kitty'

// These describe the host shell, not a new managed CLI. Nonzero color settings and
// explicit Run-level Agent/CI settings remain authoritative after the baseline merge.
const disabledColorValues: Readonly<Record<string, string | null>> = {
  NO_COLOR: null,
  FORCE_COLOR: '0',
  CLICOLOR: '0'
}
const hostSessionKeys = ['CI', 'CODEX_CI', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'] as const
// These identify the terminal or multiplexer that launched the Host. An AgentMux
// PTY is a separate terminal. Explicit Run overrides are merged after this cleanup.
const hostTerminalKeys = ['TMUX', 'TMUX_PANE', 'STY', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_VERSION',
  'KITTY_WINDOW_ID', 'WEZTERM_EXECUTABLE', 'WEZTERM_VERSION', 'WT_SESSION'] as const
const hostEnvironmentKeys = [...Object.keys(disabledColorValues), ...hostSessionKeys, ...hostTerminalKeys]

export function removeHostColorSignals(environment: Record<string, string | undefined>): void {
  for (const [key, disabledValue] of Object.entries(disabledColorValues)) {
    if (disabledValue === null || environment[key] === disabledValue) delete environment[key]
  }
}

export function removeInheritedHostSignals(environment: Record<string, string | undefined>): void {
  removeHostColorSignals(environment)
  for (const key of hostSessionKeys) delete environment[key]
  for (const key of hostTerminalKeys) delete environment[key]
}

/** RunSpec.env is additive: omitted policy entries must also be removed at exec. */
export function missingHostEnvironmentKeys(environment: Readonly<Record<string, string>>): string[] {
  return hostEnvironmentKeys.filter(key => environment[key] === undefined)
}

/** Native single-value options shared by launch readers; values remain opaque data. */
export const claudeLaunchValueOptions = new Set(['--model', '--permission-mode', '--settings', '--setting-sources', '--system-prompt', '--system-prompt-file', '--append-system-prompt', '--append-system-prompt-file', '--agent', '--agents', '--resume', '-r', '--session-id', '--effort', '--output-format', '--input-format', '--max-turns', '--max-budget-usd', '--add-dir', '--plugin-dir', '--plugin-url'])

/** Native Claude safe-mode environment values; unrelated nonempty values do not enable it. */
export function claudeSafeModeEnvironmentEnabled(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.CLAUDE_CODE_SAFE_MODE ?? '').trim().toLowerCase())
}

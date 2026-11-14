/** Tool result facts selected by the originating Provider. */
export type HookToolOutcome = {
  output?: string
  /** False means no explicit failure was observed, not task success. */
  failed: boolean
}

export const MAX_TOOL_OUTPUT_CHARS = 4_000
const TRUNCATION_MARKER = '\n[output truncated]'

/** Format already-selected content; protocol fields and failure stay with the Provider. */
export function formatHookToolOutput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value)
  if (!text) return undefined
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : text.slice(0, MAX_TOOL_OUTPUT_CHARS) + TRUNCATION_MARKER
}

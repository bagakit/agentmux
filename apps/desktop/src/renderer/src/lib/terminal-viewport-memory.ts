export type TerminalViewportMemory =
  | { kind: 'latest' }
  | { kind: 'line'; line: number }

export type TerminalViewportRestoreTarget =
  | { kind: 'latest' }
  | { kind: 'line'; line: number }

function safeLine(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Records the user's terminal reading intent without retaining an xterm instance or buffer. */
export function rememberTerminalViewport(
  viewportY: number,
  baseY: number
): TerminalViewportMemory {
  const viewport = safeLine(viewportY)
  const base = safeLine(baseY)
  return viewport >= base ? { kind: 'latest' } : { kind: 'line', line: viewport }
}

/** Resolves a remembered line against the current buffer after output or reflow changed its size. */
export function restoreTerminalViewport(
  memory: TerminalViewportMemory,
  baseY: number
): TerminalViewportRestoreTarget {
  if (memory.kind === 'latest') return memory
  return { kind: 'line', line: Math.min(safeLine(memory.line), safeLine(baseY)) }
}

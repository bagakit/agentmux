export type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>

export function isTerminalAppShortcut(
  event: TerminalShortcutEvent,
  key: string,
  isMac: boolean
): boolean {
  if (event.key.toLowerCase() !== key || event.altKey) return false
  return isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && event.shiftKey && !event.metaKey
}

/**
 * xterm can clear its live selection while a context menu takes focus. Keep the
 * last non-empty selection as a copy source so a right-click Copy remains
 * deterministic even after that focus transition.
 */
export function terminalSelectionForCopy(liveSelection: string, rememberedSelection: string): string {
  return liveSelection || rememberedSelection
}

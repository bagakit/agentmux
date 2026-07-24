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

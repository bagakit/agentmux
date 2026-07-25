// The quick switcher's summon gesture, kept pure so it is testable without a window and can be reused
// wherever a keydown is observed. It follows the same platform split as the terminal app shortcuts
// (terminal-shortcuts.ts): mac uses the bare Cmd chord, other platforms add Shift so the bare Ctrl
// chord stays with the shell/readline. Cmd+P / Ctrl+Shift+P is the widely-learned "go to anything".
export function isQuickSwitchShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean {
  if (event.key.toLowerCase() !== 'p' || event.altKey) return false
  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey
}

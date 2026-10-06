import { isImeOwnedKeyboardEvent } from './ime-keyboard-event.js'

export type ComposerShortcutId = 'message-tool.send' | 'message-tool.send-immediately' | 'message-tool.newline'
  | 'message-tool.previous' | 'message-tool.next' | 'message-tool.expand-prompt' | 'message-tool.dismiss-suggestions'

export interface ComposerKeyboardBinding {
  id: ComposerShortcutId
  label: string
  description: string
  keyClass: 'named' | 'arrow'
  chord: { key: string; primary: boolean; shift: boolean; alt: boolean }
  // These input gestures already accept additional modifiers. Keep that behavior while exposing the
  // conventional chord in settings; an inventory must not take away a working input combination.
  allowPrimary?: boolean
  allowAlt?: boolean
}

/** The Composer owns its keys. Clients project this same declaration into their shortcut inventory. */
export const COMPOSER_KEYBOARD_BINDINGS: readonly ComposerKeyboardBinding[] = [
  { id: 'message-tool.send', label: 'Send', description: 'Choose the focused suggestion; otherwise send normally, or queue while the Agent is working.', keyClass: 'named',
    chord: { key: 'enter', primary: false, shift: false, alt: false }, allowAlt: true },
  { id: 'message-tool.send-immediately', label: 'Send immediately', description: 'Steer the current turn while working; start a turn when idle. Does not interrupt.', keyClass: 'named',
    chord: { key: 'enter', primary: true, shift: false, alt: false }, allowAlt: true },
  // This is the maintained editor's default, recorded for discovery. The Composer never handles it;
  // InlineComposer/Tiptap owns newline insertion, so this row is not a configurable editor keymap.
  { id: 'message-tool.newline', label: 'Insert a new line', description: 'Continue editing without sending.', keyClass: 'named',
    chord: { key: 'enter', primary: false, shift: true, alt: false }, allowPrimary: true, allowAlt: true },
  { id: 'message-tool.previous', label: 'Previous suggestion or older message', description: 'Navigate suggestions first; otherwise recall this Agent’s history from the first line, or continue browsing.', keyClass: 'arrow',
    chord: { key: 'arrowup', primary: false, shift: false, alt: false } },
  { id: 'message-tool.next', label: 'Next suggestion or newer message', description: 'Navigate suggestions first; otherwise recall newer history or restore your draft from the last line, or continue browsing.', keyClass: 'arrow',
    chord: { key: 'arrowdown', primary: false, shift: false, alt: false } },
  { id: 'message-tool.expand-prompt', label: 'Expand a Prompt keyword', description: 'Expand the keyword at the caret; otherwise move focus normally.', keyClass: 'named',
    chord: { key: 'tab', primary: false, shift: false, alt: false }, allowPrimary: true, allowAlt: true },
  { id: 'message-tool.dismiss-suggestions', label: 'Dismiss suggestions', description: 'Close the suggestion list and return focus to the message editor.', keyClass: 'named',
    chord: { key: 'escape', primary: false, shift: false, alt: false } }
]

type ComposerKeyboardEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

/** Cmd and Ctrl express the same immediate-send intent on every client; IME always retains its keys. */
export function matchComposerShortcut(event: ComposerKeyboardEvent): ComposerShortcutId | null {
  if (isImeOwnedKeyboardEvent(event)) return null
  const primary = Boolean(event.metaKey || event.ctrlKey)
  return COMPOSER_KEYBOARD_BINDINGS.find(binding =>
    event.key.toLowerCase() === binding.chord.key &&
    Boolean(event.shiftKey) === binding.chord.shift &&
    (binding.allowPrimary || primary === binding.chord.primary) &&
    (binding.allowAlt || Boolean(event.altKey) === binding.chord.alt)
  )?.id ?? null
}

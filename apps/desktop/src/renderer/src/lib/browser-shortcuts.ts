import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { browserPageShortcut, type BrowserPageShortcutAction } from '../../../shared/browser-page-shortcuts'
import type { ShortcutEvent } from './shortcut-registry'

/** The page action a keydown inside a Browser surface asks for; composing keys and every other chord pass through. */
export function browserShortcutAction(event: ShortcutEvent, isMac: boolean): BrowserPageShortcutAction | null {
  if (isImeOwnedKeyboardEvent(event)) return null
  return browserPageShortcut({ key: event.key, meta: Boolean(event.metaKey), control: Boolean(event.ctrlKey),
    shift: Boolean(event.shiftKey), alt: Boolean(event.altKey) }, isMac)
}

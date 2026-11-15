import type { ShapeOrder } from './drawing-model.js'

type AnnotationKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>

// Stacking shortcuts by bracket; Shift turns forward and backward into front and back, whichever character it types.
const BRACKETS: Readonly<Record<string, 'forward' | 'backward'>> = { ']': 'forward', '}': 'forward', '[': 'backward', '{': 'backward' }
export type ImageAnnotationObjectCommand = 'select-all' | 'duplicate' | 'copy' | 'paste' | 'lock' | ShapeOrder
/** The object command a Command or Control chord names. Command-C stays the screenshot copy, so marks copy and paste with
 * Shift. The host shortcut router can read the same answer, so a focused editor keeps every chord it names. */
export function imageAnnotationObjectCommand(event: AnnotationKey): ImageAnnotationObjectCommand | null {
  if (!event.metaKey && !event.ctrlKey) return null
  const key = event.key.toLowerCase(), bracket = BRACKETS[event.key]
  if (bracket) return event.shiftKey ? bracket === 'forward' ? 'front' : 'back' : bracket
  if (event.shiftKey) return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null
  return key === 'a' ? 'select-all' : key === 'd' ? 'duplicate' : key === 'l' ? 'lock' : null
}

export function imageAnnotationHistoryCommand(event: AnnotationKey): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return null
  return event.shiftKey ? 'redo' : 'undo'
}
